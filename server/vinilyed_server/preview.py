"""Предпрослушивание: одноразовые ссылки и прокси звука.

`<audio src>` не умеет слать заголовок с кодом, поэтому приложение сначала
просит ссылку по коду (POST /v1/previews), а играет уже по ней. В ссылке —
подписанный токен: кто, что и до какого времени; подделать его без
секрета сервера нельзя, а секрет живёт только до перезапуска.

Сам звук идёт через Мак: ссылки YouTube привязаны к IP того, кто их
получил. Range пробрасывается — перемотка работает, как у обычного файла.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from collections.abc import Callable
from typing import Any, Generic, TypeVar

from .engine import Stream

TOKEN_TTL = 30 * 60
# что из ответа YouTube нужно плееру; остальное (куки, трекинг) не пересылаем
PASS_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")

T = TypeVar("T")


class TtlCache(Generic[T]):
    """Маленький кеш с временем жизни и вытеснением самых старых."""

    def __init__(self, ttl: float, size: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.ttl, self.size, self.clock = ttl, size, clock
        self._items: OrderedDict[Any, tuple[float, T]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Any) -> T | None:
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return None
            if self.clock() - item[0] > self.ttl:
                del self._items[key]
                return None
            self._items.move_to_end(key)
            return item[1]

    def put(self, key: Any, value: T) -> None:
        with self._lock:
            self._items[key] = (self.clock(), value)
            self._items.move_to_end(key)
            while len(self._items) > self.size:
                self._items.popitem(last=False)

    def drop(self, key: Any) -> None:
        with self._lock:
            self._items.pop(key, None)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class Tokens:
    """Подписанные ссылки: [владелец, источник, id, срок] + HMAC-SHA256."""

    def __init__(self, secret: bytes | None = None, ttl: float = TOKEN_TTL,
                 clock: Callable[[], float] = time.time) -> None:
        self.secret = secret or secrets.token_bytes(32)
        self.ttl = ttl
        self.clock = clock

    def issue(self, owner: str, source: str, item_id: str) -> str:
        payload = _b64(json.dumps([owner, source, item_id, int(self.clock() + self.ttl)]).encode("utf-8"))
        return f"{payload}.{self._sign(payload)}"

    def check(self, token: str) -> tuple[str, str, str] | None:
        payload, _, signature = token.partition(".")
        if not payload or not hmac.compare_digest(signature, self._sign(payload)):
            return None
        try:
            owner, source, item_id, expires = json.loads(_unb64(payload))
        except (ValueError, TypeError):
            return None
        if self.clock() > expires:
            return None
        return owner, source, item_id

    def _sign(self, payload: str) -> str:
        return _b64(hmac.new(self.secret, payload.encode("ascii"), hashlib.sha256).digest()[:18])


class StreamExpiredError(Exception):
    """Ссылка на звук протухла (403/410) — нужна новая."""


def open_stream(stream: Stream, range_header: str | None, timeout: float = 20) -> Any:
    """Открывает звук у источника с тем же Range, что прислал плеер."""
    headers = dict(stream.headers)
    if range_header:
        headers["Range"] = range_header
    request = urllib.request.Request(stream.url, headers=headers)
    try:
        return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310 — адрес дал yt-dlp, не клиент
    except urllib.error.HTTPError as error:
        if error.code in (403, 410):
            raise StreamExpiredError from error
        raise


def pass_headers(upstream: Any, mime: str) -> list[tuple[str, str]]:
    headers = []
    for name in PASS_HEADERS:
        value = upstream.headers.get(name)
        if name == "Content-Type" and (not value or value == "application/octet-stream"):
            value = mime
        if value:
            headers.append((name, value))
    return headers
