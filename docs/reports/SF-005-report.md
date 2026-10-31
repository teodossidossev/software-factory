# SF-005 отчет: Markdown инструкции и първи dispatch към OpenClaw

Задача: `docs/tasks/SF-005-openclaw-dispatch.md`. Решения: `docs/tasks/SF-005-instruction-dispatch.md`. Runbook: `docs/runbooks/openclaw-dispatch.md`.

**Етап:** изпълнено и проверено локално на 2026-10-26: реален MCP client, реален bridge и реален OpenClaw 2026.10.7. Review 01 (R1–R3) е поправен и проверен; вижте секция „Review 01“. Финалното приемане през ChatGPT (Refresh, запис, четене, dispatch) предстои.

## Как се записва инструкция

`factory_write_instruction({app_id, job_id, content, expected_sha256?})` записва `factory-data/apps/<app_id>/jobs/<job_id>/instruction.md`.

- **Идентификатори:** само `a-z0-9-`, до 64 знака, без пътища. App-ът трябва да е регистриран от оператора (директорията му съществува). Pilot app е `sf-pilot`, без `.env` и без repository.
- **Създаване** без `expected_sha256`: изключително, чрез временен файл + `fsync` + `link`.
- **Замяна** само с текущия sha256 (CAS), чрез временен файл + `fsync` + `rename`. При остарял sha256 се връща `conflict` и файлът остава.
- **Еднакво съдържание** връща `unchanged` и не пише нищо.
- **Конкурентност:** заключване на ниво job в bridge процеса. Тестът с 4 паралелни замени от един sha256 дава точно една успешна.
- **Отказва:** невалиден id, traversal, symlink по пътя или на файла, NUL, самотни surrogates, празно съдържание, над 256 KiB и непознати параметри (`strictObject`).
- **Връща** `{path, status, bytes, sha256}`, а `factory_read_file(path)` дава същите bytes и sha256.
- Не изпълнява команди и не стартира OpenClaw. Проверено: броят OpenClaw run-ове не се променя.
- След dispatch инструкцията е замразена (`dispatched`).

## Какво действително прави dispatch

`factory_request_dispatch({app_id, job_id, instruction_sha256})`:

1. Чете `instruction.md` само от job директорията и сравнява точния sha256. Липсваща инструкция дава `not_found`, променена дава `sha256_mismatch`. И в двата случая не се създава `dispatch.json`.
2. Създава `dispatch.json` със:
   - `request_id` (UUID v4), `revision`, `attempts`, `state`;
   - `history` с по един запис за всеки опит.

   Опитът се записва **преди** контакта с OpenClaw.
3. Изпълнява три фиксирани `docker compose exec` argv-та, без shell:
   - `receiver.mjs enqueue`, със заявката `{request_id, app_id, job_id, instruction_sha256}` на stdin;
   - `openclaw cron list`;
   - `openclaw cron run <id> --wait`.
4. Записва `openclaw-receipt.json` с действителния run резултат на OpenClaw и с `request_id` като correlation ID.
5. Връща `accepted` или `failed`. Markdown съдържанието не напуска медиатора.

Използван е **native command automation** на OpenClaw 2026.10.7. Той е официален payload `--command-argv`, който изпълнява процес в Gateway-а без модел.
- Automation-ът `sf-dispatch-receiver` е изключен, без delivery и с фиксиран argv `["node","/home/node/.openclaw/sf-dispatch/receiver.mjs","accept"]`. Run-ва се само ръчно с `cron run`.
- Проверено: ръчен run работи и при `cron.enabled: false`.
- **Конфигурацията на OpenClaw не е променена.** `openclaw.json` е със sha256 `364a7516…05af`, същия като след SF-004.
- Не са пипани: `tools.exec`, моделът, Control UI, портовете, mounts.

Bridge-ът проверява преди всеки run, че automation-ът е точно един, disabled и с този argv. MCP caller-ът не може да подаде команда, аргумент, директория или контейнер. Отделен инструмент за създаване на automations няма.

## Кой потвърждава заявката

OpenClaw Gateway изпълнява provision-натия automation. Той записва run-а в собствената си история (`cron.runs` в SQLite state базата) със статус и stdout.
- Receiver-ът (`deploy/openclaw/sf-dispatch-receiver.mjs`, копиран във volume-а) записва `accepted/<request_id>.json` и печата ред `accepted`.
- Bridge-ът връща `accepted` **само** ако:
  - run записът от `cron run --wait` е `ok/succeeded`;
  - записът е за същия automation и run id;
  - изходът му съдържа ред за същите `request_id`, `app_id`, `job_id` и `sha256`.
- Exit 0 на `docker` или `gateway health` не стига.

**Граница:** логиката на приемането е нашият receiver скрипт. OpenClaw удостоверява, че е изпълнил точно този automation, и пази резултата му. Не удостоверява съдържанието на инструкцията и не я изпълнява. Bridge-ът не може да удостовери одобрението на потребителя в ChatGPT: то остава стъпка от workflow-а.

## Как се предотвратява дублиране

