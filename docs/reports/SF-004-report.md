# SF-004: Отчет

**Етап:** Изпълнено и проверено. OpenClaw Gateway 2026.10.7 работи в Docker контейнер без мрежа, със статус `healthy`. Всички задължителни проверки минават.

- Дата: 2026-10-26 (UTC).
- Подход: Docker, по решение на потребителя. Задачата: `docs/tasks/SF-004-openclaw-bootstrap.md`.
- Git: не са правени staging, unstaging, commit или push. Index-ът съвпада байт по байт с началото на SF-004 (`review/SF-004/baseline/git-index.txt`).
- Software Factory bridge (`127.0.0.1:8787`, PID 353752) и tunnel-client (`127.0.0.1:8790`, PID 337046) не са пипани и работят. Доказателството е в `review/SF-004/logs/final-state.log`, заедно с Docker root и проверката на index-а.

## Какво работи

| Ресурс | Стойност |
|---|---|
| Image | `ghcr.io/openclaw/openclaw:2026.10.7@sha256:fb26f0841659dc757f23feec9adeab51f11d76779a409db5d22e191b43841afa` (local id `sha256:57a7dfd3…8ff7`, 1.88 GB) |
| Container | `software-factory-openclaw-gateway-1`, `restart: no` |
| Volume | `software-factory-openclaw_home`, монтиран като `/home/node` |
| Gateway | `127.0.0.1:18789` и `[::1]:18789`, само вътре в контейнера |

Подробности за контейнера:
- `network_mode: none`, read-only root, `cap_drop: ALL`, `no-new-privileges`, uid 1000.
- Няма host mounts, Docker socket или публикувани портове.

Host среда: Linux Mint 22.3, kernel 6.8.0-147, Docker Engine 29.1.3, Compose 2.24.6, buildx 0.23.0.

## Проверки

Всички стъпки са пуснати от `scripts/openclaw/sf004-docker.sh`, а логовете са в `review/SF-004/logs/`. Всяка стъпка завърши със `STEP OK`.

| Стъпка | Резултат |
|---|---|
| `preflight` | Docker и Compose са налични, Compose файлът е валиден. Две находки на машината, само отчетени (виж по-долу). |
| `pull` | Digest `fb26f084…1afa`, label version `2026.10.7`, revision `157d8c2bc3ea2fa183afdc11088e69690bf8e64e`, user `node`. |
| `init` | Volume-ът е създаден чак след потвърждението. Token-ът е 600, 64 hex символа, генериран във volume-а и непоказан. Към момента на `init` `openclaw.json` е 600, sha256 `77d1ecd5…a7f9` (= `config/openclaw/openclaw.json5`). `config validate` минава. |
| `up` | `healthy` след около 66 s, с `read_only: true`. Ръчна проверка (grep в `logs/container.log`, не стъпка от скрипта): стартовият лог няма EROFS, EACCES или EPERM. |
| `verify` | 23/23 задължителни проверки, описани по-долу. |
| `lifecycle` | Stop завършва с `exited`, exit code 0 (чисто спиране). Start дава `healthy` и `gateway health` OK. Restart стартира нов процес, `healthy` и `status --require-rpc` OK. Token-ът е непроменен (inode, mtime, size). Config-ът е валиден и със същия hash след restart. |
| `tokenscan` | Token-ът не се среща в 7-те step лога, нито в лога на контейнера. |

Проверките в `verify`:
- **`docker inspect`:**
  - running;
  - image с digest;
  - `NetworkMode=none`;
  - `Privileged=false`;
  - `ReadonlyRootfs=true`;
  - `CapDrop=["ALL"]`, `CapAdd=null`;
  - `no-new-privileges`;
  - `PortBindings={}`;
  - `RestartPolicy=no`;
  - `User=1000:1000`;
  - единственият mount е volume-ът.
- **Host:** нищо не слуша на порт 18789.
- **В контейнера:**
  - `--version` дава `2026.10.7`;
  - `/healthz` връща 200;
  - `gateway health` и `gateway status --require-rpc` минават;
  - `doctor --lint` завършва с exit 1, т.е. има findings, не грешка;
  - `doctor --json`;
  - `security audit` и `security audit --deep` дават 0 critical;
  - listeners: само `127.0.0.1:18789` и `[::1]:18789`.

