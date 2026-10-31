# Software Factory bridge (SF-001, local-only pilot)

Локален MCP server върху официалния TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0,
`@modelcontextprotocol/node` 2.1.2). Обслужва Streamable HTTP на `http://127.0.0.1:<port>/mcp`
чрез `createMcpHandler` (stateless; протокол 2026-07-28 и stateless fallback за 2025 клиенти).
Слуша само на loopback и проверява Host/Origin с `localhostHostValidation` / `localhostOriginValidation`.
Няма CORS, тунел, LAN listener, автентикация или извикване на LLM API.

## Команди

Изпълняват се от `bridge/` (Node.js >= 24, npm):

| Цел | Команда |
| --- | --- |
| Инсталация | `npm ci` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Стартиране | `npm run build && npm start` |
| MCP smoke проверка | `npm run smoke` (прави build и пуска `node --test`) |
| Спиране | `Ctrl+C` (SIGINT) или `kill -TERM <pid>`; listener-ът се освобождава, exit code 0 |

## Конфигурация

| Променлива | По подразбиране | Описание |
| --- | --- | --- |
| `FACTORY_PORT` | `8787` | TCP порт на `127.0.0.1`. `0` избира свободен порт. При зает порт процесът спира с exit code 1 и съобщение `software-factory-bridge: Port <n> on 127.0.0.1 is already in use. Set FACTORY_PORT to a free port.` |
| `FACTORY_DATA_DIR` | `<repo>/factory-data` | Runtime директория за пробния артефакт (изключена от Git). |
| `FACTORY_REPO_ROOT` | checkout-ът, който съдържа `bridge/` (не зависи от текущата директория) | Root за `factory_read_file` и за `factory-data/apps/` на инструкциите. Разрешава се с `realpath` при старт; ако не съществува или не е директория, процесът спира с exit code 1 и ясна грешка, без fallback. |
| `FACTORY_OPENCLAW_DISPATCH` | `docker` | `docker`: `factory_request_dispatch` ползва Compose проекта от `deploy/openclaw/compose.yaml`. `off`: всеки dispatch завършва като `failed` (`openclaw_unreachable`); ползва се от smoke тестовете. |

Готовността се вижда по реда `software-factory-bridge listening on http://127.0.0.1:<port>/mcp (data dir: ...)`.

## MCP tools

| Tool | Вход | Поведение | Annotations |
| --- | --- | --- | --- |
| `factory_status` | няма (затворен обект) | `{ name, version, mode: "local-only-pilot" }` | readOnly, closed world |
| `factory_write_probe` | `{ message }`: непразен (и не само whitespace) string, ≤ 4096 символа (Unicode code points); други полета се отхвърлят | Заменя `<data dir>/probe.txt`; връща `{ exists, artifact, message, bytes, sha256 }` | destructive (заменя предишната проба), idempotent, closed world |
| `factory_read_probe` | няма (затворен обект) | Връща същата структура или `{ exists: false, artifact: "probe.txt" }` | readOnly, closed world |
| `factory_read_file` | `{ path, offset?, max_bytes? }` (затворен обект) | Чете UTF-8 файл от работното копие на repository-то на страници; вижте по-долу | readOnly, non-destructive, closed world |
| `factory_write_instruction` | `{ app_id, job_id, content, expected_sha256? }` (затворен обект) | Записва Markdown инструкция; вижте по-долу | destructive (заменя при CAS), idempotent, closed world |
| `factory_request_dispatch` | `{ app_id, job_id, instruction_sha256 }` (затворен обект) | Заявява изпращане към OpenClaw; вижте по-долу | non-destructive, idempotent, closed world |

Невалидният вход се отхвърля от SDK валидацията (`isError: true`, "Input validation error") преди tool handler-а,
т.е. преди файлът да бъде докоснат. Записът е през временен файл + `fsync` + `rename`, така че
`probe.txt` винаги е завършен предишен или завършен нов артефакт.

## factory_read_file

Чете текущото работно копие, включително untracked и git-ignored файлове като `review/**`. Git index и HEAD не се използват.

**Вход**
- `path`: относителен път с `/`, до 4096 знака. Отхвърлят се абсолютен път, NUL, backslash и сегмент `..`. Празни и `.` сегменти се нормализират. Не се прави shell expansion или URL decoding.
- `offset`: byte offset, по подразбиране 0. Трябва да е от 0 до размера на файла и да не е във вътрешността на UTF-8 символ.
- `max_bytes`: размер на страницата, по подразбиране 16384, от 4 до 32768.