- **Един job има един dispatch.** `dispatch.json` се създава изключително, под заключването на job-а.
- **`accepted`** се връща със `replayed: true`, без нов контакт с OpenClaw. Проверено: 3 повторения, 0 нови run-а.
- **`requested` или `failed`** се изпращат отново със същия `request_id`.
  - Receiver-ът пази `accepted/<request_id>.json` и при повторение отговаря `already_accepted` с първоначалното време. Второ приемане няма.
  - Проверено на живо: първият run е грешка, повторният дава `already_accepted`.
- **Доставките са последователни** в bridge процеса, защото един accept run обработва целия inbox.
- **Граница:** заключването важи вътре в един bridge процес. Втори bridge процес върху същото `factory-data` не е поддържан.

## Проверки

| # | Проверка | Как | Резултат |
|---|---|---|---|
| 1 | Създаване и четене на кирилица | live MCP + smoke + unit | PASS |
| 2 | Идентични bytes и SHA-256 | live: 138 B `e19cc5cf…`; smoke и unit с независимо изчислени стойности | PASS |
| 3 | Редакция с правилен SHA-256 | live + unit | PASS |
| 4 | Остарял SHA-256 се отказва без загуба | live + unit, включително 4 паралелни опита | PASS |
| 5 | Невалидни id и опасни пътища | live (`../`, `/tmp/x`, непознат app, непознат параметър, NUL, `.env`), unit (symlinks, размер) | PASS |
| 6 | Записът не стартира OpenClaw | live: броят OpenClaw run-ове е непроменен | PASS |
| 7 | Dispatch на липсваща или променена инструкция | live (`not_found`, `sha256_mismatch`, 0 run-а) + unit | PASS |
| 8 | Повторна заявка без дублиране | live (3 повторения, 0 нови run-а) + unit (паралелни заявки, 1 доставка) | PASS |
| 9 | Реално потвърждение от OpenClaw | live: run `manual:f431a516…:3` `ok/succeeded`, видим в `cron runs`; receipt и запис във volume-а | PASS |
| 10 | Грешка на OpenClaw не е успех | live: чужд невалиден inbox запис кара run-а да завърши с exit 2, а резултатът е `failed/openclaw_not_accepted`; retry → `accepted` със същия `request_id`; unit: недостъпен docker, липсващ или различен automation, run без потвърждение | PASS |
| 11 | Съществуващите tools, Host/Origin и тунелът | smoke (всички SF-001/003 тестове, Host/Origin 403), live `factory_status`, `sf-tunnel.sh check`, tunnel-client PID 337046 е непроменен | PASS локално; MCP call през тунела предстои с ChatGPT |
| 12 | Git index и application repository | `git ls-files -s` е идентичен с началото (`review/SF-005/git-index-check.txt`); application repository не е използван | PASS |

- Тестовете са 27/27 (`npm run smoke`): 5 smoke, 6 instruction store, 4 dispatch, 4 channel, 3 receiver, 5 repo-files. След Review 01 са 30/30 (+1 dispatch, +2 receiver).
- Live проверката (`review/SF-005/live-check.mjs`) е пусната два пъти, преди и след поправките от прегледа: `LIVE CHECK OK`.
- `sf005-dispatch.sh verify`:
  - receiver и automation;
  - scheduler-ът е изключен;
  - `openclaw.json` е непроменен (до Review 01 по sha256, след него с преносима проверка спрямо `config/openclaw/openclaw.json5`) и `config validate` минава;
  - `doctor --lint`: същите 4 находки като в SF-004;
  - `security audit`: 0 critical, 0 warn;
  - `--deep`: 0 critical и познатото 1 warn `gateway.probe_failed`.

Не са повтаряни SF-004 проверките за hardening и lifecycle: контейнерът не е пипан. `final-state.log` потвърждава `network=none`, read-only root, без портове и само volume-а.

## Review 01

ChatGPT прие 27/27 теста и двата live сценария. Поправени са R1–R3; подробности има в `docs/tasks/SF-005-instruction-dispatch.md`.

| # | Поправка | Проверка | Резултат |
|---|---|---|---|
| R1 | Строга zod схема и инварианти по състояние за `dispatch.json`. Записът трябва да е за същия job. `accepted` се връща отново само ако `openclaw-receipt.json` още доказва приемането. Иначе `invalid_record`, без OpenClaw и без презапис. Липсващ `history` се приема само като `[]` | Нов unit regression тест: 14 невалидни записа (сред тях структурно непълен `accepted`), 5 невалидни receipt-а и стар запис без `history`. Реалните 4 приети записа от live run-овете се повтарят през MCP като `accepted/replayed`, без промяна (`logs/review01-replay.log`) | PASS |
| R2 | Receiver-ът потвърждава `already_accepted` само при еднакви `app_id`, `job_id` и `instruction_sha256`. Различен payload или нечетим запис дава `conflict`, exit 2 и първото приемане остава. Отказаните записи не се презаписват | 2 нови unit теста + 1 случай в channel теста. На живо, през реалния OpenClaw automation: run `…:9` е `error/failed`, с ред `conflict`; sha256 на първото приемане е непроменен (`logs/review01-receiver-conflict.log`) | PASS |
| R3 | `SF004_CONFIG_SHA` е премахнат. `scripts/openclaw/openclaw-config-check.cjs` изисква всяка настройка от repo конфигурацията със същата стойност и допуска само метаданните на `doctor --fix` (`meta`, `wizard`, изключени `skills.entries`, празни `agents.entries`) | 12 случая в контейнера върху копия в `/tmp`. Минават живата конфигурация, чужди метаданни и инсталация без метаданни. Отказани са `tools.exec.security`, Control UI, `gateway.bind`, `tools.deny`, `cron.enabled`, model provider, разрешен skill, agent с tools и невалиден `meta` (`logs/config-check-cases.log`). Първото пускане откри грешка в самия checker: правилото за `entries` не допускаше и валидната конфигурация. Поправена е; логът пази и двете пускания | PASS |

