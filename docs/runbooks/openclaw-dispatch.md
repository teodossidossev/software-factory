# Instruction dispatch към OpenClaw (SF-005)

Как ChatGPT записва Markdown инструкция в медиатора и заявява изпращането ѝ към локалния OpenClaw от SF-004. Изпълнение (Claude Code, application repository) все още няма.

## Поток

1. Потребителят одобрява текста в ChatGPT. ChatGPT вика `factory_write_instruction` и получава `path`, `bytes` и `sha256`.
2. По желание ChatGPT проверява с `factory_read_file(path)`, че sha256 съвпада.
3. Потребителят изрично разрешава старта. ChatGPT вика `factory_request_dispatch(app_id, job_id, instruction_sha256)`.
4. Bridge-ът:
   - проверява sha256 на инструкцията;
   - записва `dispatch.json` (`requested`);
   - пуска три фиксирани `docker compose exec` команди (вижте по-долу);
   - връща `accepted` или `failed`.

Bridge-ът **не може** да удостовери одобрението в ChatGPT. То е стъпка от workflow-а, а не проверка, която bridge-ът прави.

## Файлове на медиатора

```text
factory-data/apps/<app-id>/
├── .env                      само за оператора; не се чете и не се пише от ChatGPT
└── jobs/<job-id>/
    ├── instruction.md        каноничната инструкция (0600)
    ├── dispatch.json         request_id, revision, attempts, state, last_error, openclaw
    └── openclaw-receipt.json резултатът на OpenClaw run-а, с correlation request_id
```

`factory-data/` е в `.gitignore`. Приложение се регистрира, като операторът създаде директорията му:

```bash
mkdir -m 700 -p factory-data/apps/<app-id>
```

За SF-005 е регистриран само фиктивният `sf-pilot`, без `.env` и без repository.

## Канал към OpenClaw

Контейнерът остава както в SF-004:
- `network_mode: none`, без портове, без host mounts и без Docker socket;
- без модел, без промени в `openclaw.json` и с изключен scheduler (`cron.enabled: false`).

OpenClaw частта е еднократна. Тя слага файл във volume-а и добавя един **изключен** command automation:

```bash
scripts/openclaw/sf005-dispatch.sh provision   # пита y/N; повторното пускане не прави нищо
scripts/openclaw/sf005-dispatch.sh verify      # задължителни проверки (вкл. преносима проверка на openclaw.json)
scripts/openclaw/sf005-dispatch.sh history     # run history и приетите заявки (read-only)
```

- `receiver.mjs` е копие на `deploy/openclaw/sf-dispatch-receiver.mjs` в `/home/node/.openclaw/sf-dispatch/`.
- Automation-ът `sf-dispatch-receiver` има:
  - argv `["node","/home/node/.openclaw/sf-dispatch/receiver.mjs","accept"]`;
  - статус disabled и без delivery;
  - timeout 30 s.

При всеки `factory_request_dispatch` bridge-ът изпълнява само тези команди. Аргументите са фиксирани; данните от заявката са валидирани и минават през stdin:

| # | Команда (след `docker compose -f deploy/openclaw/compose.yaml -p software-factory-openclaw exec -T gateway`) | Какво прави |
|---|---|---|
| 1 | `node /home/node/.openclaw/sf-dispatch/receiver.mjs enqueue` със stdin `{request_id, app_id, job_id, instruction_sha256}` | валидира и записва `inbox/<request_id>.json` |
| 2 | `node openclaw.mjs cron list --all --json` | намира точно един `sf-dispatch-receiver`: disabled, с очаквания argv |
| 3 | `node openclaw.mjs cron run <id> --wait --wait-timeout 60s --json` | OpenClaw Gateway изпълнява automation-а и записва run-а в своята история |

Състоянието става `accepted` само ако run-ът е `ok/succeeded` и изходът му съдържа ред `accepted` или `already_accepted` за същите `request_id`, `app_id`, `job_id` и `sha256`. Exit 0 на `docker` или `gateway health` не е достатъчен.

Markdown съдържанието не напуска медиатора. Командите не минават през shell и MCP caller-ът не може да подаде команда, аргумент, директория или име на контейнер.

## Състояния и повторения

| Състояние | Значение |
|---|---|
| `stored` | `instruction.md` съществува; няма `dispatch.json` |
| `requested` | `dispatch.json` е записан; изпращането е започнало или е прекъснато |
| `accepted` | OpenClaw е изпълнил receiver automation-а и той е потвърдил заявката |
| `failed` | `openclaw_unreachable` (няма OpenClaw run) или `openclaw_not_accepted` (има run, но не е успешен или не потвърждава заявката) |
| `completed` | не се използва в SF-005 |

- Един job има най-много един dispatch с един `request_id`.
- `accepted` се връща без нов контакт с OpenClaw (`replayed: true`).
- `requested` или `failed` се изпраща отново със **същия** `request_id`. Receiver-ът пази `accepted/<request_id>.json`.
  - При повторение със същия payload отговаря `already_accepted`, без второ приемане.
  - При същия `request_id` с различен payload отговаря `conflict` и exit 2; първото приемане остава непроменено.
- Невалиден или непълен `dispatch.json`, или `accepted` без съвпадащ `openclaw-receipt.json`, дава `invalid_record`, без контакт с OpenClaw и без презапис. Поправката е ръчна, след преглед.
- След dispatch инструкцията е замразена.
- Dispatch-ите се изпълняват един по един в bridge процеса. Bridge-ът е единственият писател на `factory-data/apps`.

## Диагностика

```bash
scripts/openclaw/sf005-dispatch.sh history
C="docker compose -f deploy/openclaw/compose.yaml -p software-factory-openclaw"
$C exec gateway node openclaw.mjs cron runs --all --limit 20
```

Отхвърлените inbox записи (невалидни или `conflict`) отиват в `/home/node/.openclaw/sf-dispatch/rejected/`, а run-ът завършва с exit 2. По-стар запис със същото име не се презаписва. Махането на канала е ръчно: `openclaw cron rm <id>` и изтриване на `sf-dispatch/` във volume-а. Скриптът никога не трие.