Предупреждения от одита и doctor:
- `security audit` показва 0 critical, 0 warn и 1 info (attack surface summary).
- `security audit --deep` показва 0 critical, **1 warn** и 1 info. Warn-ът е `gateway.probe_failed: missing scope: operator.read`. Deep probe-ът се свързва със shared token, който не е сдвоено operator устройство. CLI-ят не създава device identity сам, а за това е нужен Control UI или dashboard bootstrap, които са изключени. `gateway status --require-rpc` минава.
- `doctor --lint` дава 4 findings, всички следствие от заключването:
  - моделът по подразбиране `openai/gpt-6-astra` сочи към изключения Codex plugin;
  - device-pair не е активен;
  - bind е само loopback;
  - `minimal` няма `skill_workshop`.
- Миграцията за heartbeat не е от lint, а от `doctor --fix` на entrypoint-а при старт (`logs/container.log`).

## Промени от `doctor --fix` при първия старт

Entrypoint-ът на image-а пуска `openclaw doctor --fix --non-interactive` преди всеки старт. При първия старт (2026-10-26T05:12:16Z) той пренаписа `openclaw.json`: sha256 стана `364a7516…05af` вместо `77d1ecd5…a7f9`. Само добави полета:
- `skills.entries.<31 bundled skills>.enabled=false`;
- `agents.entries.main={}`;
- `meta.migrations` и `meta.lastTouchedVersion`;
- `wizard.lastRun*`.

Нито една съществуваща настройка не е променена: gateway, secrets, discovery, browser, tools, plugins, hooks, cron, acp, update, telemetry и agents.defaults са идентични (`logs/final-state.log`). При следващите старти hash-ът остава същият (`logs/lifecycle.log`). Повторен `init` след `up` спира с обяснение, че config-ът се различава, и не презаписва нищо. Това е нарочно.

## Работа без мрежа

Gateway-ът не изисква външна мрежа. Това е проверено два пъти:
1. С npm пакета 2026.10.7 в мрежов namespace без мрежа (`unshare -rn`), преди Docker стъпките. Скриптовете и gateway логовете са в `logs/offline-npm/`. Изходът на самите проверки е записан само в сесията, не в лог.
2. В реалния контейнер с `network_mode: none`.

Единственият страничен ефект е редът „remote model catalog refresh failed; next check in 6 hours“.

Всички проверки вървят през `docker compose exec`. Отвън до Gateway-а не стига нищо, затова няма излагане в LAN. Бъдеща връзка от host-а ще изисква bridge мрежа, `127.0.0.1:18789:18789` и `gateway.bind: lan` вътре в контейнера. Това дава и изходящ интернет и е отделно решение (`docs/runbooks/openclaw-docker.md`).

## Модел

Не е конфигуриран provider или API key. В конфигурацията по подразбиране има референция към модел (`agents.defaults.model` → `openai/gpt-6-astra`), но без provider и ключ тя не може да се използва. Gateway-ът се стартира, отговаря на health, status, doctor и audit без модел. Без модел не могат да вървят само agent turns, а за SF-004 такива не са нужни.

## Изолация: какво е доказано и какво не

- **Доказано за контейнера (inspect и listeners):**
  - Няма мрежа. Има само volume-а. Няма host пътища, Docker socket, capabilities и публикувани портове. Root-ът е read-only.
  - Няма достъп до application repositories, до home директорията на оператора, до Claude credentials или до Git repositories.
  - Host exec, elevated, browser, plugins и external skills са изключени в конфигурацията.
- **Не е гарантирано срещу container escape.** Контейнерът е uid 1000 без userns-remap или rootless Docker. На тази машина uid 1000 е `teo`, така че при пробив на kernel или runtime процесът би имал файловите права на `teo`. Премахва се с rootless Docker или `userns-remap`. И двете са промени по Docker daemon-а и не са правени.
- **Достъп чрез Docker:** групата `docker` е root-еквивалентна. `teo` е в нея и може да влезе в контейнера и да прочете token-а и state-а. Това е trust boundary-то на Docker daemon-а.
- **Docker data root:** на тази машина е `/home/teo/docker-data` (`root:root 0710`). Volume-ът не е четим за други локални потребители, а и `teo` получава Permission denied без root. Но `/home/teo` е 0777 без sticky bit, така че всеки локален потребител може да преименува или подмени самия запис `docker-data`. Това е съществуваща находка на машината. Не е поправяна и Software Factory не зависи от поправката ѝ.
- Другите находки на машината от предишните варианти са непроменени и вече не засягат този setup, защото контейнерът не вижда host файлове:
  - `/home/teo` е 0777;
  - Samba guest share покрива `/home/teo`;
  - loopback услугите на host-а.

