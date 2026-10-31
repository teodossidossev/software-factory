# SF-003: четене на repository файлове през Software Factory

- Дата: 2026-10-25, Europe/Sofia
- Изпълнител: Claude Code (Claude Opus 5.5), локално инсталираният `/implement` skill, с `/tdd` (red→green на два seam-а)
- Задача: `docs/tasks/SF-003-read-files.md`
- Git: по време на SF-003 Claude не е изпълнявал staging, unstaging, commit или push и index-ът остана непроменен. След това, по изрична молба на потребителя, `git rm -r --cached .idea` махна шестте `.idea/` записа от index-а; файловете остават на диска, а `/.idea/` е в `.gitignore`. Други промени в index-а няма (`review/SF-003/git-index-check.txt`).

## 1. Достигнат етап

**Локално готово; очаква Refresh и четене от ChatGPT.**

- `factory_read_file` е имплементиран и тестван локално: typecheck exit 0, smoke 9/9.
- Bridge-ът е рестартиран с новия build. Реалният MCP client вижда четири tools и чете файлове от repository-то.
- Tunnel-client работи без рестарт и е здрав (readyz, control-plane poll).

ChatGPT още **не** е извикал `factory_read_file`. Оставащата стъпка е Refresh на plugin-а и ново четене (т. 7). Code review на SF-002 и SF-003 през инструмента още **не** е правено.

## 2. Референтен файл за независимата сверка

| Файл | bytes | SHA-256 (локално, `wc -c` / `sha256sum`) |
| --- | --- | --- |
| `scripts/sf-tunnel.sh` | **4257** | **`1d979f274193eed1d487de8637df9ecc17fde09960d7c485937e74ec9cd33435`** |
| `review/SF-002/new-files.md` | 54184 | `0415dec6e7b829f95b6eda4d9ead2fee8559e73306287cdc64feb85bf431f195` |

`scripts/sf-tunnel.sh` не е променян в SF-003: хешът съвпада с началния snapshot.

Локален MCP прочит на рестартирания bridge (`review/SF-003/logs/local-mcp-check.log`):
- `scripts/sf-tunnel.sh`: една страница, 4257 bytes, същият SHA-256.
- `review/SF-002/new-files.md`: 4 страници по 16384 bytes по подразбиране, общо 54184 bytes, един SHA-256 на всички страници.

Тези два файла могат да се променят по-късно. Сверката важи за състоянието към този отчет.

## 3. Какво е променено

Нови файлове:
- `bridge/src/repo-files.ts` (229 реда): модулът за четене. Съдържа `resolveRepoRoot` и `RepoFiles.read`, нормализацията и границата на пътя, изключенията, ограниченото четене, UTF-8 проверката, страниците и `RepoReadError` с кодове.
- `bridge/test/repo-files.test.ts` (246 реда): договорът върху временен repo root с `git init`, `.gitignore` за `review/` и фиктивно съдържание.
- `docs/reports/SF-003-report.md`: този отчет.

Променени файлове:

| Файл | Промяна |
| --- | --- |
| `bridge/src/server.ts` | +64/−3: регистрация на `factory_read_file` (input/output schema, annotations, tool error), `repoRoot` в `BridgeOptions`. Transport, guards и R1 не са пипани. |
| `bridge/src/main.ts` | +13/−3: `FACTORY_REPO_ROOT` с default корена на checkout-а (изведен от `import.meta.url`), ясна грешка без fallback, root в реда за готовност. |
| `bridge/test/smoke.test.ts` | +55/−6: временен repo root за процеса, очакване за 4 tools, нов MCP тест за `factory_read_file`. |
| `bridge/README.md` | +23: договор, root, лимити, изключения, грешки. |
| `docs/runbooks/chatgpt-connection.md` | +5: раздел „Refresh след нов или променен tool“. |
| `docs/reports/SF-002-report.md` | +4: доказателствено уточнение за двете проби (по §8). |
| `docs/tasks/SF-003-read-files.md` | добавена секция с резултата |

Общо 10 авторски файла: 3 нови и 7 променени. Това е с един над ориентира 6–9, заради изискваното уточнение в SF-002 отчета. Без промени са dependencies, lockfile, `probe-store.ts`, тунелът и профилът.

## 4. Проверки

Логовете са в `review/SF-003/logs/`. Командите са от `bridge/`, освен ако не е посочено друго.

