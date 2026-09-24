"""Движок: поиск, скачивание и потоки для предпрослушивания.

Два источника:
  spotify — поиск в Spotify, скачивание через spotDL (звук с YouTube Music,
            теги и обложка — из Spotify);
  youtube — поиск роликов и скачивание звука через yt-dlp (его ставит
            spotDL); названия и обложку потом доводит приложение, по звуку.

Всё импортируется лениво: тестам и CI библиотеки не нужны, а на Маке
сервер стартует и без них, чтобы честно ответить «движок не готов».

Про потоки. У Downloader spotDL свой цикл asyncio, и `download_song`
крутит его через `run_until_complete`, поэтому скачивания идут строго из
одного рабочего потока (его держит JobQueue). Поиск и потоки — обычные
HTTP-запросы; очередь поисков ведёт App.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, urlsplit

from .config import Config

log = logging.getLogger(__name__)

SPOTIFY_URL = "https://open.spotify.com/track/{}"
YOUTUBE_URL = "https://www.youtube.com/watch?v={}"
YOUTUBE_COVER = "https://i.ytimg.com/vi/{}/hqdefault.jpg"

SOURCES = ("spotify", "youtube")
# Сервер берёт от клиента только id — ни адресов, ни путей.
IDS = {
    "spotify": re.compile(r"^[A-Za-z0-9]{22}$"),
    "youtube": re.compile(r"^[A-Za-z0-9_-]{11}$"),
}

# Общие опции yt-dlp: молча, без полос прогресса в журнал.
YDL_QUIET = {"quiet": True, "no_warnings": True, "noprogress": True}
AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio"
# Для Spotify ищем пару на YouTube Music: насколько может разойтись длительность.
MATCH_TOLERANCE = 7

Progress = Callable[[float, str], None]


class EngineError(Exception):
    """Сервис ответил отказом или не ответил: сообщение показываем пользователю."""


@dataclass
class SearchResult:
    id: str
    source: str
    title: str
    artist: str
    album: str
    duration: int
    cover: str | None

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Stream:
    """Прямая ссылка на звук — живёт несколько часов и привязана к IP Мака."""
    url: str
    mime: str
    headers: dict[str, str] = field(default_factory=dict)
    expires: float = 0.0


class Engine(Protocol):
    def version(self) -> str | None: ...
    def search(self, source: str, query: str, limit: int) -> list[SearchResult]: ...
    def download(self, source: str, item_id: str, out_dir: Path, progress: Progress) -> Path: ...
    def stream(self, source: str, item_id: str) -> Stream: ...


# Этапы spotDL — по-русски, для строки состояния в приложении.
STAGES = {
    "Getting lyrics": "Ищу трек",
    "Searching for song": "Ищу трек",
    "Getting audio meta": "Ищу трек",
    "Downloading": "Качаю",
    "Converting": "Конвертирую",
    "Embedding metadata": "Записываю теги",
    "Done": "Готово",
    "Skipped": "Готово",
}


def pick_cover(images: list[dict[str, Any]] | None) -> str | None:
    """Обложка для списка: самая маленькая, но не меньше 200px — список мелкий."""
    usable = [image for image in images or [] if image.get("url")]
    if not usable:
        return None
    usable.sort(key=lambda image: image.get("width") or 0)
    for image in usable:
        if (image.get("width") or 0) >= 200:
            return image["url"]
    return usable[-1]["url"]


def parse_search(raw: dict[str, Any] | None, limit: int) -> list[SearchResult]:
    """Ответ поиска Spotify (и официальный, и SpotipyFree — одной формы)."""
    items = ((raw or {}).get("tracks") or {}).get("items") or []
    results = []
    for item in items:
        track_id = item.get("id") or item.get("track_id")
        if not track_id or not item.get("name"):
            continue
        album = item.get("album") or {}
        results.append(SearchResult(
            id=track_id,
            source="spotify",
            title=item["name"],
            artist=", ".join(artist.get("name", "") for artist in item.get("artists") or [] if artist.get("name")),
            album=album.get("name") or "",
            duration=round((item.get("duration_ms") or 0) / 1000),
            cover=pick_cover(album.get("images")),
        ))
        if len(results) >= limit:
            break
    return results


def parse_youtube(info: dict[str, Any] | None, limit: int) -> list[SearchResult]:
    """Плоский ответ `ytsearchN:` — только ролики, без каналов, плейлистов и эфиров."""
    results = []
    for entry in (info or {}).get("entries") or []:
        video_id = entry.get("id") or ""
        if not IDS["youtube"].match(video_id) or not entry.get("title"):
            continue
        if entry.get("live_status") in ("is_live", "is_upcoming"):
            continue
        results.append(SearchResult(
            id=video_id,
            source="youtube",
            title=entry["title"],
            artist=entry.get("channel") or entry.get("uploader") or "",
            album="",
            duration=round(entry.get("duration") or 0),
            cover=YOUTUBE_COVER.format(video_id),
        ))
        if len(results) >= limit:
            break
    return results


def pick_match(items: list[dict[str, Any]], duration: int) -> str | None:
    """Пара для трека Spotify на YouTube Music: ближайшая по длительности."""
    candidates = [item for item in items if item.get("videoId")]
    if not candidates:
        return None
    if duration:
        close = [item for item in candidates
                 if abs((item.get("duration_seconds") or 0) - duration) <= MATCH_TOLERANCE]
        if close:
            candidates = close
        candidates.sort(key=lambda item: abs((item.get("duration_seconds") or 0) - duration))
    return candidates[0]["videoId"]


def stream_expiry(url: str) -> float:
    """Когда протухнет ссылка googlevideo (параметр expire); без него — через час."""
    try:
        return float(parse_qs(urlsplit(url).query)["expire"][0])
    except (KeyError, ValueError, IndexError):
        return time.time() + 3600


def youtube_download_options(out_dir: Path, hook: Callable[[dict[str, Any]], None],
                             pp_hook: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    """Звук ролика в m4a (AAC копируется без перекодирования), превью — обложкой."""
    return {
        **YDL_QUIET,
        "format": AUDIO_FORMAT,
        "outtmpl": str(out_dir / "%(title).120B.%(ext)s"),
        "writethumbnail": True,
        "progress_hooks": [hook],
        "postprocessor_hooks": [pp_hook],
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "m4a"},
            # превью YouTube — webp, а в m4a вшивается только jpg/png
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
            {"key": "FFmpegMetadata"},
            {"key": "EmbedThumbnail"},
        ],
    }


class SpotdlEngine:
    """Настоящий движок: spotDL, yt-dlp и ytmusicapi (все три ставит spotDL)."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self._init_lock = threading.Lock()
        self._client_ready = False
        self._downloader: Any = None
        # последние найденные треки Spotify: для предпрослушивания нужны
        # название и длительность, а клиент присылает только id
        self._seen: dict[str, SearchResult] = {}

    def version(self) -> str | None:
        try:
            from spotdl import __version__
        except ImportError:
            return None
        return __version__

    # ── поиск ───────────────────────────────────────────────────
    def search(self, source: str, query: str, limit: int) -> list[SearchResult]:
        if source == "youtube":
            return self._search_youtube(query, limit)
        return self._search_spotify(query, limit)

    def _search_spotify(self, query: str, limit: int) -> list[SearchResult]:
        self._ensure_client()
        from spotdl.utils.spotify import SpotifyClient

        try:
            raw = SpotifyClient().search(query, type="track", limit=max(limit, 10))
        except Exception as error:  # noqa: BLE001 — любой отказ Spotify — это «не вышло»
            log.warning("Поиск в Spotify не удался: %s", error)
            raise EngineError("Spotify не ответил на поиск") from error
        results = parse_search(raw, limit)
        for result in results:
            self._seen[result.id] = result
        while len(self._seen) > 1000:
            self._seen.pop(next(iter(self._seen)))
        return results

    def _search_youtube(self, query: str, limit: int) -> list[SearchResult]:
        yt_dlp = self._yt_dlp()
        try:
            with yt_dlp.YoutubeDL({**YDL_QUIET, "extract_flat": "in_playlist"}) as ydl:
                info = ydl.extract_info(f"ytsearch{limit + 4}:{query}", download=False)
        except Exception as error:  # noqa: BLE001
            log.warning("Поиск на YouTube не удался: %s", error)
            raise EngineError("YouTube не ответил на поиск") from error
        return parse_youtube(info, limit)

    # ── скачивание ──────────────────────────────────────────────
    def download(self, source: str, item_id: str, out_dir: Path, progress: Progress) -> Path:
        if source == "youtube":
            return self._download_youtube(item_id, out_dir, progress)
        return self._download_spotify(item_id, out_dir, progress)

    def _download_spotify(self, track_id: str, out_dir: Path, progress: Progress) -> Path:
        downloader = self._ensure_downloader()
        from spotdl.download.progress_handler import ProgressHandler
        from spotdl.types.song import Song

        def on_update(tracker: Any, message: str) -> None:
            progress(min(max(tracker.progress / 100, 0.0), 1.0), STAGES.get(message, message))

        # web_ui=True — чтобы spotDL считал проценты по байтам, а не прыгал
        # сразу к 70%; simple_tui — чтобы не рисовал полосы в терминал.
        downloader.progress_handler = ProgressHandler(simple_tui=True, update_callback=on_update, web_ui=True)
        downloader.settings["output"] = str(out_dir / "{artists} - {title}.{output-ext}")
        downloader.errors.clear()

        progress(0.02, "Ищу трек")
        try:
            song = Song.from_url(SPOTIFY_URL.format(track_id))
        except Exception as error:  # noqa: BLE001
            raise EngineError("Spotify не отдал данные трека") from error

        _, path = downloader.download_song(song)
        if path is None or not Path(path).exists():
            reason = downloader.errors[-1] if downloader.errors else "трек не нашёлся на YouTube Music"
            raise EngineError(f"Не удалось скачать: {reason}")
        return Path(path)

    def _download_youtube(self, video_id: str, out_dir: Path, progress: Progress) -> Path:
        yt_dlp = self._yt_dlp()

        def hook(data: dict[str, Any]) -> None:
            if data.get("status") == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate")
                if total:
                    progress(0.05 + 0.83 * (data.get("downloaded_bytes") or 0) / total, "Качаю")
            elif data.get("status") == "finished":
                progress(0.9, "Конвертирую")

        def pp_hook(data: dict[str, Any]) -> None:
            if data.get("status") == "started" and data.get("postprocessor") in ("FFmpegMetadata", "EmbedThumbnail"):
                progress(0.95, "Записываю теги")

        progress(0.02, "Ищу ролик")
        try:
            with yt_dlp.YoutubeDL(youtube_download_options(out_dir, hook, pp_hook)) as ydl:
                ydl.download([YOUTUBE_URL.format(video_id)])
        except yt_dlp.utils.DownloadError as error:
            raise EngineError(f"YouTube не отдал ролик: {_short(error)}") from error
        files = sorted(out_dir.glob("*.m4a"))
        if not files:
            raise EngineError("Не удалось сохранить звук ролика")
        return files[0]

    # ── потоки для предпрослушивания ────────────────────────────
    def stream(self, source: str, item_id: str) -> Stream:
        video_id = item_id if source == "youtube" else self._youtube_for_spotify(item_id)
        yt_dlp = self._yt_dlp()
        try:
            with yt_dlp.YoutubeDL({**YDL_QUIET, "format": AUDIO_FORMAT}) as ydl:
                info = ydl.extract_info(YOUTUBE_URL.format(video_id), download=False)
        except yt_dlp.utils.DownloadError as error:
            raise EngineError(f"YouTube не отдал звук: {_short(error)}") from error
        url = (info or {}).get("url")
        if not url:
            raise EngineError("YouTube не отдал звук")
        return Stream(
            url=url,
            mime="audio/mp4" if info.get("ext") == "m4a" else "audio/webm",
            headers={key: value for key, value in (info.get("http_headers") or {}).items() if isinstance(value, str)},
            expires=stream_expiry(url),
        )

    def _youtube_for_spotify(self, track_id: str) -> str:
        """Трек Spotify → ролик YouTube Music с тем же звуком (как делает spotDL)."""
        known = self._seen.get(track_id)
        if known:
            title, artist, duration = known.title, known.artist, known.duration
        else:
            self._ensure_client()
            from spotdl.utils.spotify import SpotifyClient

            try:
                raw = SpotifyClient().track(track_id)
            except Exception as error:  # noqa: BLE001
                raise EngineError("Spotify не отдал данные трека") from error
            title = raw.get("name") or ""
            artist = ", ".join(a.get("name", "") for a in raw.get("artists") or [])
            duration = round((raw.get("duration_ms") or 0) / 1000)
        try:
            from ytmusicapi import YTMusic
        except ImportError as error:
            raise EngineError("На сервере не установлен spotDL") from error
        try:
            items = YTMusic().search(f"{artist} {title}".strip(), filter="songs", limit=5)
        except Exception as error:  # noqa: BLE001
            raise EngineError("YouTube Music не ответил") from error
        video_id = pick_match(items, duration)
        if not video_id:
            raise EngineError("Трек не нашёлся на YouTube Music")
        return video_id

    # ── ленивые зависимости ─────────────────────────────────────
    @staticmethod
    def _yt_dlp() -> Any:
        try:
            import yt_dlp
            import yt_dlp.utils
        except ImportError as error:
            raise EngineError("На сервере не установлен spotDL") from error
        return yt_dlp

    def _ensure_client(self) -> None:
        with self._init_lock:
            if self._client_ready:
                return
            try:
                from spotdl.utils.config import SPOTIFY_OPTIONS
                from spotdl.utils.spotify import SpotifyClient
            except ImportError as error:
                raise EngineError("На сервере не установлен spotDL") from error
            if SpotifyClient._instance is not None:    # клиент Spotify в spotDL один на процесс
                self._client_ready = True
                return
            own = bool(self.config.spotify_client_id and self.config.spotify_client_secret)
            SpotifyClient.init(
                client_id=self.config.spotify_client_id or SPOTIFY_OPTIONS["client_id"],
                client_secret=self.config.spotify_client_secret or SPOTIFY_OPTIONS["client_secret"],
                use_official_api=own,
                headless=True,
            )
            self._client_ready = True

    def _ensure_downloader(self) -> Any:
        """Создаётся в рабочем потоке — там же, где потом крутится его цикл."""
        if self._downloader is None:
            self._ensure_client()
            from spotdl.download.downloader import Downloader

            self._downloader = Downloader(settings={
                "format": self.config.format,
                "bitrate": self.config.bitrate,
                "simple_tui": True,
                # тексты песен приложение не показывает, а это ещё три сайта на трек
                "lyrics_providers": [],
                "overwrite": "skip",
                "threads": 1,
            })
        return self._downloader


def _short(error: Exception) -> str:
    """Сообщение yt-dlp без префикса «ERROR: [youtube] id:»."""
    text = str(error).replace("ERROR: ", "")
    return re.sub(r"^\[[^\]]+\] [\w-]+: ", "", text)[:200]
