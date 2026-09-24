# Сервер скачивания Vinilyed

Маленький сервер для Мака: по запросу из приложения ищет трек в Spotify
или ролик на YouTube, даёт послушать его прямо с сервера и скачивает
через [spotDL](https://github.com/spotDL/spotify-downloader) и yt-dlp
(звук — с YouTube). Приложение кладёт трек на полку, а обложку и
название потом доводит своим поиском — в том числе по звуку.

```
телефон ── https://dl.richard-ushkalov.com ── туннель Cloudflare ── Мак 127.0.0.1:8765 ── spotDL
```

- **Только своим.** Каждый запрос — с кодом доступа. Коды выдаёт
  владелец командой `add-code`, в файле настроек лежат только их хеши.
- **Только поиск, прослушивание и скачивание.** Сервер принимает id
  трека Spotify или ролика YouTube — ни адресов, ни путей. Сам
  `spotdl web` в интернет не выставляется: у него нет пароля.
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

Для YouTube — `vinilyed-server check --youtube "Кино Кукушка live"`.

### Запуск

```sh
vinilyed-server serve
```

Появится `Vinilyed слушает http://127.0.0.1:8765` — сервер работает, пока
открыто окно терминала; остановить — Ctrl+C. В этом же окне видно каждый
запрос и сколько он занял. Проверить из второго окна:

```sh
curl -H "Authorization: Bearer КОД" http://127.0.0.1:8765/v1/health   # → {"ok": true, …}
```

Попробовать с самого Мака, в Chrome: «Настройки» → «Скачивание», адрес
`http://127.0.0.1:8765` и код. Если Chrome спросит про доступ к локальной
сети — разрешить. Телефону этот адрес не подойдёт — ему нужен туннель
(ниже); когда он заработает, поле адреса снова очистить.

### Автозапуск

Ручной `serve` перед этим остановить (Ctrl+C) — иначе порт занят.

```sh
vinilyed-server install-agent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vinilyed.server.plist
```

Сервер стартует при входе в систему и поднимается сам после сбоя.
Журнал — `tail -f ~/Library/Logs/vinilyed-server.log`. Выключить —
`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.vinilyed.server.plist`.

### Обновление

```sh
git -C ~/vinylied pull
~/vinylied/server/setup.sh
```

`setup.sh` обновит spotDL и сам перезапустит сервер на автозапуске.
Запущенный вручную (`serve`) остановите и запустите снова — иначе в
памяти останется старый код. Какая версия сейчас работает, видно в
ответе `/v1/health` (поле `version`).

## Доступ из интернета: туннель Cloudflare

Туннель ведёт `https://dl.richard-ushkalov.com` прямо на сервер
на Маке: порты на роутере открывать не нужно, домашний IP скрыт,
HTTPS настоящий — работает и на iPhone.

1. DNS домена должен обслуживать Cloudflare (бесплатный план):
   [dash.cloudflare.com](https://dash.cloudflare.com) → Add a domain →
   `richard-ushkalov.com` → у регистратора домена заменить NS-серверы
   на те, что покажет Cloudflare. Если на домене уже сайт на GitHub
   Pages — сначала раздел ниже.
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

### Домен уже занят GitHub Pages

Портфолио на `richard-ushkalov.com` не пострадает: туннель занимает
только `dl.richard-ushkalov.com`. Нужно лишь перенести DNS как есть.

1. Прежде чем менять NS, сверить в Cloudflare (DNS → Records), что
   при добавлении домена он перенёс записи сайта:
   - `@` — четыре A-записи GitHub: `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153` (и AAAA `2606:50c0:8000::153` …
     `8003::153`, если были);
   - `www` — CNAME на `richard-ushkalov.github.io`;
   - почта (MX, TXT), если на домене есть почта.
2. У записей GitHub выключить оранжевое облако — «DNS only». Так GitHub
   сам выпускает сертификат, и «Enforce HTTPS» в настройках Pages
   продолжает работать.
3. Сменить NS у регистратора. Пока это расходится (от минут до пары
   часов), сайт открывается как раньше: записи те же. Проверить можно
   командой `dig +short richard-ushkalov.com` до и после.
4. Если GitHub отдаёт и само приложение с этого домена
   (`richard-ushkalov.com/vinylied`), сервер это уже учитывает: свой
   домен есть во встроенном списке CORS.

Не хочется трогать DNS — есть Tailscale Funnel: `brew install tailscale`,
войти, `tailscale funnel --bg 8765`. Он даст публичный адрес вида
`https://мак.имя-сети.ts.net` — его вписать в приложении в «Адрес сервера».

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
| `origins` | пусто | ещё адреса, откуда браузеру можно звать сервер (CORS), — к встроенным: сайт приложения и `richard-ushkalov.com` |
| `format`, `bitrate` | `m4a`, `disable` | AAC с YouTube Music копируется без перекодирования. Для mp3 — `mp3` и `192k` |
| `ttl` | `3600` | сколько секунд готовый файл ждёт, пока его заберут |
| `search_per_minute` | `30` | поисков в минуту на один код (повторы из кеша не считаются) |
| `jobs_per_code` | `3` | загрузок одновременно на один код |
| `previews_per_minute`, `previews_at_once` | `20`, `2` | прослушиваний в минуту и одновременно на один код |
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
- **«Сервер на Маке старой версии — его нужно обновить»** (или «Нет такого
  адреса»): сервер не перезапускали после обновления — см. «Обновление».
- **«Сервер долго не отвечает».** Spotify или YouTube думают дольше
  30 секунд. В окне `serve` (или в журнале) видно, сколько занял каждый
  запрос. Повторный поиск того же запроса отвечает сразу — из кеша.
- **«Сервер загрузки недоступен» только на сайте с `richard-ushkalov.com`.**
  Значит, браузер не пустил ответ (CORS): обновите сервер
  (`git -C ~/vinylied pull`, `~/vinylied/server/setup.sh`, перезапуск).

## Разработка

```sh
python3 -m unittest discover -s server/tests -t server   # из корня репозитория
ruff check server
```

API (`Authorization: Bearer <код>`):

| Запрос | Ответ |
|---|---|
| `GET /v1/health` | `{ ok, version, spotdl, active }` |
| `GET /v1/search?q=&source=spotify\|youtube&limit=8` | `{ results: [{ id, source, title, artist, album, duration, cover }] }`; 409 `superseded` — от этого кода уже пришёл поиск новее |
| `POST /v1/downloads` `{ "source": "spotify"\|"youtube", "id": "…" }` | 202, задание (без `source` — Spotify) |
| `POST /v1/previews` `{ "source", "id" }` | `{ url: "/v1/preview/<токен>" }` — ссылка на 30 минут |
| `GET /v1/preview/<токен>` | звук потоком, без заголовка с кодом; `Range` работает |
| `GET /v1/downloads/<job>` | `{ id, state: queued\|running\|done\|error, progress 0..1, stage, error?, file? }` |
| `GET /v1/downloads/<job>/file` | байты трека, имя — в `X-Filename` |

Ошибки — `{ error, message }`: `unauthorized` (401), `bad_request` (400/413),
`not_found` (404), `not_ready` (409), `busy` (429), `engine` (502).

spotDL закреплён в `requirements.txt`: сервер опирается на его внутренние
классы. После обновления версии `tests/test_engine.py` сверит, что они
устроены по-прежнему.