| # | Команда | Exit | Резултат | Лог |
| --- | --- | --- | --- | --- |
| 1 | `npm run typecheck` | 0 | без грешки | `typecheck.log` |
| 2 | `npm run smoke` (build + `node --test dist/test/*.test.js`) | 0 | 9 tests, 9 pass, 0 fail | `smoke.log`, `summary.txt` |
| 3 | Временен MCP client срещу рестартирания bridge (скриптът е изтрит след проверката) | 0 | 4 tools; `scripts/sf-tunnel.sh` и `review/SF-002/new-files.md` съвпадат с `wc`/`sha256sum`; `.git/config` → `forbidden_path` | `local-mcp-check.log` |
| 4 | `tunnel-client health --port 8790 --require-control-plane-poll` | 0 | Readyz PASS, control-plane poll PASS | (горе, без отделен лог) |

`npm ci` не е пускан, защото dependencies са без промяна.

Red→green по слайсове:
- Слайс 1 падна, защото модулът липсваше.
- Слайс 3 падна на `offset: -1`.
- Слайс 4 падна, защото празният път четеше директорията на root-а.
- Слайс 6 в smoke падна, защото инструментът не беше регистриран.
- Слайсове 2 и 5 минаха веднага след имплементацията от предишния слайс. За слайс 5 направих мутационна проверка: при изключено правило за `.git` в `dist` тестът пада (4 pass / 1 fail), след възстановяване е 5/5.

Покритие на §5 от задачата:

1. **Успешен прочит.** Source, untracked, ignored `review/SF-002/MANIFEST.md` и примерният config дават точни text, bytes и SHA-256; очакваните стойности са от Python `hashlib`. Има случай с BOM, кирилица, emoji и CRLF и файл без финален newline.
2. **Страници.**
   - `a😀b` с `max_bytes` 4 дава `a` | `😀` | `b`, с `next_offset` 1 → 5 → `null`.
   - Ред от около 100 KB без newline и смесен низ се сглобяват байт по байт при `max_bytes` по подразбиране, 32768, 16383, 4, 5 и 7. SHA-256 е един и същ на всички страници.
3. **Празен файл, EOF и лоши входове.**
   - Празен файл и offset точно на EOF дават празен текст и `next_offset: null`.
   - Offset извън файла, вътре в символ, отрицателен или дробен, както и `max_bytes` 3, 32769 и 4.5, дават `invalid_range`.
   - Latin-1 и NUL дават `unsupported_content`.
   - Файл от точно 2 MiB се чете; 2 MiB + 1 дава `too_large`.
4. **Път и symlink-и.**
   - Празен път, абсолютен път (включително абсолютният host път на фикстурата), `..`, `a/../b`, backslash, NUL и над 4096 знака дават `invalid_path`.
   - Symlink извън root-а, към sibling директорията `repo-evil` или през директория-symlink извън root-а, както и alias към `.env`, дават `forbidden_path`.
   - Вътрешен symlink към source файл се чете, като се връща заявеният път.
5. **Изключения и липсващи файлове.**
   - Отказват се `.git/config`, `.git/HEAD`, вложен `.git`, `.env`, `.env.local`, `.env.production`, `.npmrc`, `.netrc`, `.git-credentials`, `id_rsa`, `id_ed25519`, `.key`, `.P12` и `.pfx` (фиктивни файлове).
   - `.env.example`, `.env.sample`, `.env.template` и `.gitignore` се четат.
   - Липсващ файл и файл под файл дават `not_found`; директория и FIFO дават `unsupported_type`.
   - Съобщенията за грешки не съдържат абсолютния път на временната директория.
6. **Реален MCP client.**
   - Точно 4 tools; annotations `{readOnlyHint: true, destructiveHint: false, openWorldHint: false}`.
   - Успешният прочит връща еднакви `structuredContent` и JSON текст.
   - `../outside.txt` дава `isError: true` с код `invalid_path`, без host пътя.
   - Непознато поле, `max_bytes: 3` и липсващ `path` се отхвърлят.
   - Процесът остава жив и `factory_status` работи.
   - Невалиден `FACTORY_REPO_ROOT` спира процеса преди старт със съобщение „does not exist“.
   - Предишните тестове (probe, рестарт, loopback, Host/Origin, R1) минават без промяна.

## 5. Жизнен цикъл на процесите

**Bridge.**
- Старият процес (PID 328937, стартиран в SF-002) е идентифициран по команда и директория и спрян с SIGTERM. Спря с exit 0 и порт 8787 се освободи.
- Първият опит за ново стартиране падна, преди да тръгне Node: относителното пренасочване на лога сочеше към несъществуващ път. Вторият опит, с абсолютни пътища, работи.
- Сега bridge-ът е PID 353752, `127.0.0.1:8787`, `repo root: /home/teo/IdeaProjects/software-factory`. Логът е в `review/SF-003/logs/bridge-run.log`.

