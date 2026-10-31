# SF-004: Локален, ограничен OpenClaw Gateway

Изходна задача: `docs/tasks/SF-004-openclaw.md`.

## Цел

Реално инсталиран, стартиран и проверен локален OpenClaw Gateway. Без модел, без интеграция с Claude Code или с application repositories и без излагане извън машината.

## Решения

1. **Подход: Docker** (решение на потребителя от 2026-10-26). Замени два по-ранни варианта, които не стигнаха до инсталация:
   - отделен OS потребител `openclaw` (wizard v1, v2);
   - ACL върху home директорията на оператора.

   Причината: Software Factory трябва да е преносим и да не променя home директории, Samba или съществуващи услуги. Ранните варианти са запазени в `review/SF-004/wizard-v1/` и `wizard-v2/`.
2. **Image:** официален `ghcr.io/openclaw/openclaw:2026.10.7`, фиксиран по index digest `sha256:fb26f0841659dc757f23feec9adeab51f11d76779a409db5d22e191b43841afa`.
   - Provenance-ът на BuildKit сочи GitHub Actions run в `openclaw/openclaw` от commit `157d8c2b`. Това е същият commit като на npm пакета.
   - Docker Hub mirror-ът има същия digest.
   - Подпис на attestation-а не е проверен (няма `gh`/cosign).
3. **Мрежа: `network_mode: none`.** Проверено с 2026.10.7 в мрежов namespace без външна мрежа:
   - Gateway-ът се стартира за около 35 s; `/healthz`, `gateway health` и `gateway status --require-rpc` минават;
   - `security audit --deep` дава 0 critical и 1 warn (`gateway.probe_failed: missing scope operator.read`, понеже shared token не е сдвоено operator устройство);
   - SIGTERM спира чисто, exit 0.

   Всички проверки вървят вътре в контейнера. Не се публикува порт.
4. **Конфигурация:**
   - loopback и token чрез SecretRef към файл във volume-а;
   - изключени: Control UI, operator terminal, CLI agents, HTTP endpoints, browser, plugins, hooks, cron, ACP, mDNS, heartbeat, update checks, telemetry;
   - tools: профил `minimal`, deny за runtime/fs/automation/web/ui/exec; elevated е изключен.
5. **Контейнер:**
   - без host mounts, без Docker socket, не е privileged;
   - `cap_drop: ALL`, `no-new-privileges`, read-only root, `/tmp` е tmpfs;
   - `restart: "no"`, т.е. без автоматичен старт.

## Ограничения, известни преди изпълнението

- Контейнерът работи като uid 1000, без userns-remap. На тази машина това е host потребителят `teo`. Изолацията не е гарантирана срещу container escape.
- Групата `docker` е root-еквивалентна. Всеки с достъп до Docker може да прочете token-а и state-а.
- `read_only: true` с официалния entrypoint (`doctor --fix` при старт) не беше проверен в контейнер преди `up`. При `up` е потвърдено, че работи.

## Етап

Изпълнено на 2026-10-26: `pull`, `init`, `up`, `verify`, `lifecycle` и `tokenscan`, всички със `STEP OK`. Резултатите са в `docs/reports/SF-004-report.md`.
