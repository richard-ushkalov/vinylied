#!/usr/bin/env bash
# Установка сервера скачивания Vinilyed на Мак — одной командой:
#
#     ~/vinylied/server/setup.sh
#
# Ставит недостающее из Homebrew, собирает окружение Python со spotDL
# и добавляет команду `vinilyed-server`, которая работает из любой папки.
# Запускать повторно можно и нужно: так же обновляется spotDL.
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SERVER_DIR/.venv"
FORMULAE=(python@3.12 ffmpeg deno cloudflared)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n%s\n' "$*" >&2; exit 1; }

# Путь в одинарных кавычках — для обёртки на sh, даже с пробелами в имени.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

[ "$(uname -s)" = Darwin ] || fail "Этот скрипт — для macOS. На других системах см. «Без скрипта» в server/README.md."

# Homebrew часто стоит, но не прописан в PATH нового терминала — ищем сами.
if ! command -v brew >/dev/null 2>&1; then
    for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if [ -x "$candidate" ]; then eval "$("$candidate" shellenv)"; break; fi
    done
fi
command -v brew >/dev/null 2>&1 || fail "Нужен Homebrew. Установите его с https://brew.sh (одна команда в терминале), затем запустите этот скрипт ещё раз."

say "1/3 Программы из Homebrew"
missing=()
for formula in "${FORMULAE[@]}"; do
    brew list --formula "$formula" >/dev/null 2>&1 || missing+=("$formula")
done
if [ ${#missing[@]} -gt 0 ]; then
    brew install "${missing[@]}"
else
    echo "Всё уже установлено: ${FORMULAE[*]}"
fi

say "2/3 Python и spotDL"
PYTHON="$(brew --prefix python@3.12)/bin/python3.12"
[ -x "$PYTHON" ] || PYTHON="$(command -v python3.12 || true)"
[ -n "$PYTHON" ] || fail "Не нашёлся python3.12 после установки — попробуйте: brew reinstall python@3.12"
[ -x "$VENV/bin/python" ] || "$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet --upgrade -r "$SERVER_DIR/requirements.txt"
echo "spotDL $("$VENV/bin/python" -c 'import spotdl; print(spotdl.__version__)')"

say "3/3 Команда vinilyed-server"
BIN="$(brew --prefix)/bin/vinilyed-server"
cat > "$BIN" <<EOF
#!/bin/sh
# Создано server/setup.sh: сервер Vinilyed из любой папки.
PYTHONPATH=$(quote "$SERVER_DIR")\${PYTHONPATH:+:\$PYTHONPATH}
export PYTHONPATH
exec $(quote "$VENV/bin/python") -m vinilyed_server "\$@"
EOF
chmod +x "$BIN"
echo "Готово: $BIN"

say "Дальше"
cat <<'EOF'
  vinilyed-server add-code family              выдать код (покажется один раз)
  vinilyed-server check "Кино Группа крови"    проверить поиск и скачивание
  vinilyed-server install-agent                автозапуск сервера при входе в систему

Туннель Cloudflare на dl.richard-ushkalov.com — в server/README.md.
EOF
