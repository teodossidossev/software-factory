# SF-002: частна връзка ChatGPT ↔ локален MCP bridge

- Дата: 2026-10-25, Europe/Sofia
- Изпълнител: Claude Code (Claude Opus 5.5), локално инсталираният `/implement` skill
- Задача: `docs/tasks/SF-002-connect-chatgpt.md`. Runbook: `docs/runbooks/chatgpt-connection.md`
- Git: Claude не е изпълнявал staging, unstaging, commit или push. Index-ът е байт по байт същият като в началото (`git ls-files -s` спрямо `review/SF-002/baseline/git-index.txt`).

## 1. Резултат

**Интеграцията е проверена.**

Реален ChatGPT Work чат извика `factory_status`, `factory_write_probe` и `factory_read_probe` през OpenAI Secure MCP Tunnel до bridge-а на `127.0.0.1:8787`.

Резултатите, които ChatGPT съобщи, съвпадат с независимо изчислените стойности на локалния `factory-data/probe.txt`:

| Поле | ChatGPT (`factory_write_probe` / `factory_read_probe`) | Локален файл (Claude) | |
| --- | --- | --- | --- |
| message | `SF-002 — връзка от ChatGPT — 2026-10-25T11:07:50.453Z-lk79ll` | същият (UTF-8 decode) | съвпада |
| bytes | 72 | 72 (`wc -c`, Python `len`) | съвпада |
| sha256 | `0061fc6ceda080f3213ee4b53971bf132de4cd13ea9630a8310e1c7b4a91dc24` | същият (`sha256sum`, Python `hashlib`) | съвпада |

Времева линия:
- Проверката в ChatGPT е в 2026-10-25T11:08:20.085Z (13:08:20 София).
- Локалният файл е променен в 13:08:09.17 София: след marker-а (11:07:50Z) и преди проверката.
- Tunnel-client е препратил точно 5 команди към bridge-а:
  - 2 в 13:05:05 (discovery при създаването на plugin-а);
  - по една в 13:07:59, 13:08:09 и 13:08:20, което съвпада с трите извиквания.
- Предишното съдържание на файла (28 bytes, `025ecc81…`) е заменено, както се очаква. В `factory-data/` няма други файлове.

Доказателства: `review/SF-002/logs/probe-verification.log`, `tunnel-run-02-connected.log` и `baseline/probe-before.txt`.

Ограничения на доказателството:
- Потребителят върна обобщение с message, bytes, sha256 и времето на проверката. Пълният суров изход на `factory_status` от ChatGPT не е предаден в този разговор, така че тук не е цитиран.
- Потвърдено е, че извикването е минало: тунелът е препратил команда в 13:07:59 и потребителят докладва успех. Точният текст на отговора в ChatGPT не е записан тук.

## 2. Действителни настройки (без тайни)

| Компонент | Стойност |
| --- | --- |
| Транспорт | OpenAI Secure MCP Tunnel; tunnel-client в режим long-poll, изходящ HTTPS към `api.openai.com:443` |
| Тунел | име `software-factory`, `tunnel_6adddd07…22b1` (пълният ID е в профила и логовете). Описание: „Private MCP connection between ChatGPT and the local Software Factory bridge.“ |
| tunnel-client | v0.0.18 (`0.0.18+274a5588`), flavor `client` linux-amd64 |
| Инсталация | `~/.local/opt/tunnel-client/v0.0.18`, symlink `~/.local/bin/tunnel-client`. SHA256 на zip-а `3c823073…6a04c4` = `SHA256SUMS.txt` = GitHub API digest. Sigstore attestation не е проверена (`gh` липсва). |
| Профил | `~/.config/tunnel-client/software-factory.yaml`, sample `sample_mcp_remote_no_auth`, MCP `http://127.0.0.1:8787/mcp`, health/UI `127.0.0.1:8790` |
| Runtime ключ | `~/.config/software-factory/tunnel-runtime.key` (0600, директория 0700). Профилът сочи към него като `api_key: "file:…"`. Claude не е чел и не е отпечатвал стойността. |
| ChatGPT | Plugins → Add custom MCP server, Name „Software Factory“, Connection Tunnel, Authentication No authentication, personal plugin, нов Work чат с `@Software Factory` |
| Bridge | без промяна от SF-001 (R1 build), `127.0.0.1:8787/mcp`, съществуващите Host/Origin guards |
| Протокол tunnel-client ↔ bridge | **2026-07-28** (наблюдаван: `mcp session initialized`, `protocol_version: 2026-07-28`) |
| Протокол ChatGPT ↔ тунел | **не е наблюдаван**. Логовете не съдържат метод или версия за препратените команди. |

