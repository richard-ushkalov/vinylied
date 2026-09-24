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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

from vinilyed_server.app import App, make_server
from vinilyed_server.config import BUILTIN_ORIGINS, Config, hash_code
from vinilyed_server.engine import EngineError, SearchResult, Stream, parse_search, parse_youtube, pick_match
from vinilyed_server.jobs import JobQueue
from vinilyed_server.preview import Tokens

ORIGIN = "https://richard-ushkalov.github.io"
TRACK = "4uLU6hMCjMI75M1A2tKUQC"
OTHER = "7GhIk7Il098yCjg4BQjzvb"
VIDEO = "dQw4w9WgXcQ"
AUDIO = bytes(range(256)) * 4   # 1024 байта «звука»


class FakeEngine:
    """Качает «файл» по команде теста: release() отпускает загрузку."""

    def __init__(self) -> None:
        self.gate = threading.Event()
        self.at_half = threading.Event()
        self.fail: str | None = None
        self.downloads: list[tuple[str, str]] = []
        self.searches: list[tuple[str, str]] = []
        self.search_gate: threading.Event | None = None
        self.search_started = threading.Event()
        self.stream_urls: list[str] = []
        self.stream_calls = 0

    def version(self) -> str:
        return "fake"

    def search(self, source: str, query: str, limit: int) -> list[SearchResult]:
        self.searches.append((source, query))
        self.search_started.set()
        if self.search_gate:
            self.search_gate.wait(5)
        if query == "boom":
            raise EngineError("Spotify не ответил на поиск")
        if source == "youtube":
            return [SearchResult(VIDEO, "youtube", "Кино — Кукушка (live)", "Кино", "", 401, "https://i.ytimg.com/x")]
        return [SearchResult(TRACK, "spotify", "Группа крови", "Кино", "Группа крови", 285, "https://i.scdn.co/x")]

    def download(self, source: str, item_id: str, out_dir: Path, progress) -> Path:
        self.downloads.append((source, item_id))
        progress(0.5, "Качаю")
        self.at_half.set()
        self.gate.wait(5)
        if self.fail:
            raise EngineError(self.fail)
        path = out_dir / ("Кино - Группа крови.m4a" if source == "spotify" else "Кино — Кукушка (live).m4a")
        path.write_bytes(b"audio" * 100)
        return path

    def stream(self, source: str, item_id: str) -> Stream:
        self.stream_calls += 1
        if not self.stream_urls:
            raise EngineError("Трек не нашёлся на YouTube Music")
        url = self.stream_urls[min(self.stream_calls, len(self.stream_urls)) - 1]
        return Stream(url=url, mime="audio/mp4", expires=time.time() + 3600)

    def release(self) -> None:
        self.gate.set()


class Upstream(BaseHTTPRequestHandler):
    """Поддельный googlevideo: /audio с поддержкой Range, /expired — 403."""

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/expired":
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        start, end = 0, len(AUDIO) - 1
        header = self.headers.get("Range")
        if header:
            first, _, last = header.removeprefix("bytes=").partition("-")
            start, end = int(first), int(last) if last else len(AUDIO) - 1
        body = AUDIO[start:end + 1]
        self.send_response(206 if header else 200)
        self.send_header("Content-Type", "audio/mp4")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Set-Cookie", "tracking=1")
        if header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(AUDIO)}")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


class Clock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


class ServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.config_path = Path(self.tmp.name) / "server.json"
        self.config = Config(port=0, data_dir=str(Path(self.tmp.name) / "data"), search_per_minute=3, jobs_per_code=2)
        self.code = self.config.add_code("mama")
        self.friend = self.config.add_code("friend")
        self.config.save(self.config_path)
        self.engine = FakeEngine()
        self.clock = Clock()
        self.token_clock = Clock(time.time())
        self.jobs = JobQueue(self.engine, self.config.data_path, ttl=3600, per_owner=2, limit=20, clock=self.clock)
        self.jobs.start()
        self.app = App(self.config, self.engine, self.jobs, self.config_path, tokens=Tokens(clock=self.token_clock))
        self.server = make_server(self.app)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        self.audio_url = f"http://127.0.0.1:{self.upstream.server_address[1]}/audio"
        self.expired_url = f"http://127.0.0.1:{self.upstream.server_address[1]}/expired"

    def tearDown(self) -> None:
        self.engine.release()
        if self.engine.search_gate:
            self.engine.search_gate.set()
        self.server.shutdown()
        self.server.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.jobs.stop()
        self.tmp.cleanup()

    def request(self, method: str, path: str, body=None, code: str | None = "default",
                origin: str | None = ORIGIN, headers: dict[str, str] | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        sent = dict(headers or {})
        if code:
            sent["Authorization"] = f"Bearer {self.code if code == 'default' else code}"
        if origin:
            sent["Origin"] = origin
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            sent["Content-Type"] = "application/json"
        connection.request(method, path, body=payload, headers=sent)
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

    def in_background(self, method: str, path: str, **kwargs) -> dict:
        """Запрос в отдельном потоке; результат появится в словаре."""
        box: dict = {}
        thread = threading.Thread(target=lambda: box.update(result=self.json(method, path, **kwargs)))
        thread.start()
        box["thread"] = thread
        return box

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
        self.assertEqual(raw["codes"]["mama"], hash_code(self.code))
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

    def test_own_domain_is_allowed_even_with_an_old_config_file(self) -> None:
        # GitHub отдаёт приложение со своего домена, если он есть у аккаунта
        response, _ = self.request("GET", "/v1/health", origin="https://richard-ushkalov.com")
        self.assertEqual(response.getheader("Access-Control-Allow-Origin"), "https://richard-ushkalov.com")

        # файл от прошлой версии: там полный старый список — он лишь дополняет встроенный
        old = Path(self.tmp.name) / "old.json"
        old.write_text(json.dumps({"origins": ["https://richard-ushkalov.github.io", "https://extra.example"]}))
        allowed = Config.load(old).allowed_origins
        self.assertTrue(set(BUILTIN_ORIGINS) <= allowed)
        self.assertIn("https://extra.example", allowed)

    # ── поиск ──────────────────────────────────────────────────
    def test_search_and_its_limits(self) -> None:
        status, body = self.json("GET", "/v1/search?q=%D0%BA%D0%B8%D0%BD%D0%BE")
        self.assertEqual(status, 200)
        self.assertEqual(body["results"][0]["artist"], "Кино")
        self.assertEqual(body["results"][0]["source"], "spotify")
        self.assertEqual(self.json("GET", "/v1/search?q=")[0], 400)
        self.assertEqual(self.json("GET", "/v1/search?q=x&source=vk")[0], 400)
        self.assertEqual(self.json("GET", "/v1/search?q=boom")[0], 502)
        # search_per_minute=3: «кино», «boom» и этот — третий; пустой и кривой не считаются
        self.assertEqual(self.json("GET", "/v1/search?q=new")[0], 200)
        status, body = self.json("GET", "/v1/search?q=newer")
        self.assertEqual(status, 429)
        self.assertEqual(body["error"], "busy")

    def test_repeated_search_comes_from_cache_and_costs_nothing(self) -> None:
        for _ in range(6):
            self.assertEqual(self.json("GET", "/v1/search?q=Kino")[0], 200)
        self.assertEqual(self.json("GET", "/v1/search?q=kino")[0], 200)   # регистр не важен
        self.assertEqual(self.engine.searches, [("spotify", "Kino")])

    def test_stale_search_of_the_same_code_is_dropped(self) -> None:
        self.engine.search_gate = threading.Event()
        first = self.in_background("GET", "/v1/search?q=mi")
        self.assertTrue(self.engine.search_started.wait(5))
        # пока движок занят «mi», человек допечатал ещё дважды
        middle = self.in_background("GET", "/v1/search?q=mich")
        time.sleep(0.2)
        last = self.in_background("GET", "/v1/search?q=michael")
        time.sleep(0.2)
        self.engine.search_gate.set()
        for box in (first, middle, last):
            box["thread"].join(5)

        self.assertEqual(first["result"][0], 200)
        self.assertEqual(middle["result"], (409, {"error": "superseded", "message": "Запрос устарел"}))
        self.assertEqual(last["result"][0], 200)
        self.assertEqual([query for _, query in self.engine.searches], ["mi", "michael"])

    def test_codes_do_not_supersede_each_other(self) -> None:
        self.engine.search_gate = threading.Event()
        first = self.in_background("GET", "/v1/search?q=mama")
        self.assertTrue(self.engine.search_started.wait(5))
        friend = self.in_background("GET", "/v1/search?q=friend", code=self.friend)
        time.sleep(0.2)
        self.engine.search_gate.set()
        for box in (first, friend):
            box["thread"].join(5)
        self.assertEqual(first["result"][0], 200)
        self.assertEqual(friend["result"][0], 200)

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

    def test_parse_youtube_keeps_only_videos(self) -> None:
        info = {"entries": [
            {"id": VIDEO, "title": "Кино — Кукушка", "channel": "Кино", "duration": 401.4},
            {"id": "UCxxxxxxxxxxxxxxxxxxxxxx", "title": "канал"},
            {"id": "abcdefghijk", "title": "эфир", "live_status": "is_live"},
            {"id": "zyxwvutsrqp", "title": "Без канала", "uploader": "кто-то"},
        ]}
        results = parse_youtube(info, 10)
        self.assertEqual([r.id for r in results], [VIDEO, "zyxwvutsrqp"])
        self.assertEqual(results[0].source, "youtube")
        self.assertEqual(results[0].duration, 401)
        self.assertEqual(results[0].cover, f"https://i.ytimg.com/vi/{VIDEO}/hqdefault.jpg")
        self.assertEqual(results[1].artist, "кто-то")

    def test_pick_match_prefers_the_closest_duration(self) -> None:
        items = [{"videoId": "a", "duration_seconds": 250}, {"videoId": "b", "duration_seconds": 402},
                 {"videoId": "c", "duration_seconds": 399}]
        self.assertEqual(pick_match(items, 401), "b")
        self.assertEqual(pick_match(items, 0), "a")
        self.assertIsNone(pick_match([{"title": "без id"}], 100))

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

    def test_youtube_download(self) -> None:
        self.engine.release()
        status, job = self.json("POST", "/v1/downloads", body={"source": "youtube", "id": VIDEO})
        self.assertEqual(status, 202)
        done = self.wait_state(job["id"], "done")
        self.assertEqual(done["file"]["name"], "Кино — Кукушка (live).m4a")
        self.assertEqual(self.engine.downloads, [("youtube", VIDEO)])
        self.assertTrue((self.config.data_path / f"youtube-{VIDEO}").exists())

        status, body = self.json("GET", "/v1/search?q=kino&source=youtube")
        self.assertEqual(body["results"][0]["id"], VIDEO)

    def test_engine_error_reaches_the_client(self) -> None:
        self.engine.fail = "трек не нашёлся на YouTube Music"
        self.engine.release()
        _, job = self.json("POST", "/v1/downloads", body={"id": TRACK})
        failed = self.wait_state(job["id"], "error")
        self.assertEqual(failed["error"], "трек не нашёлся на YouTube Music")
        # папка неудачной загрузки не остаётся на диске
        self.assertFalse((self.config.data_path / f"spotify-{TRACK}").exists())

    def test_only_valid_ids_are_accepted(self) -> None:
        bad = [
            {"id": "../../etc/passwd"}, {"id": "https://open.spotify.com/track/x"}, {}, [],
            {"source": "youtube", "id": TRACK},            # id Spotify под видом ролика
            {"source": "spotify", "id": VIDEO},
            {"source": "vk", "id": VIDEO},
        ]
        for body in bad:
            self.assertEqual(self.json("POST", "/v1/downloads", body=body)[0], 400, body)
        response, _ = self.request("POST", "/v1/downloads", body={"id": "x" * 2000})
        self.assertEqual(response.status, 413)

    def test_unknown_or_foreign_job_is_404(self) -> None:
        self.assertEqual(self.json("GET", "/v1/downloads/" + "0" * 32)[0], 404)
        _, job = self.json("POST", "/v1/downloads", body={"id": TRACK})
        self.assertEqual(self.json("GET", f"/v1/downloads/{job['id']}", code=self.friend)[0], 404)

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
        self.assertEqual(self.engine.downloads, [("spotify", TRACK)])

        self.clock.now += 3601
        self.jobs.cleanup()
        self.assertFalse((self.config.data_path / f"spotify-{TRACK}").exists())
        self.assertEqual(self.json("GET", f"/v1/downloads/{first['id']}")[0], 404)

    # ── предпрослушивание ──────────────────────────────────────
    def preview_url(self, source: str = "spotify", item_id: str = TRACK) -> str:
        status, body = self.json("POST", "/v1/previews", body={"source": source, "id": item_id})
        self.assertEqual(status, 200, body)
        return body["url"]

    def test_preview_streams_with_range_and_without_the_code(self) -> None:
        self.engine.stream_urls = [self.audio_url]
        url = self.preview_url()
        # плеер ходит без заголовка с кодом: пропуск — сам токен
        response, data = self.request("GET", url, code=None, origin=None, headers={"Range": "bytes=10-19"})
        self.assertEqual(response.status, 206)
        self.assertEqual(data, AUDIO[10:20])
        self.assertEqual(response.getheader("Content-Range"), f"bytes 10-19/{len(AUDIO)}")
        self.assertEqual(response.getheader("Content-Type"), "audio/mp4")
        self.assertEqual(response.getheader("Accept-Ranges"), "bytes")
        self.assertIsNone(response.getheader("Set-Cookie"), "лишнее от YouTube не пересылаем")

        response, data = self.request("GET", url, code=None, origin=None)
        self.assertEqual(response.status, 200)
        self.assertEqual(data, AUDIO)

    def test_preview_token_cannot_be_forged_or_reused_late(self) -> None:
        self.engine.stream_urls = [self.audio_url]
        url = self.preview_url()
        payload, _, signature = url.removeprefix("/v1/preview/").partition(".")
        forged = f"/v1/preview/{payload}.{'A' * len(signature)}"
        self.assertEqual(self.request("GET", forged, code=None)[0].status, 403)

        self.token_clock.now += 31 * 60
        response, data = self.request("GET", url, code=None)
        self.assertEqual(response.status, 403)
        self.assertEqual(json.loads(data)["error"], "forbidden")

    def test_expired_stream_is_found_again_once(self) -> None:
        self.engine.stream_urls = [self.expired_url, self.audio_url]
        url = self.preview_url()
        response, data = self.request("GET", url, code=None, headers={"Range": "bytes=0-3"})
        self.assertEqual(response.status, 206)
        self.assertEqual(data, AUDIO[:4])
        self.assertEqual(self.engine.stream_calls, 2)

    def test_preview_of_something_not_found(self) -> None:
        status, body = self.json("POST", "/v1/previews", body={"source": "spotify", "id": TRACK})
        self.assertEqual(status, 502)
        self.assertEqual(body["message"], "Трек не нашёлся на YouTube Music")
        self.assertEqual(self.json("POST", "/v1/previews", body={"source": "youtube", "id": TRACK})[0], 400)

    def test_log_has_duration_and_no_secrets(self) -> None:
        self.engine.stream_urls = [self.audio_url]
        url = self.preview_url()
        with self.assertLogs("vinilyed_server.app", level="INFO") as logs:
            self.request("GET", url, code=None)
            self.request("GET", "/v1/search?q=kino")
        text = "\n".join(logs.output)
        self.assertIn("/v1/preview/…", text)
        self.assertNotIn(url.removeprefix("/v1/preview/"), text)
        self.assertNotIn(self.code, text)
        self.assertRegex(text, r"/v1/search\?q=kino HTTP/1.1\" 200 за \d+\.\d с")

    def test_unknown_route(self) -> None:
        self.assertEqual(self.json("GET", "/api/songs/search?query=x")[0], 404)


class TokensTest(unittest.TestCase):
    def test_round_trip_and_tampering(self) -> None:
        clock = Clock(1_000_000)
        tokens = Tokens(secret=b"s" * 32, ttl=60, clock=clock)
        token = tokens.issue("мама", "youtube", VIDEO)
        self.assertEqual(tokens.check(token), ("мама", "youtube", VIDEO))
        self.assertIsNone(Tokens(secret=b"x" * 32, clock=clock).check(token), "чужой секрет")
        self.assertIsNone(tokens.check("garbage"))
        self.assertIsNone(tokens.check(token.replace(".", "x.", 1)))
        clock.now += 61
        self.assertIsNone(tokens.check(token), "просрочен")


if __name__ == "__main__":
    unittest.main()
