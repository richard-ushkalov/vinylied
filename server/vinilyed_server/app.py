"""HTTP-сервер: маршруты, код доступа, CORS, лимиты.

Стандартная библиотека, без фреймворков: пять маршрутов не стоят
лишних зависимостей, а ThreadingHTTPServer держит пару своих людей
с запасом. Снаружи сервер закрыт туннелем Cloudflare и кодом доступа.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import deque
from collections.abc import Callable
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from . import __version__
from .config import Config
from .engine import Engine, EngineError
from .jobs import JobQueue, QueueFullError

log = logging.getLogger(__name__)

MAX_BODY = 1024
TRACK_ID = re.compile(r"^[A-Za-z0-9]{22}$")
JOB_ID = r"(?P<job>[0-9a-f]{32})"
MIME = {
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
}


class HttpError(Exception):
    def __init__(self, status: HTTPStatus, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class RateLimit:
    """Скользящее окно в минуту на каждый код."""

    def __init__(self, per_minute: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.per_minute = per_minute
        self.clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, owner: str) -> bool:
        now = self.clock()
        with self._lock:
            hits = self._hits.setdefault(owner, deque())
            while hits and now - hits[0] > 60:
                hits.popleft()
            if len(hits) >= self.per_minute:
                return False
            hits.append(now)
            return True


class App:
    """Всё состояние сервера; обработчик запросов только читает его."""

    def __init__(self, config: Config, engine: Engine, jobs: JobQueue, config_path: Path | None = None) -> None:
        self.config = config
        self.engine = engine
        self.jobs = jobs
        self.config_path = config_path
        self._config_mtime = self._mtime()
        self.searches = RateLimit(config.search_per_minute)
        self.routes: list[tuple[str, re.Pattern[str], Callable[..., None]]] = [
            ("GET", re.compile(r"^/v1/health$"), self.health),
            ("GET", re.compile(r"^/v1/search$"), self.search),
            ("POST", re.compile(r"^/v1/downloads$"), self.start_download),
            ("GET", re.compile(rf"^/v1/downloads/{JOB_ID}$"), self.job),
            ("GET", re.compile(rf"^/v1/downloads/{JOB_ID}/file$"), self.file),
        ]

    def _mtime(self) -> float | None:
        try:
            return self.config_path.stat().st_mtime if self.config_path else None
        except OSError:
            return None

    def owner_of(self, code: str) -> str | None:
        """Коды перечитываются, когда файл настроек поменялся: add-code
        и revoke действуют сразу, без перезапуска сервера."""
        mtime = self._mtime()
        if mtime != self._config_mtime and self.config_path:
            self._config_mtime = mtime
            self.config.codes = Config.load(self.config_path).codes
        return self.config.owner_of(code)

    # ── маршруты ────────────────────────────────────────────────
    def health(self, request: Handler, owner: str) -> None:
        request.send_json({
            "ok": True,
            "version": __version__,
            "spotdl": self.engine.version(),
            "active": self.jobs.active_count,
        })

    def search(self, request: Handler, owner: str) -> None:
        query = request.query.get("q", [""])[0].strip()
        if not 1 <= len(query) <= 100:
            raise HttpError(HTTPStatus.BAD_REQUEST, "bad_request", "Пустой или слишком длинный запрос")
        try:
            limit = min(max(int(request.query.get("limit", ["8"])[0]), 1), 10)
        except ValueError:
            limit = 8
        if not self.searches.allow(owner):
            raise HttpError(HTTPStatus.TOO_MANY_REQUESTS, "busy", "Слишком много поисков, подождите минуту")
        try:
            results = self.engine.search(query, limit)
        except EngineError as error:
            raise HttpError(HTTPStatus.BAD_GATEWAY, "engine", str(error)) from error
        request.send_json({"results": [result.to_json() for result in results]})

    def start_download(self, request: Handler, owner: str) -> None:
        body = request.read_json()
        track_id = body.get("id") if isinstance(body, dict) else None
        # только id трека: ни адресов, ни путей сервер от клиента не берёт
        if not isinstance(track_id, str) or not TRACK_ID.match(track_id):
            raise HttpError(HTTPStatus.BAD_REQUEST, "bad_request", "Нужен id трека Spotify")
        try:
            job = self.jobs.submit(track_id, owner)
        except QueueFullError as error:
            raise HttpError(HTTPStatus.TOO_MANY_REQUESTS, "busy", str(error)) from error
        request.send_json(job.to_json(), status=HTTPStatus.ACCEPTED)

    def job(self, request: Handler, owner: str, job: str) -> None:
        request.send_json(self._job(job, owner).to_json())

    def file(self, request: Handler, owner: str, job: str) -> None:
        found = self._job(job, owner)
        if found.state != "done" or not found.path or not found.path.exists():
            raise HttpError(HTTPStatus.CONFLICT, "not_ready", "Файл ещё не готов или уже удалён")
        request.send_file(found.path, MIME.get(found.path.suffix.lower(), "application/octet-stream"))

    def _job(self, job_id: str, owner: str):
        found = self.jobs.get(job_id, owner)
        if not found:
            raise HttpError(HTTPStatus.NOT_FOUND, "not_found", "Нет такой загрузки")
        return found


class Handler(BaseHTTPRequestHandler):
    app: App
    server_version = "vinilyed"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    query: dict[str, list[str]]

    # ── CORS ────────────────────────────────────────────────────
    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin in self.app.config.origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Expose-Headers", "X-Filename, Content-Length")
        self.send_header("Vary", "Origin")

    def do_OPTIONS(self) -> None:  # noqa: N802 — имя задаёт http.server
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        url = urlsplit(self.path)
        self.query = parse_qs(url.query)
        try:
            for route_method, pattern, handler in self.app.routes:
                match = pattern.match(url.path)
                if match and route_method == method:
                    handler(self, self._owner(), **match.groupdict())
                    return
            raise HttpError(HTTPStatus.NOT_FOUND, "not_found", "Нет такого адреса")
        except HttpError as error:
            # тело запроса могло остаться непрочитанным — соединение не переиспользуем
            self.close_connection = True
            self.send_json({"error": error.code, "message": error.message}, status=error.status)
        except (BrokenPipeError, ConnectionResetError):
            pass    # приложение закрыли посреди ответа — его право
        except Exception:  # noqa: BLE001
            log.exception("Сбой на %s %s", method, url.path)
            self.close_connection = True
            self.send_json({"error": "internal", "message": "Внутренняя ошибка сервера"},
                           status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def _owner(self) -> str:
        header = self.headers.get("Authorization", "")
        code = header[7:].strip() if header.startswith("Bearer ") else ""
        owner = self.app.owner_of(code) if code else None
        if not owner:
            raise HttpError(HTTPStatus.UNAUTHORIZED, "unauthorized", "Код доступа не подошёл")
        return owner

    # ── ответы ──────────────────────────────────────────────────
    def read_json(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise HttpError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "bad_request", "Слишком большой запрос")
        try:
            return json.loads(self.rfile.read(length) or b"null")
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise HttpError(HTTPStatus.BAD_REQUEST, "bad_request", "Запрос — не JSON") from error

    def send_json(self, data: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, content_type: str) -> None:
        size = path.stat().st_size
        self.send_response(HTTPStatus.OK)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        # имя — отдельным заголовком: Content-Disposition в браузере не прочитать без плясок
        self.send_header("X-Filename", quote(path.name))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with path.open("rb") as source:
            while chunk := source.read(64 * 1024):
                self.wfile.write(chunk)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 — сигнатура http.server
        # коротко и без заголовков: в них код доступа
        log.info("%s %s", self.address_string(), format % args)


def make_server(app: App) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"app": app})
    server = ThreadingHTTPServer((app.config.host, app.config.port), handler)
    server.daemon_threads = True
    return server