## 3. Начален baseline (за разграничаване)

- Branch `main`, unborn (няма HEAD).
- Index-ът е чужд и непроменен:
  - `A` за `.gitignore`, `.idea/*` (6 файла) и `bridge/*` (9 файла);
  - `AM` за `bridge/src/server.ts` и `bridge/test/smoke.test.ts`.
- Untracked: `docs/reports/SF-001-report.md` и `docs/tasks/SF-001-bootstrap.md`, `SF-001-review-01.md`, `SF-002-connect-chatgpt.md`.
- Snapshot-ът е записан read-only в `review/SF-002/baseline/`: git status, `git ls-files -s` и sha256 на всички файлове в работното копие.
- Staging-ът не е приписан на конкретен човек или инструмент.

**За ръчния Git етап:**
- В index-а все още са staged версиите на `bridge/src/server.ts` и `bridge/test/smoke.test.ts` отпреди R1.
- Актуалните версии (R1 поправката и regression теста) са само в работното копие.
- Ръчният етап трябва да включи работните версии на тези два файла, плюс всички untracked файлове от SF-001 и SF-002.

## 4. Създадени и променени файлове (SF-002)

5 авторски файла, всички нови или untracked; tracked файлове не са променяни:

| Файл | Роля |
| --- | --- |
| `scripts/sf-tunnel.sh` | launcher: `init`, `set-key` (скрит input, 0600), `check`, `doctor`, `run` (`exec`, сигналите отиват директно) |
| `config/tunnel-client/software-factory.example.yaml` | пример за профила (placeholder ID, само референция към ключа) |
| `docs/runbooks/chatgpt-connection.md` | инсталация, акаунт стъпки, start/stop/restart, ChatGPT стъпки |
| `docs/reports/SF-002-report.md` | този отчет |
| `docs/tasks/SF-002-connect-chatgpt.md` | добавена секция „Резултат от изпълнението“ (задачата беше от потребителя) |

Извън repository-то:
- `~/.local/opt/tunnel-client/v0.0.18/`;
- `~/.local/bin/tunnel-client`;
- `~/.config/tunnel-client/software-factory.yaml`;
- ключовият файл (създаден от потребителя).

Runtime данни (ignored): `factory-data/probe.txt`, съдържа пробата.

`bridge/` **не е променян**: проверките за Host/Origin минаха без промяна.

## 5. Проверки

Логовете са в `review/SF-002/logs/`. Никой от тях не съдържа ключ: проверено е за `sk-…`, `Bearer`, `authorization` и `cookie`, с 0 съвпадения.