## Жизнен цикъл и автоматичен старт

Командите за start, stop, restart, status, logs и health са в `docs/runbooks/openclaw-docker.md`. С `restart: "no"` контейнерът **не** се стартира сам след login или reboot. Пуска се ръчно със `docker compose … start`.

Автоматичният старт не е настроен. Той изисква изрично одобрение на `restart: unless-stopped` или на systemd unit.

## Промени в repo-то (без Git операции)

Нови:
- `deploy/openclaw/compose.yaml`
- `scripts/openclaw/sf004-docker.sh`
- `config/openclaw/openclaw.json5`
- `docs/runbooks/openclaw-docker.md`
- `docs/tasks/SF-004-openclaw-bootstrap.md`
- `docs/reports/SF-004-report.md`

Ранните варианти с OS потребител, които не стигнаха до инсталация, са само в `review/SF-004/wizard-v1/` и `wizard-v2/`.

## Ограничения и отворени точки

1. Изолацията не е гарантирана срещу container escape (uid 1000, без userns-remap). Описано по-горе.
2. `security audit --deep` дава 1 warn (`operator.read`). Чисто сдвояване на operator устройство изисква Control UI bootstrap, който тук е изключен.
3. Подписът на image attestation-а не е проверен криптографски (няма `gh` или cosign). Проверени са digest-ът, OCI labels и BuildKit provenance-ът (GitHub Actions, commit `157d8c2b`, версия 2026.10.7).
4. Host скриптът поддържа само Linux. macOS и Docker Desktop не са проверени.
5. Стартът до `healthy` отнема 60–80 s: doctor при старт плюс health интервал от 30 s.

## Code review

Направен е преглед в две оси (стандарти и спецификация) с отделни агенти, след изпълнението.

**Поправени в скрипта:**
- `tokenscan` вече отчита и неуспех при четенето на входа (`cat` или `docker logs`), не само на grep.
- `lifecycle` проверява token-а по inode, mtime и size. За config-а изисква да е валиден, защото doctor легитимно добавя полета, и отчита hash-а.
- Празен или неуспешен резултат от `docker` или `ss` вече не дава `PASS`.
- Docker-group находката вече не минава през pipe.
- Health wait е 300 s и спира, ако контейнерът не работи.

След поправките `verify`, `lifecycle` и `tokenscan` са пуснати отново и пак дават `STEP OK` (вторите секции в логовете).

**Поправени в този отчет:**
- броят на проверките (23, не 24);
- произходът на heartbeat миграцията;
- промените на config-а от doctor;
- референцията към модел;
- липсващите доказателства за PID, Docker root и index.

**Оставени (judgement calls):**
- Портът и image-ът се повтарят в Compose и в скрипта.
- Deny списъкът е и в `gateway.tools`, и в `tools`. Това е defense in depth.
- `exec: { security: "deny", ask: "always" }` е излишно, но безвредно. Промяна в config-а би го разминала с вече инсталирания.

## Източници

- https://docs.openclaw.ai/install/docker, `/install/docker/networking-and-storage`, `/install/docker/environment-variables`. Използвани са копията, включени в пакета 2026.10.7.
- `docker-compose.yml`, `Dockerfile` и `docker-entrypoint.mjs` от `openclaw/openclaw` при commit `157d8c2bc3ea2fa183afdc11088e69690bf8e64e`.
- https://docs.openclaw.ai/gateway/pairing (silent local pairing) и `/cli/gateway/query` (capability `connect-only`).

## Оставащи ръчни стъпки

- Решение за автоматичен старт, ако е нужен.
- Решение за мрежа и канал към медиатора. Отделна задача.
- По желание: rootless Docker или `userns-remap` за затваряне на uid 1000 риска. Това е системна промяна.
