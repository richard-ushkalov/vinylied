"""Сервер целиком, но с поддельным движком: spotDL, Spotify и YouTube
здесь не нужны. Настоящий движок проверяет `python -m vinilyed_server check`.

Запуск: python -m unittest discover -s server/tests -t server
"""

from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import unquote

from vinilyed_server.app import App, make_server
from vinilyed_server.config import Config, hash_code
from vinilyed_server.engine import EngineError, SearchResult, parse_search
from vinilyed_server.jobs import JobQueue

ORIGIN = "https://richard-ushkalov.github.io"
TRACK = "4uLU6hMCjMI75M1A2tKUQC"
OTHER = "7GhIk7Il098yCjg4BQjzvb"


class FakeEngine:
    """Качает «файл» по команде теста: release() отпускает загрузку."""

    def __init__(self) -> None:
        self.gate = threading.Event()
        self.at_half = threading.Event()
        self.fail: str | None = None
        self.downloads: list[str] = []

    def version(self) -> str:
        return "fake"

    def search(self, query: str, limit: int) -> list[SearchResult]:
        if query == "boom":
            raise EngineError("Spotify не ответил на поиск")
        return [SearchResult(TRACK, "Группа крови", "Кино", "Группа крови", 285, "https://i.scdn.co/image/x")][:limit]

    def download(self, track_id: str, out_dir: Path, progress) -> Path:
        self.downloads.append(track_id)
        progress(0.5, "Качаю")
        self.at_half.set()
        self.gate.wait(5)
        if self.fail:
            raise EngineError(self.fail)
        path = out_dir / "Кино - Группа крови.m4a"
        path.write_bytes(b"audio" * 100)
        return path

    def release(self) -> None:
        self.gate.set()


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class ServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.config_path = Path(self.tmp.name) / "server.json"
        self.config = Config(port=0, data_dir=str(Path(self.tmp.name) / "data"), search_per_minute=3, jobs_per_code=2)
        self.code = self.config.add_code("mama")
        self.config.save(self.config_path)
        self.engine = FakeEngine()
        self.clock = Clock()
        self.jobs = JobQueue(self.engine, self.config.data_path, ttl=3600, per_owner=2, limit=20, clock=self.clock)
        self.jobs.start()
        self.server = make_server(App(self.config, self.engine, self.jobs, self.config_path))
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.engine.release()
        self.server.shutdown()
        self.server.server_close()
        self.jobs.stop()
        self.tmp.cleanup()

    def request(self, method: str, path: str, body=None, code: str | None = "default", origin: str | None = ORIGIN):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {}
        if code:
            headers["Authorization"] = f"Bearer {self.code if code == 'default' else code}"
        if origin:
            headers["Origin"] = origin
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response, data

    def json(self, method: str, path: str, **kwargs):
        response, data = self.request(method, path, **kwargs)
        return response.status, json.loads(data) if data else None

    def wait_state(self, job_id: str, state: str) -> dict:
        deadline = time.time() + 5
        while time.time() < deadline:
            _, job = self.json("GET", f"/v1/downloads/{job_id}")
            if job["state"] == state:
                return job
            time.sleep(0.02)
        self.fail(f"задание не дошло до {state}")

    # ── доступ ─────────────────────────────────────────────────
    def test_without_code_or_with_wrong_code_is_401(self) -> None:
        status, body = self.json("GET", "/v1/health", code=None)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "unauthorized")
        status, _ = self.json("GET", "/v1/health", code="not-a-code")
        self.assertEqual(status, 401)
        status, body = self.json("GET", "/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["spotdl"], "fake")

    def test_codes_are_stored_as_hashes_and_reloaded_live(self) -> None:
        raw = json.loads(self.config_path.read_text())
        self.assertEqual(raw["codes"], {"mama": hash_code(self.code)})
        self.assertNotIn(self.code, self.config_path.read_text())

        # revoke из командной строки — и сервер сразу перестаёт пускать
        config = Config.load(self.config_path)
        del config.codes["mama"]
        config.save(self.config_path)
        bump = self.config_path.stat().st_mtime + 5
        os.utime(self.config_path, (bump, bump))
        status, _ = self.json("GET", "/v1/health")
        self.assertEqual(status, 401)

    # ── CORS ───────────────────────────────────────────────────
    def test_cors_only_for_known_origin(self) -> None:
        response, _ = self.request("OPTIONS", "/v1/search", code=None)
        self.assertEqual(response.status, 204)
        self.assertEqual(response.getheader("Access-Control-Allow-Origin"), ORIGIN)
        self.assertIn("Authorization", response.getheader("Access-Control-Allow-Headers"))

        response, _ = self.request("GET", "/v1/health", origin="https://evil.example")
        self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))
        # ошибки тоже с CORS — иначе браузер покажет «сеть», а не «код не подошёл»
        response, _ = self.request("GET", "/v1/health", code=None)
        self.assertEqual(response.getheader("Access-Control-Allow-Origin"), ORIGIN)

    # ── поиск ──────────────────────────────────────────────────
    def test_search_and_its_limits(self) -> None:
        status, body = self.json("GET", "/v1/search?q=%D0%BA%D0%B8%D0%BD%D0%BE")
        self.assertEqual(status, 200)
        self.assertEqual(body["results"][0]["artist"], "Кино")
        self.assertEqual(self.json("GET", "/v1/search?q=")[0], 400)
        self.assertEqual(self.json("GET", "/v1/search?q=boom")[0], 502)
        # search_per_minute=3: три уже потрачены (пустой запрос не считается)
        self.assertEqual(self.json("GET", "/v1/search?q=a")[0], 200)
        status, body = self.json("GET", "/v1/search?q=a")
        self.assertEqual(status, 429)
        self.assertEqual(body["error"], "busy")

    def test_parse_search_takes_both_backends(self) -> None:
        raw = {"tracks": {"items": [
            {"id": TRACK, "name": "Кукушка", "duration_ms": 401_000,
             "artists": [{"name": "Кино"}], "album": {"name": "Чёрный альбом", "images": [
                 {"url": "big", "width": 640}, {"url": "mid", "width": 300}, {"url": "small", "width": 64}]}},
            {"track_id": OTHER, "name": "Звезда", "duration_ms": 0, "artists": [], "album": {}},
            {"name": "без id"},
        ]}}
        results = parse_search(raw, 10)
        self.assertEqual([r.id for r in results], [TRACK, OTHER])
        self.assertEqual(results[0].cover, "mid")
        self.assertEqual(results[0].duration, 401)
        self.assertEqual(parse_search(None, 5), [])

    # ── скачивание ─────────────────────────────────────────────
    def test_download_lifecycle_and_file(self) -> None:
        status, job = self.json("POST", "/v1/downloads", body={"id": TRACK})
        self.assertEqual(status, 202)
        self.assertTrue(self.engine.at_half.wait(5))
        _, running = self.json("GET", f"/v1/downloads/{job['id']}")
        self.assertEqual(running["state"], "running")
        self.assertEqual(running["progress"], 0.5)
        self.assertEqual(running["stage"], "Качаю")

        # файл до готовности — 409
        self.assertEqual(self.json("GET", f"/v1/downloads/{job['id']}/file")[0], 409)

        self.engine.release()
        done = self.wait_state(job["id"], "done")
        self.assertEqual(done["progress"], 1)
        self.assertEqual(done["file"], {"name": "Кино - Группа крови.m4a", "size": 500})

        response, data = self.request("GET", f"/v1/downloads/{job['id']}/file")
        self.assertEqual(response.status, 200)
        self.assertEqual(data, b"audio" * 100)
        self.assertEqual(response.getheader("Content-Type"), "audio/mp4")
        self.assertEqual(unquote(response.getheader("X-Filename")), "Кино - Группа крови.m4a")
        self.assertIn("X-Filename", response.getheader("Access-Control-Expose-Headers"))

    def test_engine_error_reaches_the_client(self) -> None:
        self.engine.fail = "трек не нашёлся на YouTube Music"
        self.engine.release()
        _, job = self.json("POST", "/v1/downloads", body={"id": TRACK})
        failed = self.wait_state(job["id"], "error")
        self.assertEqual(failed["error"], "трек не нашёлся на YouTube Music")
        # папка неудачной загрузки не остаётся на диске
        self.assertFalse((self.config.data_path / TRACK).exists())

    def test_only_track_ids_are_accepted(self) -> None:
        for body in ({"id": "../../etc/passwd"}, {"id": "https://open.spotify.com/track/x"}, {}, []):
            self.assertEqual(self.json("POST", "/v1/downloads", body=body)[0], 400, body)
        response, _ = self.request("POST", "/v1/downloads", body={"id": "x" * 2000})
        self.assertEqual(response.status, 413)

    def test_unknown_or_foreign_job_is_404(self) -> None:
        self.assertEqual(self.json("GET", "/v1/downloads/" + "0" * 32)[0], 404)
        _, job = self.json("POST", "/v1/downloads", body={"id": TRACK})
        other = self.config.add_code("friend")
        self.config.save(self.config_path)
        self.assertEqual(self.json("GET", f"/v1/downloads/{job['id']}", code=other)[0], 404)

    def test_per_code_limit(self) -> None:
        self.assertEqual(self.json("POST", "/v1/downloads", body={"id": TRACK})[0], 202)
        self.assertEqual(self.json("POST", "/v1/downloads", body={"id": OTHER})[0], 202)
        status, body = self.json("POST", "/v1/downloads", body={"id": TRACK})
        self.assertEqual(status, 429)
        self.assertIn("дождитесь", body["message"])

    def test_cache_and_cleanup(self) -> None:
        self.engine.release()
        _, first = self.json("POST", "/v1/downloads", body={"id": TRACK})
        self.wait_state(first["id"], "done")
        # тот же трек ещё раз — сразу готов, движок не трогаем
        status, second = self.json("POST", "/v1/downloads", body={"id": TRACK})
        self.assertEqual(status, 202)
        self.assertEqual(second["state"], "done")
        self.assertEqual(self.engine.downloads, [TRACK])

        self.clock.now += 3601
        self.jobs.cleanup()
        self.assertFalse((self.config.data_path / TRACK).exists())
        self.assertEqual(self.json("GET", f"/v1/downloads/{first['id']}")[0], 404)

    def test_unknown_route(self) -> None:
        self.assertEqual(self.json("GET", "/api/songs/search?query=x")[0], 404)


if __name__ == "__main__":
    unittest.main()