| # | Команда | Exit | Резултат | Лог |
| --- | --- | --- | --- | --- |
| 1 | `sha256sum -c --ignore-missing SHA256SUMS.txt` | 0 | zip и spdx: OK | (горе, т. 2) |
| 2 | `scripts/sf-tunnel.sh` / `init` / `init bad` / `check` (без профил) | 2 / 2 / 2 / 1 | usage; ясна грешка „profile missing“ | `launcher-precheck.log` |
| 3 | `init` + `check` с фиктивен ID във временна директория (без ключ / с фиктивен ключ / `set-key` без tty) | 1 / 0 / 1 | грешка „key file missing“ → 4× ok → „needs an interactive terminal“ | `launcher-init-check.log` |
| 4 | `scripts/sf-tunnel.sh init tunnel_6adddd07…` + `check` | 0 / 0 | профилът е създаден; 4× ok | `profile-init-check.log` |
| 5 | `scripts/sf-tunnel.sh doctor` | 0 | `RESULT ok`; MCP reachable (HTTP 405); OAuth metadata: всички адреси 404 | `doctor.log` |
| 6 | `scripts/sf-tunnel.sh run` (1-ви опит) | 0 (спрян с SIGTERM) | **401 Unauthorized** от control plane: в ключовия файл беше записан `tunnel_id` (39 bytes, проверено с `cmp`, без показване) | `tunnel-run-01-401.log` |
| 7 | `scripts/sf-tunnel.sh check` след добавената защита | 1 | „key file holds a tunnel_id, not the runtime API key“ | `launcher-check-wrong-key.log` |
| 8 | `scripts/sf-tunnel.sh check` (нов ключ) | 0 | 4× ok | `launcher-check-02.log` |
| 9 | `scripts/sf-tunnel.sh run` (2-ри опит, работи) | работи | metadata fetched; MCP сесия 2026-07-28; poller started | `tunnel-run-02-connected.log` |
| 10 | `tunnel-client health --port 8790 --require-control-plane-poll --json` | 0 | `result: ok`, live/ready, control-plane poll ok | `health-02.json` |
| 11 | ChatGPT проба (§8 от задачата) | — | `factory_status`, `factory_write_probe`, `factory_read_probe` са успешни по доклад на потребителя; 3 препратени команди в лога | `tunnel-run-02-connected.log` |
| 12 | Локална проверка на `probe.txt` | 0 | message, bytes и sha256 съвпадат | `probe-verification.log` |

Не са пускани `npm ci`, typecheck, build или smoke: TypeScript кодът и зависимостите не са променени (задачата, §9).

Host/Origin:
- Няма наблюдаван 403. Заявките през тунела са минали през съществуващите guards и затова не са променяни.
- Точните стойности на Host и Origin, които tunnel-client изпраща, **не са наблюдавани**, понеже bridge-ът не логва заглавки. Успешното преминаване доказва само съвместимост.

## 6. Ограничения, отворени въпроси и наблюдения

- **OAuth discovery предупреждение.** При `run` tunnel-client логва `OAuth discovery failed … protected resource metadata missing resource`, докато `doctor` отчита, че всички адреси дават 404. Готовността и ChatGPT пробата не са засегнати. Причината не е изследвана; bridge-ът не е променян без доказан проблем.
- **Процесите.** Bridge-ът и tunnel-client работят като фонови процеси на тази Claude Code сесия, а не във видими IntelliJ терминали. Спират с края на сесията, рестарт на машината или `kill -TERM`. Командите за видими терминали са в runbook-а. Няма supervisor, по задание.
- **Протоколът между ChatGPT и тунела** не е наблюдаван.
- **Сигурност.** MCP слоят е без автентикация. Достъпът се определя от това кой може да използва тунела (Tunnels Use) и plugin-а в ChatGPT. Обхватът е само трите probe tools.
- **Sigstore.** Проверката на provenance за tunnel-client не е направена.
- **Codex plugin.** `doctor` го отчита като SKIP („Tunnel MCP plugin not installed“). Не е нужен за тази задача и не е инсталиран.

## 7. Старт, стоп, рестарт

От repository root-а:

```bash
# bridge (terminal 1)
cd bridge && npm start                       # 127.0.0.1:8787/mcp
# tunnel (terminal 2)
scripts/sf-tunnel.sh check && scripts/sf-tunnel.sh run
tunnel-client health --port 8790 --require-control-plane-poll
```

Спиране:
- `Ctrl+C` в съответния терминал.
- За фоновите процеси от тази сесия: `kill -TERM <pid>`. PID-ът на bridge-а се вижда със `ss -ltnp | grep 8787`, а на tunnel-client с `ps -eo pid,comm | awk '$2=="tunnel-client"'`.

Рестарт: първо спри стария tunnel-client, после пусни нов. Два активни клиента за един тунел не се поддържат.

## 8. Explain yourself

**Какво вече може ChatGPT.** От Work чат с `@Software Factory` може да вика трите probe tools на тази машина:
- да види статуса на bridge-а;
- да запише текст до 4096 символа във фиксирания `probe.txt`;
- да го прочете обратно.

