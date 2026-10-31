# OpenClaw Gateway в Docker (SF-004)

Ограничен локален OpenClaw Gateway за Software Factory. Не изисква промени по home директории, Samba, SSH, firewall или други системни услуги. Не съдържа модел, канали или достъп до application repositories.

## Какво се създава

| Ресурс | Име | Бележка |
|---|---|---|
| Image | `ghcr.io/openclaw/openclaw:2026.10.7@sha256:fb26f084…1afa` | официален, фиксиран по index digest |
| Volume | `software-factory-openclaw_home` | `/home/node` в контейнера: config, token, state |
| Container | `software-factory-openclaw-gateway-1` | `restart: "no"` |

Файлове в repo-то:
- `deploy/openclaw/compose.yaml`: Compose конфигурацията.
- `config/openclaw/openclaw.json5`: конфигурацията на OpenClaw, копирана еднократно във volume-а.
- `scripts/openclaw/sf004-docker.sh`: стъпки и проверки.

## Предпоставки

- Linux host с Docker Engine и Compose v2 plugin. `scripts/openclaw/sf004-docker.sh` поддържа само Linux: ползва `getent`, `ss` и GNU `sha256sum`. Проверен е на Linux Mint 22.3 с Docker Engine 29.1.3 и Compose 2.24.6. macOS и Docker Desktop не са проверени и не се поддържат.
- Потребител, който може да изпълнява `docker`.
- x86_64 или arm64.
- Мрежов достъп до `ghcr.io` само за стъпката `pull`.

Ако Docker липсва, инсталирай го по официалната документация на Docker за твоята дистрибуция. Software Factory не го инсталира и не променя конфигурацията на daemon-а.

## Стъпки

```bash
scripts/openclaw/sf004-docker.sh preflight   # read-only
scripts/openclaw/sf004-docker.sh pull        # изтегля фиксирания image
scripts/openclaw/sf004-docker.sh init        # token + config във volume-а
scripts/openclaw/sf004-docker.sh up          # стартира и чака healthy
scripts/openclaw/sf004-docker.sh verify      # задължителни проверки
scripts/openclaw/sf004-docker.sh lifecycle   # stop, start, restart
scripts/openclaw/sf004-docker.sh tokenscan   # token-ът не е в логовете
```

Всяка стъпка, която променя нещо, показва какво ще направи и пита `y/N`. `init` не създава volume преди потвърждението. Повторното ѝ пускане след частичен неуспех е безопасно:
- създава само липсващото;
- не изтрива и не подменя съществуващ token или `openclaw.json`;
- спира с обяснение, ако съществуващ файл не е валиден или се различава от `config/openclaw/openclaw.json5`.

След първия `up` entrypoint-ът (`doctor --fix`) добавя полета в `openclaw.json`. Затова повторен `init` след `up` спира с „differs“. Това е очаквано: `init` е нужен само веднъж. Логовете са в `${XDG_STATE_HOME:-~/.local/state}/software-factory/openclaw/logs`. Може да се смени със `SF_OPENCLAW_LOG_DIR`. Стъпка с неуспешна задължителна проверка завършва с `STEP FAILED` и exit 1.

## Източници

- https://docs.openclaw.ai/install/docker и подстраниците `networking-and-storage` и `environment-variables`.
- `docker-compose.yml`, `Dockerfile` и `docker-entrypoint.mjs` от `openclaw/openclaw` при commit `157d8c2b`.

## Ежедневни команди

```bash
C="docker compose -f deploy/openclaw/compose.yaml -p software-factory-openclaw"
$C start                     # старт на съществуващия контейнер
$C stop                      # нормално спиране (SIGTERM, drain до 315 s)
$C restart
$C ps                        # статус и health
$C logs --tail 100 gateway
$C exec gateway node openclaw.mjs gateway health
$C exec gateway node openclaw.mjs gateway status --require-rpc
$C exec gateway node openclaw.mjs security audit --deep
$C exec gateway node openclaw.mjs doctor --lint
$C down                      # маха контейнера; volume-ът остава
```

Не изпълнявай `down -v`: то трие volume-а със state и token-а.

## След login или reboot

С `restart: "no"` контейнерът не се стартира сам, и това е нарочно. След reboot го пусни ръчно със `$C start` или `scripts/openclaw/sf004-docker.sh up`.

Автоматичен старт изисква изрично одобрение и е една от двете промени:
- `restart: unless-stopped` в Compose файла. Тогава контейнерът тръгва при всеки старт на Docker daemon-а, ако не е бил спрян ръчно.
- Отделен systemd unit. Това е системна промяна.

## Мрежа и действителен достъп

- `network_mode: none`: контейнерът има само собствен loopback. Няма изходящ достъп (интернет, LAN, host) и няма входящ.
- Gateway-ът слуша на `127.0.0.1:18789` и `[::1]:18789` **вътре** в контейнера. До него стигат само процеси в същия контейнер, т.е. `docker compose exec`. Не се публикува порт на host-а, затова няма излагане в LAN.
- Проверено с версия 2026.10.7 в namespace без мрежа:
  - стартира се и `/healthz`, `gateway health` и `gateway status --require-rpc` минават;
  - `security audit --deep` дава 0 critical;
  - единственият страничен ефект е лог „remote model catalog refresh failed“ на всеки 6 часа.
- Бъдеща връзка от host-а (не е част от SF-004) изисква `gateway.bind: lan` вътре в контейнера и `ports: ["127.0.0.1:18789:18789"]`. Двете вървят само върху bridge мрежа, а Docker bridge мрежа дава и изходящ интернет. `internal: true` мрежа не публикува портове. Тази промяна изисква отделно решение.

> **SF-005-UI note:** an optional Dashboard profile enables the Control UI at `http://127.0.0.1:18789/` on this host, without changing anything in this section. The container keeps `network_mode: none` and no published port. A host-loopback forwarder relays through `docker compose exec`. See `docs/runbooks/openclaw-dashboard.md`. The offline profile described here is still `config/openclaw/openclaw.json5` and is restored with `scripts/openclaw/sf005-dashboard.sh disable`.

## Граници на изолацията

- **Файлове:** само volume-ът `software-factory-openclaw_home`. Няма host mounts и няма Docker socket.
- **Процес:**
  - root файловата система е read-only;
  - всички capabilities са махнати и е включено `no-new-privileges`;
  - не е privileged;
  - лимити: `pids_limit` 512, `mem_limit` 2g.
- **UID:** контейнерът работи като `node` (uid 1000) от официалния image. Без userns-remap или rootless Docker това е същият uid като на host потребител 1000, а на тази машина той е `teo`. При пробив на kernel или runtime процесът би имал правата на този потребител. Затова **изолацията не е гарантирана срещу container escape**. Rootless Docker или `userns-remap` премахват това, но са промени по Docker daemon-а и Software Factory не ги прави.
- **Управление:** всеки, който може да изпълнява `docker` на host-а, може да влезе в контейнера и да прочете token-а. Членството в групата `docker` е root-еквивалентно.
- **Token:** генерира се вътре във volume-а (0600) и не излиза от него. `gateway auth-token` не се използва.
