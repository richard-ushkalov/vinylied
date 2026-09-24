"""Сверка с настоящим spotDL — без сети: что его классы по-прежнему
устроены так, как на них рассчитывает SpotdlEngine. Ловит поломки при
обновлении spotDL. Без установленного spotDL тест пропускается.
"""

from __future__ import annotations

import dataclasses
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from vinilyed_server.config import Config
from vinilyed_server.engine import STAGES, SpotdlEngine, youtube_download_options

try:
    import spotdl  # noqa: F401
    HAVE_SPOTDL = True
except ImportError:
    HAVE_SPOTDL = False


@unittest.skipUnless(HAVE_SPOTDL, "spotDL не установлен")
class SpotdlContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        # Downloader требует ffmpeg; для сверки хватит заглушки в PATH
        ffmpeg = Path(self.tmp.name) / "ffmpeg"
        ffmpeg.write_text("#!/bin/sh\necho ffmpeg version 7.0\n")
        ffmpeg.chmod(ffmpeg.stat().st_mode | stat.S_IEXEC)
        patcher = mock.patch.dict(os.environ, {"PATH": f"{self.tmp.name}{os.pathsep}{os.environ['PATH']}"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_downloader_takes_our_settings(self) -> None:
        engine = SpotdlEngine(Config(data_dir=self.tmp.name))
        downloader = engine._ensure_downloader()
        self.assertEqual(downloader.settings["format"], "m4a")
        self.assertEqual(downloader.settings["bitrate"], "disable")
        self.assertEqual(downloader.settings["lyrics_providers"], [])
        self.assertEqual(downloader.errors, [])

    def test_progress_handler_reports_every_stage(self) -> None:
        from spotdl.download.progress_handler import ProgressHandler
        from spotdl.types.song import Song

        values = {field.name: None for field in dataclasses.fields(Song)}
        values.update(name="Кукушка", artists=["Кино"], artist="Кино", genres=[], disc_number=1, disc_count=1,
                      album_name="Чёрный альбом", album_artist="Кино", duration=401, year=1990, date="1990",
                      track_number=1, tracks_count=1, song_id="x" * 22, explicit=False, publisher="",
                      url="https://open.spotify.com/track/" + "x" * 22)
        seen: list[tuple[str, float]] = []
        def record(tracker, message: str) -> None:
            seen.append((message, tracker.progress))

        handler = ProgressHandler(simple_tui=True, update_callback=record, web_ui=True)
        handler.set_song_count(1)
        tracker = handler.get_new_tracker(Song(**values))
        tracker.notify_searching()
        tracker.notify_getting_meta()
        tracker.yt_dlp_progress_hook({"status": "downloading", "total_bytes": 100, "downloaded_bytes": 50})
        tracker.ffmpeg_progress_hook(50)
        tracker.notify_conversion_complete()
        tracker.notify_complete()

        progress = [value for _, value in seen]
        self.assertEqual(progress, sorted(progress), "проценты только растут")
        self.assertEqual(progress[-1], 100)
        # скачивание идёт по байтам (web_ui=True), а не прыжком к 70
        self.assertIn(("Downloading", 55.0), seen)
        for message, _ in seen:
            self.assertIn(message, STAGES, f"новый этап spotDL: {message}")


    def test_youtube_download_options_are_accepted_by_yt_dlp(self) -> None:
        import yt_dlp

        options = youtube_download_options(Path(self.tmp.name), lambda _: None, lambda _: None)
        with yt_dlp.YoutubeDL(options) as ydl:
            names = [type(pp).__name__ for stage in ydl._pps.values() for pp in stage]
        self.assertEqual(sorted(names), sorted([
            "FFmpegExtractAudioPP", "FFmpegThumbnailsConvertorPP", "FFmpegMetadataPP", "EmbedThumbnailPP",
        ]))

    def test_ytmusicapi_search_takes_our_arguments(self) -> None:
        import inspect

        from ytmusicapi import YTMusic

        parameters = inspect.signature(YTMusic.search).parameters
        self.assertIn("filter", parameters)
        self.assertIn("limit", parameters)


if __name__ == "__main__":
    unittest.main()