**Изход:** `{ path, encoding: "utf-8", bytes, sha256, offset, returned_bytes, text, next_offset }`.
- `bytes` и `sha256` се отнасят за целия файл и се връщат на всяка страница.
- Страницата свършва на граница между символи. `next_offset` е `null` на последната страница; при offset точно на EOF текстът е празен.
- Текстът е точно копие на байтовете: BOM, CRLF и финалният newline се запазват.

**Граница на root-а.** Заявеният път се разрешава с `realpath` и трябва да остане в root-а. Сравнението е по сегменти, така че `repo-evil/` не минава за `repo/`. Symlink е разрешен само към допустим файл вътре в root-а.

**Изключения.** Проверяват се и за заявения, и за крайния реален път:
- всеки сегмент `.git`;
- `.env` и `.env.*`, освен `.env.example`, `.env.sample` и `.env.template`;
- `.npmrc`, `.netrc`, `.git-credentials`, `id_rsa`, `id_ed25519`;
- разширения `.key`, `.p12` и `.pfx`.

Това не е общ детектор на тайни.

**Лимити.** Само обикновени файлове. Размерът е до 2 MiB; четенето е ограничено до 2 MiB + 1 байт, дори ако файлът расте. Съдържанието трябва да е валиден UTF-8 без NUL.

**Грешки.** Връща се MCP tool error (`isError: true`) с JSON текст `{ code, message }`. Кодовете са `invalid_path`, `forbidden_path`, `not_found`, `unsupported_type`, `unsupported_content`, `too_large`, `invalid_range` и `read_failed`. Съобщенията не съдържат абсолютни пътища. Вход извън схемата, например непознато поле, се отхвърля от SDK валидацията.

## factory_write_instruction (SF-005)

Записва `factory-data/apps/<app_id>/jobs/<job_id>/instruction.md` под repository root-а. Подробности: `docs/tasks/SF-005-instruction-dispatch.md`.

- `app_id`, `job_id`: 1–64 знака `a-z`, `0-9`, `-`, започват и завършват с буква или цифра. Пътища не се приемат.
- App-ът трябва вече да съществува като директория, създадена от оператора. Job директорията се създава при нужда (0700). Нито една директория по пътя не може да е symlink, а файлът се отваря с `O_NOFOLLOW`.
- `content`: UTF-8 текст до 256 KiB, без NUL и без самотни surrogates, не само whitespace.
- Без `expected_sha256` се създава нов файл (изключително, чрез `link`). Съществуващ файл се заменя само с текущия му sha256 (`rename` на fsync-нат временен файл). Еднакво съдържание връща `unchanged` и не пише нищо.
- След като за job-а има `dispatch.json`, инструкцията е замразена (`dispatched`).
- Изход: `{ path, status: created|updated|unchanged, bytes, sha256 }`.

## factory_request_dispatch (SF-005)

Проверява точния sha256 на инструкцията, записва `dispatch.json` (`requested`) и предава `{request_id, app_id, job_id, instruction_sha256}` на OpenClaw през фиксирани `docker compose exec` команди. `accepted` се връща само ако run записът на OpenClaw automation-а `sf-dispatch-receiver` е `ok` и изходът му потвърждава точно този request. Иначе `failed` с `error`. Резултатът на OpenClaw се пази в `openclaw-receipt.json`. Повторното извикване не създава втора заявка. Подробности: `docs/runbooks/openclaw-dispatch.md`.

Грешки и при двата tool-а: `{ code, message }` с кодове `invalid_id`, `invalid_sha256`, `invalid_content`, `too_large`, `app_not_found`, `not_found`, `forbidden_path`, `conflict`, `dispatched`, `sha256_mismatch`, `dispatch_conflict`, `io_failed`, `internal_error`.

## Файлове

- `src/server.ts`: HTTP listener, Host/Origin защити, регистрация на tools.
- `src/probe-store.ts`: фиксираният пробен артефакт.
- `src/repo-files.ts`: четене на repository файлове (пътища, изключения, страници).
- `src/factory-jobs.ts`: идентификатори, job директории, заключване и атомарен запис.
- `src/instruction-store.ts`: инструкциите (CAS, замразяване).
- `src/dispatch.ts`: `dispatch.json`, състояния и `openclaw-receipt.json`.
- `src/openclaw-channel.ts`: фиксираните docker команди и тълкуването на отговора на OpenClaw.
- `src/main.ts`: CLI вход, env конфигурация, чисто спиране.
- `test/smoke.test.ts`: end-to-end сценарий с официалния MCP client срещу реален процес.
- `test/repo-files.test.ts`: договорът на `factory_read_file` върху временен repo root.
- `test/instruction-store.test.ts`, `test/dispatch.test.ts`, `test/openclaw-channel.test.ts`, `test/dispatch-receiver.test.ts`: договорите на SF-005.
