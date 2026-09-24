"""Движок скачивания — spotDL как библиотека.

spotDL импортируется лениво: тестам и CI он не нужен, а на Маке
сервер стартует и без него, чтобы честно ответить «движок не готов».

Про потоки. У Downloader свой цикл asyncio, и `download_song` крутит его
через `run_until_complete`, поэтому скачивания идут строго из одного
рабочего потока (его держит JobQueue). Поиск — лёгкий HTTP-запрос
к Spotify: он идёт из потоков запросов, по одному за раз, чтобы не
ждать за скачиванием, которое может длиться минуту.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

from .config import Config

log = logging.getLogger(__name__)

TRACK_URL = "https://open.spotify.com/track/{}"

Progress = Callable[[float, str], None]


class EngineError(Exception):
    """Сервис ответил отказом или не ответил: сообщение показываем пользователю."""


@dataclass
class SearchResult:
    id: str
    title: str
    artist: str
    album: str
    duration: int
    cover: str | None

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


class Engine(Protocol):
    def version(self) -> str | None: ...
    def search(self, query: str, limit: int) -> list[SearchResult]: ...
    def download(self, track_id: str, out_dir: Path, progress: Progress) -> Path: ...


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
            title=item["name"],
            artist=", ".join(artist.get("name", "") for artist in item.get("artists") or [] if artist.get("name")),
            album=album.get("name") or "",
            duration=round((item.get("duration_ms") or 0) / 1000),
            cover=pick_cover(album.get("images")),
        ))
        if len(results) >= limit:
            break
    return results


class SpotdlEngine:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._init_lock = threading.Lock()
        self._search_lock = threading.Lock()
        self._client_ready = False
        self._downloader: Any = None

    def version(self) -> str | None:
        try:
            from spotdl import __version__
        except ImportError:
            return None
        return __version__

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

    def search(self, query: str, limit: int) -> list[SearchResult]:
        self._ensure_client()
        from spotdl.utils.spotify import SpotifyClient

        with self._search_lock:
            try:
                raw = SpotifyClient().search(query, type="track", limit=max(limit, 10))
            except Exception as error:  # noqa: BLE001 — любой отказ Spotify — это «не вышло»
                log.warning("Поиск не удался: %s", error)
                raise EngineError("Spotify не ответил на поиск") from error
        return parse_search(raw, limit)

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

    def download(self, track_id: str, out_dir: Path, progress: Progress) -> Path:
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
            song = Song.from_url(TRACK_URL.format(track_id))
        except Exception as error:  # noqa: BLE001
            raise EngineError("Spotify не отдал данные трека") from error

        _, path = downloader.download_song(song)
        if path is None or not Path(path).exists():
            reason = downloader.errors[-1] if downloader.errors else "трек не нашёлся на YouTube Music"
            raise EngineError(f"Не удалось скачать: {reason}")
        return Path(path)
