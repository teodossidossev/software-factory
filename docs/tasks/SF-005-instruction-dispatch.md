# SF-005: Markdown инструкции и първи dispatch към OpenClaw

Изходна задача: `docs/tasks/SF-005-openclaw-dispatch.md`.

## Цел

След изрично одобрение ChatGPT записва Markdown инструкция в медиатора и заявява изпращането ѝ към работещия OpenClaw от SF-004. Резултатът е проверимо потвърждение от самия OpenClaw. Няма интеграция с Claude Code или application repository.

## Решения

1. **Структура.** `factory-data/apps/<app-id>/jobs/<job-id>/{instruction.md, dispatch.json, openclaw-receipt.json}` под repository root-а, така че `factory_read_file` чете същите файлове.
   - `factory-data/` е извън Git.
   - App съществува само ако операторът е създал директорията му. MCP не може да създаде app.
   - `.env` не се чете и не се пише през MCP; deny list-ът от SF-003 вече покрива `.env`.
   - Pilot app: `sf-pilot`, без `.env` и без repository.
2. **`factory_write_instruction`:**
   - създаване само без `expected_sha256` (exclusive `link`);
   - замяна само с текущия sha256 (CAS, атомарен `rename`);
   - еднакво съдържание е no-op;
   - заключване на ниво job в процеса;
   - след dispatch инструкцията е замразена.
3. **`factory_request_dispatch`:**
   - един dispatch на job, с един `request_id` (UUID v4);
   - `dispatch.json` пази `revision` и `attempts`, а опитът се записва преди контакта с OpenClaw;
   - състояния `requested`, `accepted`, `failed`; `stored` е инструкция без dispatch, `completed` не се ползва.
4. **Канал: native command automation на OpenClaw 2026.10.7.**
   - `openclaw cron add --command-argv` е официален payload, който изпълнява процес в Gateway-а без модел.
   - Създаването и ръчният run изискват `operator.admin`. Локалният CLI с gateway token-а го има.
   - Ръчният `cron run` работи и при `cron.enabled: false`, затова scheduler-ът остава изключен, а automation-ът е disabled. **Конфигурацията на OpenClaw не е променена.**
   - Параметрите минават през inbox файл във volume-а: command automation-ът няма входни аргументи при run.
5. **Host relay:**
   - в bridge процеса (`src/openclaw-channel.ts`), не като отделен daemon;
   - три фиксирани `docker` argv-та, без shell, със заявката на stdin;
   - сериализиран, защото един accept run обработва целия inbox.
6. **Доказателство:** run записът на OpenClaw от `cron run --wait` (`cron.runs` историята) със status `ok/succeeded` и изход на receiver-а, който съдържа точния `request_id`.

## Ограничения

- Потвърждението е, че OpenClaw Gateway-ът е изпълнил provision-нат от оператора automation и той е записал заявката. Логиката на приемането е нашият receiver скрипт. OpenClaw удостоверява изпълнението и резултата му, не съдържанието на инструкцията.
- Bridge-ът ползва Docker. Членството на `teo` в групата `docker` е root-еквивалентно (SF-004). Bridge-ът има само фиксирани команди, но процесът му реално има този достъп.
- Само един bridge процес може да пише в `factory-data/apps`. Заключването е в процеса.
- Изолационните ограничения от SF-004 (uid 1000, без userns-remap) остават.

## Етап

Изпълнено на 2026-10-26. Резултатите са в `docs/reports/SF-005-report.md`. Финалното приемане е от ChatGPT след Refresh.

## Review 01 (2026-10-26)

ChatGPT прегледа файловете през `factory_read_file` и прие 27/27 теста и двата live сценария. Поправки:

- **R1: пълна проверка на `dispatch.json`.** `#readRecord` валидира записа със строга zod схема:
  - всички задължителни полета, без непознати;
  - UUID v4, id формати, sha256 и ISO времена.

  Проверяват се и инвариантите по състояние:
  - `app_id` и `job_id` съвпадат с текущия job;
  - `history` отговаря на `attempts`, а всеки опит е съгласуван с изхода си;
  - `accepted` изисква `attempts ≥ 1`, `last_error: null`, receipt и OpenClaw run `ok/succeeded`, а последният опит трябва да е същото приемане;
  - `failed` изисква `last_error`, а `openclaw_not_accepted` изисква и OpenClaw run и receipt.

  `accepted` се връща повторно само ако `openclaw-receipt.json` още доказва приемането: същите идентификатори, `outcome: accepted`, същият run и потвърждение за същата заявка. Всяко нарушение дава `invalid_record`, без контакт с OpenClaw и без презапис. Липсващ `history` (стари записи) се приема като празен масив и нищо друго.
- **R2: строга идемпотентност на receiver-а.** `accept()` сравнява `app_id`, `job_id` и `instruction_sha256` на съществуващия `accepted/<request_id>.json` с новата заявка.
  - `already_accepted` се връща само при пълно съвпадение.
  - Различен payload или нечетим запис дава ред `conflict` и exit 2, без потвърждение. Първоначалното приемане остава непроменено.
  - Отказаният inbox запис се мести в `rejected/` без да презаписва по-стар.
- **R3: преносима проверка на конфигурацията.** Фиксираният `SF004_CONFIG_SHA` е премахнат. `scripts/openclaw/openclaw-config-check.cjs` работи в контейнера и проверява:
  - всяка настройка от `config/openclaw/openclaw.json5` присъства в живата конфигурация със същата стойност (масивите се сравняват точно);
  - допуснати допълнителни ключове са само метаданните на `doctor --fix`: `meta`, `wizard`, `skills.entries.*` = `{enabled:false}`, `agents.entries.*` = `{}`;
  - всичко друго, например `models`, разрешен skill или agent entry с tools, е грешка.

  Security проверките не са отслабени: `config validate`, `doctor --lint` и `security audit` (и `--deep`) остават задължителни.

Receiver-ът във volume-а е обновен през `sf005-dispatch.sh provision` с потвърждение: `b7653bb3…` → `d9a9fea5…`. Automation-ът не е променян.