Нищо повече: няма файлова система, терминал или Claude.

**Как минава заявката.**
1. ChatGPT вика OpenAI-hosted MCP endpoint за тунела.
2. tunnel-client на машината взима заявката с изходящ long-poll по HTTPS.
3. Подава я на `http://127.0.0.1:8787/mcp`.
4. Връща отговора по същия път.

Няма входящ порт, публичен listener или port forwarding. Bridge-ът продължава да слуша само на loopback.

**Кой държи credential-а.**
- Само tunnel-client, чрез `file:` референция към ключов файл с права 0600. Потребителят е въвел стойността със скрит prompt.
- Ключът не е в repository-то, в логовете, в чата или в plugin формата.
- ChatGPT plugin-ът е с „No authentication“. Защитата е тунелът и правата върху него.

**Как се пуска и спира.** С две команди: `npm start` в `bridge/` и `scripts/sf-tunnel.sh run`. Спират се с Ctrl+C или SIGTERM, а `run` предава сигнала директно чрез `exec`.

**Какво е наблюдавано.**
- Успешен control-plane poll, readiness и метаданни на тунела.
- MCP сесия tunnel-client ↔ bridge по 2026-07-28.
- 5 препратени команди: discovery и три tool извиквания.
- Записаният от ChatGPT текст е байт по байт във файла: съвпадат message, 72 bytes и sha256.

**Какво още не е доказано.**
- Протоколната версия между ChatGPT и тунела.
- Точните Host и Origin заглавки.
- Причината за OAuth discovery предупреждението.
- Работа с видими терминали и след рестарт на машината (документирано, но не изпълнено).
- Дълготрайна стабилност на връзката.
- Суровият изход на `factory_status` от ChatGPT не е записан тук.

**Защо е избран този дизайн.**
- Официалният tunnel-client и вграденият sample за HTTP без OAuth покриват нуждата без собствен transport и без промяна на bridge-а.
- Launcher-ът само фиксира профила, пази ключа извън repository-то и прави предварителните проверки детерминистични.
- Единствената добавена логика (защитата `tunnel_id` ≠ ключ) идва от реална грешка по време на изпълнението.

## 9. Предложение за ръчен Git

- Branch: `sf-002-chatgpt-secure-tunnel`
- Commit/MR заглавие: `SF-002: connect ChatGPT to the local MCP bridge via Secure MCP Tunnel`
- MR описание:

  ```text
  Connects a ChatGPT Work personal plugin to the loopback-only bridge through
  OpenAI Secure MCP Tunnel (tunnel-client v0.0.18, outbound HTTPS, no inbound port).

  - scripts/sf-tunnel.sh: init / set-key (hidden, 0600 file) / check / doctor / run
  - config/tunnel-client/software-factory.example.yaml: example profile (no secrets)
  - docs/runbooks/chatgpt-connection.md: install, account steps, start/stop, ChatGPT setup
  - docs/reports/SF-002-report.md: verified ChatGPT probe (message/bytes/sha256 match local file)

  Bridge code unchanged. MCP layer: No authentication, private tunnel only, three probe tools.
  Note: include the working-tree versions of bridge/src/server.ts and
  bridge/test/smoke.test.ts (SF-001 R1); the index still holds older staged copies.
  ```

Done остава потвърденият ръчен push.

## Доказателствено уточнение (добавено в SF-003, 2026-10-25)

- **Първата проба** (`2026-10-25T11:07:50.453Z-lk79ll`, 72 bytes) е единствената, сверена локално от Claude. Петте препратени заявки в лога на tunnel-client (т. 1) се отнасят до наблюдавания интервал на тази проба.
- **Втората проба** е направена в ChatGPT разговора: `2026-10-25T11:17:23Z-219mbk`, 68 bytes, SHA-256 `b157d7d7e3be49b12bf0d5879901e7a379c93d4c0881be57c28d141e8adc7ebf`, прочетена повторно в 11:20:17Z. Тя **не** е сверена независимо от Claude.
- Наличният status payload от второто изпълнение е `name: software-factory-bridge`, `version: 0.1.0`, `mode: local-only-pilot`.