След поправките:
- `npm run smoke`: 30/30 (`logs/test-suite-review01.log`);
- `sf005-dispatch.sh verify`: `STEP OK`. Audit-ът е както преди: 0 critical, `--deep` с 1 warn;
- live проверката (трето пускане, `20261026c`): `LIVE CHECK OK`;
- `sf-tunnel.sh check`: OK.

Receiver-ът във volume-а е обновен през `provision` с потвърждение: `b7653bb3…` → `d9a9fea5…`. Automation-ът, конфигурацията на OpenClaw, image-ът, Compose файлът, Docker daemon-ът и host правата не са променяни. Bridge-ът е рестартиран с новия build.

## Какво е проверено локално и какво през ChatGPT

- **Локално:** всичко в таблицата, с официалния `@modelcontextprotocol/client` срещу работещия bridge на `127.0.0.1:8787`, който отговаря и на тунела.
- **През реален ChatGPT MCP call:** още нищо за SF-005. Нужни са Refresh на connector-а, запис, четене и dispatch от ChatGPT. Bridge-ът е рестартиран с новите tools, а тунелът работи непроменен.

## Code review

Прегледът е с два отделни агента: стандарти и спецификация. Поправено:
- **Абсолютни пътища:** можеха да изтекат от docker stderr в `dispatch.json` и в MCP резултата. Сега docker се пуска в repository root-а с относителен compose път, а диагностиката маха пътищата. Добавен е тест.
- **Липсващ handler на stdin:** EPIPE можеше да спре bridge-а.
- **Лимитът за изход:** броеше символи, а не bytes, и декодираше на парчета. Сега е `setEncoding`, а лимитът е преименуван.
- **Невалидиран `dispatch.json`:** вече се валидира; повреден запис дава `invalid_record`.
- **Губене на доказателство при retry:** receipt-ът на неуспешен опит се презаписваше. Сега `dispatch.json.history` пази всеки опит, с OpenClaw run id и грешка, а receipt-ът носи номера на опита.
- **`sf005-dispatch.sh`:**
  - `provision` спираше безмълвно, ако listing-ът не успее;
  - usage показваше един ред повече;
  - копирането на receiver-а беше без `sync`.
- **Дребни:**
  - zod схемите вече ползват същите regex-и като store-а;
  - премахнат е hard-coded `instruction.md`;
  - тестовите променливи вече не засенчват `before`/`after`.

Приети, без промяна:
- Заключването е в процеса (документирано).
- Receiver-ът дублира id regex-ите, защото работи отделно в контейнера.
- `stored` не се записва като поле: това е инструкция без `dispatch.json`.
- Тези неща не са изрично поискани, но са оставени:
  - замразяването след dispatch;
  - задължителната регистрация на app;
  - `FACTORY_OPENCLAW_DISPATCH=off` за smoke тестовете.
- Timeout след реално приемане се записва като `failed`, а retry-ят го поправя чрез `already_accepted`.

## Ограничения

- Изолацията на контейнера е като в SF-004: uid 1000 = `teo`, без userns-remap. **Не е гарантирана срещу container escape.**
- Bridge-ът вика Docker. Членството на `teo` в групата `docker` е root-еквивалентно, така че процесът реално има този достъп, макар да ползва само фиксирани команди.
- `accepted` означава „приет от OpenClaw“, а не изпълнен. `completed` не се ползва.
- Bridge-ът е рестартиран (нов PID в `final-state.log`), за да зареди новите tools. Не е настроен автоматичен старт.

## Какво е нужно за интеграция с Claude Code

- Execution adapter, който чете приети заявки и стартира Claude Code. Решения, които предстоят:
  - извън контейнера, защото контейнерът няма repository и мрежа;
  - кой процес и как чете `.env` на приложението с пътя към repository-то.
- Състояние `completed` или `failed` от реалното изпълнение, с отделно доказателство, а не от receipt-а за приемане.
- Механизъм, който consume-ва `accepted/` записите във volume-а (за момента само се натрупват), и политика за почистването им.
- Ако е нужен повече от един bridge процес: заключване между процеси.

## Отворени точки

- Приемане през ChatGPT след Refresh.
- Почистване на тестовите job-ове `live-*` в `factory-data/apps/sf-pilot` и на receiver записите във volume-а, ако не са нужни като доказателство.
- Подписът на image attestation-а все още не е проверен (от SF-004).