**Tunnel-client.** PID 337046, стартиран в SF-002, не е рестартиран и остава здрав.

И двата процеса са фонови процеси на тази Claude Code сесия, а не видими IntelliJ терминали. Командите за видими терминали и за рестарт са в `docs/runbooks/chatgpt-connection.md`.

## 6. Ограничения

- **Изключенията са тесни.** Списъкът е според задачата и не е детектор на тайни. Всеки друг текстов файл в repository-то, включително review пакетите, е четим за ChatGPT през plugin-а.
- **Конкурентни промени.** Няма защита срещу локален процес, който подменя файлове между проверката на пътя и отварянето. Отварянето е с `O_NOFOLLOW` върху вече разрешения път; по задание не се строи повече.
- **Без snapshot.** Ако файлът се промени между страниците, SHA-256 се сменя и ChatGPT трябва да започне отначало.
- **Цена на страница.** Всяко извикване чете и хешира целия файл (до 2 MiB), за да са `bytes` и `sha256` от същия buffer.
- **Само четене.** Няма listing или search: ChatGPT трябва да знае пътя.

## 7. Оставаща стъпка (ChatGPT)

1. Отвори https://chatgpt.com/plugins, избери **Software Factory** и натисни **Refresh**.
2. Провери, че се виждат `factory_status`, `factory_write_probe`, `factory_read_probe` и `factory_read_file`.
3. Отвори нов Work чат с `@Software Factory` и прочети:
   1. `review/SF-002/MANIFEST.md`;
   2. `review/SF-002/new-files.md` до `next_offset: null`, със същия SHA-256 на всички страници;
   3. `scripts/sf-tunnel.sh` изцяло.
4. Сравни bytes и SHA-256 на `scripts/sf-tunnel.sh` с т. 2 от този отчет, прочетен през същия инструмент.

## 8. Explain yourself

**Какво може ChatGPT.** Да чете точните байтове на UTF-8 текстови файлове до 2 MiB от работното копие на това repository, включително untracked и ignored `review/**`, на страници до 32 KiB. Не може да чете `.git`, изброените credential-подобни файлове, файлове извън root-а или бинарни файлове. Не може да пише, изброява или търси.

**Как се разрешава пътят.**
1. Root-ът се фиксира при старт: `FACTORY_REPO_ROOT` или checkout-ът на bridge-а, през `realpath` и проверка, че е директория.
2. Заявеният път минава синтактична проверка: относителен, без `..`, NUL и backslash.
3. Проверяват се изключенията.
4. Пътят се разрешава с `realpath`.
5. Проверява се, че резултатът е вътре в root-а чрез `path.relative`, тоест по сегменти, а не по префикс на низ.
6. Изключенията се проверяват повторно за реалния път, което хваща symlink alias-и.
7. Остават само обикновени файлове: `stat` преди отварянето и `fstat` след него.

**Как работят страниците.**
- Целият файл се чете ограничено, до 2 MiB + 1 байт, и се валидира като UTF-8 без NUL.
- `bytes` и `sha256` се изчисляват от този buffer.
- Страницата започва на граница между символи (иначе `invalid_range`) и свършва на най-близката граница, която не надвишава `max_bytes`.
- `next_offset` сочи следващия байт или е `null` в края.

**Какво остава.**
- Refresh и реално четене от ChatGPT.
- Code review на SF-002 и SF-003 през инструмента.
- В следващи задачи: listing/search, Git diff tool, запис на task файлове.

## 9. Предложение за ръчен Git

- Branch: `sf-003-read-files`
- Commit/MR заглавие: `SF-003: add factory_read_file for read-only repository review over MCP`
- MR описание:

  ```text
  Adds factory_read_file to the local bridge so ChatGPT can review repository files
  (working tree, including untracked and ignored review/**) through the private tunnel.

  - bridge/src/repo-files.ts: root fixed at startup (FACTORY_REPO_ROOT or the checkout),
    segment-based containment via realpath, symlink-aware deny list (.git, .env*, key files),
    bounded 2 MiB read, strict UTF-8, byte-offset pages on character boundaries, stable error codes
  - bridge/src/server.ts, main.ts: tool registration (read-only annotations, output schema), root wiring
  - tests: repo-files contract tests + MCP smoke (4 tools, success/error, process stays up)
  - docs: bridge README, runbook Refresh steps, SF-003 report, SF-002 evidence note

  Checks: typecheck exit 0, smoke 9/9. Dependencies unchanged.
  Note: include working-tree versions of bridge/src/server.ts and bridge/test/smoke.test.ts;
  the index holds older staged copies (pre SF-001 R1).
  ```

Done остава потвърденият ръчен push.
