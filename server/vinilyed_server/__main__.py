"""Командная строка: python -m vinilyed_server <команда>.

    serve              запустить сервер
    add-code ИМЯ       выдать код доступа (печатается один раз)
    revoke ИМЯ         отозвать код
    codes              чьи коды есть
    check "запрос"     проверить spotDL: найти и скачать первый результат
    install-agent      автозапуск на Маке (launchd)
"""

from __future__ import annotations

import argparse
import logging
import plistlib
import sys
import tempfile
from pathlib import Path

from .app import App, make_server
from .config import DEFAULT_PATH, Config
from .engine import EngineError, SpotdlEngine
from .jobs import JobQueue

AGENT = "com.vinilyed.server"


def serve(config: Config, config_path: Path) -> None:
    if not config.codes:
        sys.exit("Нет ни одного кода доступа — сначала: python -m vinilyed_server add-code ИМЯ")
    engine = SpotdlEngine(config)
    jobs = JobQueue(engine, config.data_path, ttl=config.ttl,
                    per_owner=config.jobs_per_code, limit=config.queue_limit)
    jobs.start()
    server = make_server(App(config, engine, jobs, config_path))
    logging.info("Vinilyed слушает http://%s:%s (spotDL %s)", config.host, config.port, engine.version() or "не найден")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        jobs.stop()


def check(config: Config, query: str) -> None:
    """Живая проверка на Маке: Spotify, YouTube Music и ffmpeg — всё по-настоящему."""
    engine = SpotdlEngine(config)
    print(f"spotDL {engine.version() or 'не установлен'}")
    try:
        results = engine.search(query, 3)
    except EngineError as error:
        sys.exit(f"Поиск не удался: {error}")
    if not results:
        sys.exit("Ничего не нашлось")
    for result in results:
        print(f"  {result.artist} — {result.title} ({result.album}, {result.duration} с)")
    first = results[0]
    with tempfile.TemporaryDirectory() as folder:
        def progress(value: float, stage: str) -> None:
            print(f"\r  {stage:<16} {value * 100:5.1f}%", end="", flush=True)

        try:
            path = engine.download(first.id, Path(folder), progress)
        except EngineError as error:
            sys.exit(f"\nСкачать не вышло: {error}")
        print(f"\nГотово: {path.name}, {path.stat().st_size / 1_048_576:.1f} МБ")


def install_agent(config_path: Path) -> None:
    """launchd-агент: сервер стартует при входе в систему и поднимается после сбоя."""
    logs = Path("~/Library/Logs").expanduser()
    agent = {
        "Label": AGENT,
        "ProgramArguments": [sys.executable, "-m", "vinilyed_server", "--config", str(config_path), "serve"],
        "WorkingDirectory": str(Path(__file__).resolve().parent.parent),
        "RunAtLoad": True,
        "KeepAlive": True,
        # ffmpeg и deno из Homebrew: у launchd свой, короткий PATH
        "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"},
        "StandardOutPath": str(logs / "vinilyed-server.log"),
        "StandardErrorPath": str(logs / "vinilyed-server.log"),
    }
    target = Path(f"~/Library/LaunchAgents/{AGENT}.plist").expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as file:
        plistlib.dump(agent, file)
    print(f"Записан {target}\nВключить:  launchctl bootstrap gui/$(id -u) {target}"
          f"\nВыключить: launchctl bootout gui/$(id -u) {target}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="vinilyed_server", description="Сервер скачивания Vinilyed")
    parser.add_argument("--config", type=Path, default=DEFAULT_PATH,
                        help=f"файл настроек (по умолчанию {DEFAULT_PATH})")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve", help="запустить сервер")
    add = commands.add_parser("add-code", help="выдать код доступа")
    add.add_argument("name")
    revoke = commands.add_parser("revoke", help="отозвать код")
    revoke.add_argument("name")
    commands.add_parser("codes", help="чьи коды есть")
    probe = commands.add_parser("check", help="найти и скачать первый результат")
    probe.add_argument("query")
    commands.add_parser("install-agent", help="автозапуск на Маке")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = Config.load(args.config)

    if args.command == "serve":
        serve(config, args.config)
    elif args.command == "add-code":
        code = config.add_code(args.name)
        config.save(args.config)
        print(f"Код для «{args.name}»: {code}\n"
              "Он показывается один раз — впишите его в приложении: Настройки → Скачивание.")
    elif args.command == "revoke":
        if config.codes.pop(args.name, None) is None:
            sys.exit(f"Кода «{args.name}» нет")
        config.save(args.config)
        print(f"Код «{args.name}» отозван — сервер перестанет его пускать сразу.")
    elif args.command == "codes":
        print("\n".join(sorted(config.codes)) or "Кодов пока нет")
    elif args.command == "check":
        check(config, args.query)
    elif args.command == "install-agent":
        if not args.config.exists():
            config.save(args.config)
        install_agent(args.config.resolve())


if __name__ == "__main__":
    main()
