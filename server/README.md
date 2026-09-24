# Сервер скачивания Vinilyed

Маленький сервер для Мака: по запросу из приложения находит трек
в Spotify и скачивает его через [spotDL](https://github.com/spotDL/spotify-downloader)
(звук берётся с YouTube Music). Приложение кладёт трек на полку, а
обложку и название потом доводит своим поиском.

```
телефон ── https://dl.richard-ushkalov.com ── туннель Cloudflare ── Мак 127.0.0.1:8765 ── spotDL
```

- **Только своим.** Каждый запрос — с кодом доступа. Коды выдаёт
  владелец командой `add-code`, в файле настроек лежат только их хеши.
- **Только поиск и скачивание.** Сервер принимает id трека Spotify —
  ни адресов, ни путей. Сам `spotdl web` в интернет не выставляется:
  у него нет пароля.
- **Бережно к YouTube.** Качается по одному треку, поиск ограничен,
  готовый файл живёт час и отдаётся повторно из кеша.
- **Мак выключен — сервера нет.** Приложение так и напишет:
  «Сервер загрузки недоступен».

> Музыка — только для личного пользования. Не раздавайте коды
> посторонним и не публикуйте их: сервер раздаёт то, что скачивает,
> а это чужие записи.

## Установка на Мак

Нужен [Homebrew](https://brew.sh) — если его нет, поставьте командой с сайта.
Дальше две команды:

```sh
git clone https://github.com/richard-ushkalov/vinylied.git ~/vinylied
~/vinylied/server/setup.sh
```

Скрипт поставит недостающее (`python@3.12`, `ffmpeg`, `deno`, `cloudflared`),
соберёт окружение Python со spotDL и добавит команду `vinilyed-server` —
она работает из любой папки. Повторный запуск ничего не ломает и
обновляет spotDL; код обновить — `git -C ~/vinylied pull`, потом снова
`setup.sh`.

> Команды `python` на Маке нет, а у системного `python3` нет spotDL.
> Всё делается через `vinilyed-server`.

`deno` нужен yt-dlp внутри spotDL: без него YouTube всё чаще отвечает
«подтвердите, что вы не робот».

<details>
<summary>Без скрипта</summary>

```sh
brew install python@3.12 ffmpeg deno cloudflared
cd ~/vinylied/server
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m vinilyed_server codes   # вместо vinilyed-server — из папки server
```

</details>

### Коды доступа

```sh
vinilyed-server add-code mama     # печатает код один раз
vinilyed-server add-code richard
vinilyed-server codes             # чьи коды есть
vinilyed-server revoke mama       # отозвать
```

Код вписывается в приложении: «⋯» → «Настройки» → «Скачивание».
Выдача и отзыв действуют сразу, перезапуск не нужен.

### Проверка

```sh
vinilyed-server check "Кино Группа крови"
```

Найдёт трек в Spotify, скачает первый результат во временную папку и
покажет этапы с процентами. Если здесь всё прошло — пройдёт и в приложении.

### Автозапуск

```sh
vinilyed-server install-agent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vinilyed.server.plist
```

Сервер стартует при входе в систему и поднимается сам после сбоя.
Журнал — `~/Library/Logs/vinilyed-server.log`.

## Доступ из интернета: туннель Cloudflare

Туннель ведёт `https://dl.richard-ushkalov.com` прямо на сервер
на Маке: порты на роутере открывать не нужно, домашний IP скрыт,
HTTPS настоящий — работает и на iPhone.

1. DNS домена должен обслуживать Cloudflare (бесплатный план):
   [dash.cloudflare.com](https://dash.cloudflare.com) → Add a domain →
   `richard-ushkalov.com` → у регистратора домена заменить NS-серверы
   на те, что покажет Cloudflare.
2. Туннель:

   ```sh
   cloudflared tunnel login
   cloudflared tunnel create vinilyed
   cloudflared tunnel route dns vinilyed dl.richard-ushkalov.com
   ```

3. `~/.cloudflared/config.yml` (UUID и путь — из вывода `tunnel create`):

   ```yaml
   tunnel: vinilyed
   credentials-file: /Users/ВАШЕ_ИМЯ/.cloudflared/UUID.json
   ingress:
     - hostname: dl.richard-ushkalov.com
       service: http://127.0.0.1:8765
     - service: http_status:404
   ```

4. Автозапуск туннеля: `cloudflared service install`.
5. Проверка — открыть в браузере `https://dl.richard-ushkalov.com/v1/health`.
   Ответ `{"error": "unauthorized", …}` значит, что всё дошло до сервера
   и он честно просит код.

## Чтобы Мак не засыпал

Сервер работает, пока Мак не спит. На зарядке: «Системные настройки» →
«Аккумулятор» → «Параметры» → «Предотвращать автоматический переход
в режим сна, когда дисплей выключен» (или `sudo pmset -c sleep 0`).
С закрытой крышкой Мак засыпает, если к нему не подключён монитор.

## Настройки

Файл `~/.config/vinilyed/server.json` создаёт `add-code`. Поля, которые
можно поменять (после правки — перезапустить сервер):

| Поле | По умолчанию | Что это |
|---|---|---|
| `port` | `8765` | порт на Маке, его же указывает туннель |
| `origins` | сайт приложения | откуда браузеру можно звать сервер (CORS) |
| `format`, `bitrate` | `m4a`, `disable` | AAC с YouTube Music копируется без перекодирования. Для mp3 — `mp3` и `192k` |
| `ttl` | `3600` | сколько секунд готовый файл ждёт, пока его заберут |
| `search_per_minute` | `30` | поисков в минуту на один код |
| `jobs_per_code` | `3` | загрузок одновременно на один код |
| `spotify_client_id`, `spotify_client_secret` | пусто | см. ниже |
| `data_dir` | `~/Library/Caches/vinilyed-server` | куда качать |

## Если что-то не так

- **«Spotify не ответил на поиск».** spotDL по умолчанию ходит в Spotify
  без официального API, и это иногда ломается. Заведите своё приложение
  на [developer.spotify.com](https://developer.spotify.com/dashboard)
  (Web API, адрес возврата `http://127.0.0.1:9900/`), впишите его
  Client ID и Client Secret в `spotify_client_id` и `spotify_client_secret`,
  перезапустите сервер.
- **«трек не нашёлся на YouTube Music» или YouTube просит подтвердить, что вы не робот.**
  Обновите yt-dlp (`~/vinylied/server/.venv/bin/pip install -U yt-dlp`) и проверьте, что стоит `deno`.
- **Приложение пишет «Код доступа не подошёл».** `codes` покажет, чьи коды
  есть; выдайте новый через `add-code`.

## Разработка

```sh
python3 -m unittest discover -s server/tests -t server   # из корня репозитория
ruff check server
```

API (`Authorization: Bearer <код>`):

| Запрос | Ответ |
|---|---|
| `GET /v1/health` | `{ ok, version, spotdl, active }` |
| `GET /v1/search?q=&limit=8` | `{ results: [{ id, title, artist, album, duration, cover }] }` |
| `POST /v1/downloads` `{ "id": "<id трека Spotify>" }` | 202, задание |
| `GET /v1/downloads/<job>` | `{ id, state: queued\|running\|done\|error, progress 0..1, stage, error?, file? }` |
| `GET /v1/downloads/<job>/file` | байты трека, имя — в `X-Filename` |

Ошибки — `{ error, message }`: `unauthorized` (401), `bad_request` (400/413),
`not_found` (404), `not_ready` (409), `busy` (429), `engine` (502).

spotDL закреплён в `requirements.txt`: сервер опирается на его внутренние
классы. После обновления версии `tests/test_engine.py` сверит, что они
устроены по-прежнему.
