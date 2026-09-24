"""Очередь скачиваний: один рабочий поток, состояния, кеш и уборка.

Качаем строго по одному треку: так YouTube не примет домашний IP за
бота, а spotDL не делит свой цикл asyncio между потоками.
"""

from __future__ import annotations

import logging
import queue
import shutil
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .engine import Engine, EngineError

log = logging.getLogger(__name__)

JANITOR_EVERY = 60.0   # с — как часто рабочий поток между заданиями убирает старое


@dataclass
class Job:
    id: str
    track_id: str
    owner: str
    state: str = "queued"          # queued → running → done | error
    progress: float = 0.0
    stage: str = "В очереди"
    error: str | None = None
    path: Path | None = None
    finished_at: float | None = None
    created_at: float = field(default_factory=time.monotonic)

    @property
    def active(self) -> bool:
        return self.state in ("queued", "running")

    def to_json(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "state": self.state,
            "progress": round(self.progress, 3),
            "stage": self.stage,
        }
        if self.error:
            data["error"] = self.error
        if self.state == "done" and self.path and self.path.exists():
            data["file"] = {"name": self.path.name, "size": self.path.stat().st_size}
        return data


class QueueFullError(Exception):
    """Очередь или лимит одного кода заполнены — «попробуйте позже»."""


class JobQueue:
    def __init__(
        self,
        engine: Engine,
        data_dir: Path,
        *,
        ttl: float = 3600,
        per_owner: int = 3,
        limit: int = 20,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.engine = engine
        self.data_dir = data_dir
        self.ttl = ttl
        self.per_owner = per_owner
        self.limit = limit
        self.clock = clock
        self._jobs: dict[str, Job] = {}
        # готовые файлы по id трека: повторная просьба — сразу из кеша
        self._files: dict[str, tuple[Path, float]] = {}
        self._pending: queue.Queue[Job | None] = queue.Queue()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    # ── приём ────────────────────────────────────────────────────
    def submit(self, track_id: str, owner: str) -> Job:
        with self._lock:
            active = [job for job in self._jobs.values() if job.active]
            if len(active) >= self.limit:
                raise QueueFullError("Сервер занят, попробуйте позже")
            if sum(job.owner == owner for job in active) >= self.per_owner:
                raise QueueFullError("Уже качается несколько треков — дождитесь их")

            job = Job(id=uuid.uuid4().hex, track_id=track_id, owner=owner, created_at=self.clock())
            self._jobs[job.id] = job
            if self._take_cached(job):
                return job
        self._pending.put(job)
        return job

    def get(self, job_id: str, owner: str) -> Job | None:
        """Чужие задания не видны: id длинные, но проверка дешевле догадок."""
        job = self._jobs.get(job_id)
        return job if job and job.owner == owner else None

    @property
    def active_count(self) -> int:
        return sum(job.active for job in self._jobs.values())

    # ── рабочий поток ────────────────────────────────────────────
    def start(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._thread = threading.Thread(target=self._work, name="downloads", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._thread:
            self._pending.put(None)
            self._thread.join(timeout=5)

    def _work(self) -> None:
        while True:
            try:
                job = self._pending.get(timeout=JANITOR_EVERY)
            except queue.Empty:
                self.cleanup()
                continue
            if job is None:
                return
            self._run(job)
            self.cleanup()

    def _run(self, job: Job) -> None:
        with self._lock:
            if self._take_cached(job):
                return

        job.state, job.stage, job.progress = "running", "Ищу трек", 0.0

        def progress(value: float, stage: str) -> None:
            # spotDL иногда откатывается на этап назад — наружу только вперёд
            job.progress = max(job.progress, min(value, 0.99))
            job.stage = stage

        out_dir = self.data_dir / job.track_id
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            path = self.engine.download(job.track_id, out_dir, progress)
        except EngineError as error:
            self._fail(job, str(error), out_dir)
            return
        except Exception:  # noqa: BLE001 — задание не должно ронять рабочий поток
            log.exception("Скачивание %s упало", job.track_id)
            self._fail(job, "Внутренняя ошибка сервера", out_dir)
            return
        with self._lock:
            self._files[job.track_id] = (path, self.clock())
            self._finish(job, path)

    def _take_cached(self, job: Job) -> bool:
        """Трек уже скачан — отдаём его и продлеваем ему жизнь. Под замком."""
        cached = self._files.get(job.track_id)
        if not cached or not cached[0].exists():
            return False
        self._files[job.track_id] = (cached[0], self.clock())
        self._finish(job, cached[0])
        return True

    def _finish(self, job: Job, path: Path) -> None:
        job.state, job.stage, job.progress = "done", "Готово", 1.0
        job.path = path
        job.finished_at = self.clock()

    def _fail(self, job: Job, message: str, out_dir: Path) -> None:
        job.state, job.stage, job.error = "error", "Ошибка", message
        job.finished_at = self.clock()
        with self._lock:
            if job.track_id not in self._files:
                shutil.rmtree(out_dir, ignore_errors=True)

    # ── уборка ──────────────────────────────────────────────────
    def cleanup(self) -> None:
        """Файлы и задания старше TTL — прочь: диск Мака не склад."""
        now = self.clock()
        with self._lock:
            for job_id, job in list(self._jobs.items()):
                if job.finished_at is not None and now - job.finished_at > self.ttl:
                    del self._jobs[job_id]
            for track_id, (path, finished_at) in list(self._files.items()):
                if now - finished_at > self.ttl:
                    del self._files[track_id]
                    shutil.rmtree(path.parent, ignore_errors=True)
