"""Настройки сервера: один JSON-файл, который правится командами CLI.

Коды доступа хранятся только хешами: файл настроек может попасть
в резервную копию или на глаза, а сам код — нет.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from dataclasses import asdict, dataclass, field
from pathlib import Path

DEFAULT_PATH = Path(os.environ.get("VINILYED_CONFIG", "~/.config/vinilyed/server.json")).expanduser()


def hash_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def new_code() -> str:
    """12 символов из [A-Za-z0-9_-] — столько же пускает поле в приложении."""
    return secrets.token_urlsafe(9)


@dataclass
class Config:
    # Слушаем только сам Мак: снаружи к серверу ведёт туннель Cloudflare.
    host: str = "127.0.0.1"
    port: int = 8765
    # Откуда браузеру можно звать сервер (CORS). Второй — локальная разработка.
    origins: list[str] = field(default_factory=lambda: [
        "https://richard-ushkalov.github.io",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
    ])
    # имя → sha256 кода
    codes: dict[str, str] = field(default_factory=dict)
    data_dir: str = "~/Library/Caches/vinilyed-server"
    # m4a без перекодирования: AAC с YouTube Music копируется как есть,
    # его играют и Android, и iPhone. Для mp3 — "mp3" и, например, "192k".
    format: str = "m4a"
    bitrate: str = "disable"
    # сколько секунд скачанный файл ждёт, пока его заберут
    ttl: int = 3600
    search_per_minute: int = 30
    jobs_per_code: int = 3
    queue_limit: int = 20
    # Пусто — spotDL ищет без официального API Spotify. Если начнутся
    # отказы или лимиты, впишите ключи своего приложения Spotify.
    spotify_client_id: str = ""
    spotify_client_secret: str = ""

    @property
    def data_path(self) -> Path:
        return Path(self.data_dir).expanduser()

    def owner_of(self, code: str) -> str | None:
        """Чей это код. Сравнение за постоянное время — по нему не подобрать код."""
        digest = hash_code(code)
        owner = None
        for name, stored in self.codes.items():
            if secrets.compare_digest(digest, stored):
                owner = name
        return owner

    def add_code(self, name: str) -> str:
        code = new_code()
        self.codes[name] = hash_code(code)
        return code

    @classmethod
    def load(cls, path: Path = DEFAULT_PATH) -> Config:
        if not path.exists():
            return cls()
        raw = json.loads(path.read_text(encoding="utf-8"))
        known = {key: value for key, value in raw.items() if key in cls.__dataclass_fields__}
        return cls(**known)

    def save(self, path: Path = DEFAULT_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        # в файле хеши кодов и, возможно, ключи Spotify — только владельцу
        path.chmod(0o600)
