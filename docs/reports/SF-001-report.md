# SF-001: отчет за ревю

- Дата: 2026-10-25
- Изпълнител: Claude Code (модел според средата: Claude Opus 5.5, `claude-opus-5-5`)
- Execution skill: `/implement` (потребителски skill), с `/tdd` за red→green цикъла и `/code-review` за ревюто
- Git: Claude не е изпълнявал staging, commit или push. Между SF-001 и Review 01 файловете в `.idea/` и `bridge/`, както и `.gitignore`, са били staged извън Claude (от потребителя или IDE). Те са оставени така; вижте допълнението за Review 01.

## 1. Резултат

Работи локален MCP bridge (`bridge/`). Той е изграден върху официалния TypeScript SDK v2 и Streamable HTTP. Слуша само на `127.0.0.1` на път `/mcp`, по подразбиране на порт 8787. Има три tools: `factory_status`, `factory_write_probe` и `factory_read_probe`. Записът и прочитането на пробния артефакт са проверени през официалния MCP client, включително след рестарт на процеса. Typecheck, build и smoke минават с exit code 0.

Това **не** доказва връзка с ChatGPT, MCP Events или управление на Claude. Вижте т. 7.

## 2. Как работи

- `bridge/src/server.ts`: `node:http` server, вързан изрично на `127.0.0.1`.
  - Преди всяко routing заявката минава през `localhostHostValidation()` и `localhostOriginValidation()` от `@modelcontextprotocol/node`. При невалиден Host или Origin отговорът е 403.
  - Request target-ът се парсва с `URL.parse`. Непарсваем target, като `//` или `//[`, получава HTTP 400 и процесът продължава да работи (Review 01, R1).
  - Само `/mcp` се подава на `toNodeHandler(createMcpHandler(factory))`. Всичко друго връща 404. Няма CORS и няма `/health`, защото не е необходим: готовността се съобщава с ред в stdout.
  - `createMcpHandler` създава нов `McpServer` за всяка заявка (stateless). Сървърът обслужва протокол 2026-07-28 и, чрез вградения stateless fallback на SDK-то, 2025-ера клиенти.
  - При зает порт хвърля `PortInUseError`. `close()` затваря MCP handler-а и HTTP listener-а.
- `bridge/src/probe-store.ts`: единствен фиксиран артефакт `<FACTORY_DATA_DIR>/probe.txt`, UTF-8, с права 0600.
  - Записът минава през временен файл в същата директория, после `fsync` и `rename`. Така файлът винаги е или завършеният стар, или завършеният нов артефакт.
  - При липса на артефакта `read()` връща `undefined`, без грешка.
  - Отговорът съдържа `bytes` и `sha256`, за да може съдържанието да се провери.
- `bridge/src/main.ts`:
  - Чете `FACTORY_PORT` (по подразбиране 8787) и `FACTORY_DATA_DIR` (по подразбиране `<repo>/factory-data`, изключена от Git).
  - Отпечатва ред за готовност и при SIGINT/SIGTERM спира чисто с exit code 0.
  - При зает порт изписва ясна грешка и излиза с exit code 1, без да пипа други процеси.
- Tool договор:
  - **Input.** Всички tools ползват `z.strictObject`, тоест `additionalProperties: false`. Аргумент като `path` се отхвърля.
    - `message` трябва да е string с дължина 1–4096 символа. Zod 4.6.7 брои Unicode code points, което тестът проверява с 4096 и 4097 емоджита.
    - Само whitespace се отхвърля. Това е съзнателно затягане спрямо „непразен string“.
    - Невалидният вход се отхвърля от SDK валидацията преди handler-а. Резултатът е `isError: true` с текст „Input validation error“.
  - **Output schema.** `{ exists: boolean, artifact: "probe.txt", message?, bytes?, sha256? }`.
  - **Annotations:**

    | Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
    | --- | --- | --- | --- | --- |
    | `factory_status` | true | – | – | false |
    | `factory_write_probe` | false | true (заменя предишната проба) | true | false |
    | `factory_read_probe` | true | – | – | false |

## 3. Repository baseline (преди промените)

- Root: `/home/teo/IdeaProjects/software-factory`, branch `main`.
- **Unborn repository**: няма HEAD и няма commits (`git rev-parse HEAD` → „unknown revision“). Няма tracked файлове.
- Untracked в началото, от потребителя:
  - `.idea/.gitignore`
  - `.idea/copilot.data.migration.agent.xml`
  - `.idea/misc.xml`
  - `.idea/modules.xml`
  - `.idea/software-factory.iml`
  - `.idea/vcs.xml`
  - `docs/SF-001-bootstrap.md`

  Файловете в `.idea/` не са пипани.
- Нямаше AGENTS.md, CLAUDE.md, README, package manager или lockfile в проекта. Приложим е само глобалният `~/.claude/CLAUDE.md`, който не съдържа правила за стил на кода.
- Задачата е преместена от `docs/SF-001-bootstrap.md` в `docs/tasks/SF-001-bootstrap.md` без промяна в съдържанието. Не е оставено копие.

## 4. Версии и проверен протокол

| Компонент | Версия |
| --- | --- |
| Node.js | v24.17.0 (nvm) |
| npm | 11.13.0 (единствен package manager; lockfile `bridge/package-lock.json`) |
| Git | 2.43.0 |
| `@modelcontextprotocol/server` | 2.4.0 (exact) |
| `@modelcontextprotocol/node` | 2.1.2 (exact) |
| `@modelcontextprotocol/client` | 2.4.0 (exact, devDependency, само за smoke теста) |
| `zod` | 4.6.7 |
| `typescript` | 7.0.2 |
| `@types/node` | 24.19.2 |

Избор на SDK:
- Официалната документация (https://ts.sdk.modelcontextprotocol.io/) определя v2 като стабилната линия, издадена на 2026-07-27 и имплементираща spec 2026-07-28.
- `@modelcontextprotocol/sdk` 1.32.2 е maintenance линията на v1. Не е избрана.
- Imports и API са проверени в инсталираните `.d.mts` и в `@modelcontextprotocol/node/README.md`: `createMcpHandler`, `toNodeHandler`, `localhostHostValidation`/`localhostOriginValidation`, `McpServer.registerTool`, `Client`, `StreamableHTTPClientTransport`.

Реално проверени transport и протокол (в smoke теста):
- Transport: Streamable HTTP, POST към `http://127.0.0.1:<port>/mcp`.
- Client по подразбиране (`versionNegotiation: legacy`, `initialize` handshake): договорена версия **2025-11-25**.
- Client с `versionNegotiation: { mode: 'auto' }`: договорена версия **2026-07-28**.

Разлика спрямо по-старите примери:
- Опциите `allowedHosts` и `enableDnsRebindingProtection` на transport-а са deprecated във v2.
- Вместо тях са ползвани външните guards, които препоръчва README-то на `@modelcontextprotocol/node`.

## 5. Създадени и променени файлове

Създадени (10, от които 8 авторски source/config/test/doc файла, 1 lockfile и този отчет):

| Файл | Роля |
| --- | --- |
| `.gitignore` | изключва `bridge/node_modules/`, `bridge/dist/`, `factory-data/`, `review/` |
| `bridge/package.json` | скриптове `typecheck`, `build`, `start`, `smoke`; exact версии |
| `bridge/package-lock.json` | lockfile (генериран от npm) |
| `bridge/tsconfig.json` | strict, `nodenext`, `types: ["node"]` |
| `bridge/README.md` | команди, конфигурация, tool договор |
| `bridge/src/server.ts` | HTTP listener, guards, tools |
| `bridge/src/probe-store.ts` | фиксиран пробен артефакт |
| `bridge/src/main.ts` | CLI вход, env, чисто спиране |
| `bridge/test/smoke.test.ts` | end-to-end smoke с официалния client |
| `docs/reports/SF-001-report.md` | този отчет |

Преместен: `docs/SF-001-bootstrap.md` → `docs/tasks/SF-001-bootstrap.md`, без промяна в съдържанието.

Tracked файлове не са променяни, защото repository-то няма такива.

Генерирани и игнорирани от Git, извън отчета: `bridge/node_modules/`, `bridge/dist/`, `factory-data/probe.txt` (ръчната проба от т. 6), `review/SF-001/`.

## 6. Проверки

Пълните логове са в `review/SF-001/logs/`. Всеки лог завършва с `# exit code: N`. Командите са изпълнени от `bridge/`.

| # | Команда | Exit code | Резултат | Лог |
| --- | --- | --- | --- | --- |
| 1 | `npm ci` | 0 | чиста инсталация от lockfile, 0 vulnerabilities | `logs/npm-ci.log` |
| 2 | `npm run typecheck` (`tsc --noEmit`) | 0 | без грешки | `logs/typecheck.log` |
| 3 | `npm run build` (`tsc`) | 0 | без грешки | `logs/build.log` |
| 4 | `npm run smoke` (build + `node --test dist/test/*.test.js`) | 0 | 2 tests, 2 pass, 0 fail | `logs/smoke.log` |
| 5 | ръчно: `npm start`, после `ss -ltnp`, `curl /other`, MCP client (валиден и празен запис), спиране | bridge: чисто спиране; client: 0 | listener `127.0.0.1:8787`; `/other` → 404; записът връща sha256; празният вход → `isError: true`; след SIGTERM портът е свободен | `logs/manual-start.log`, `logs/manual-listener.log`, `logs/manual-client.log` |

Обобщение на ред 1–4: `logs/summary.txt`.

Таблицата отразява първоначалното изпълнение на SF-001. Проверките след корекцията от Review 01 (3 теста) са в допълнението накрая.

Ред 5, бележка: bridge процесът е спрян с `kill -TERM <pid>` и е логнал реда за спиране. `npm start` показва exit code 130, защото npm е получил по-ранен SIGINT, който фоновият shell игнорира. Обяснението е и в лога.

Покритие на критериите от §5 в `bridge/test/smoke.test.ts`. Тестът стартира собствен процес на порт 0 (свободен loopback порт) с временна `FACTORY_DATA_DIR`, а в `after()` спира процесите и изтрива директорията:

1. MCP връзка и `listTools` → точно трите tools.
2. Read преди запис → `{ exists: false, artifact: "probe.txt" }`.
3. Запис и четене на `Здравей, фабрика! Проба №1 — UTF-8 ✓`. Резултатът съвпада с независимо изчислени bytes (61) и sha256 от Python `hashlib`. Проверено е и записът на 4096 емоджита.
4. Невалидни входове се отхвърлят: `{}`, `""`, само whitespace, 4097 `x`, 4097 емоджита, число и допълнително поле `path`. Съдържанието остава последното валидно, а в data директорията няма останали временни файлове.
5. Процесът се спира с SIGTERM (exit 0) и се стартира нов. Нова връзка с протокол 2026-07-28 прочита същия артефакт, а `factory_status` връща `local-only-pilot`.
6. Loopback:
   - `127.0.0.1` е достъпен.
   - `::1` и всички не-internal адреси на машината (`192.168.0.127` и `fe80::…`) не са достъпни.
   - Host `attacker.example` → 403; Origin `https://attacker.example` → 403.
   - Втори процес на същия порт отпада с „already in use“, а първият продължава да обслужва.
   - След спиране портът е свободен.
7. Typecheck и build: редове 2–3.

## 7. Известни проблеми, непроверени части и решения за SF-002

Известни ограничения:
- **Output schema** (поправено в Review 01, R2).
  - Схемата е един обект с optional полета. Затова `exists: true` без `message` формално би минал схемата.
  - Това е съзнателно опростен договор за пилота, а не ограничение на MCP. В SDK v2 и протокол 2026-07-28 SEP-2106 премахва изискването `outputSchema` да има `type: "object"` в корена. За 2025-ера клиенти SDK-то обвива не-обектни резултати в `{ result: … }` (migration guide, секция „JSON Schema 2020-12 posture (SEP-1613, SEP-2106)“).
  - Handler-ите винаги връщат пълните полета при `exists: true`. Smoke тестът проверява точните обекти и при двата протокола; runtime дефект не е установен.
  - Схемата не е сменена с discriminated union. Ако по-късно се наложи, първо трябва да се провери как промяната се отразява на двата поддържани wire формата (2025-11-25 и 2026-07-28).
- **Link-local IPv6.** Проверката срещу `fe80::…` без scope id не доказва много. Доказателството за IPv4 LAN (`192.168.0.127`) е реално.
- **Версия на bridge-а.** `0.1.0` е записана в `package.json` и в `server.ts`.
- **Конкурентни записи.** Два едновременни записа завършват и двата, като последният `rename` печели. Не е тествано под натоварване.
- **Процесът не е daemon.** Нужен е видим терминал или външен supervisor (OpenClaw в бъдеще).

Непроверено:
- Връзка от ChatGPT или друг външен client.
- MCP Inspector.
- Поведение зад тунел или reverse proxy.
- Windows и macOS.

Предпоставки за SF-002, по https://developers.openai.com/plugins/deploy/connect-chatgpt (прочетено на 2026-10-25). Нищо от това не е реализирано:

1. **Достъп.** Нужни са акаунт и workspace (ChatGPT Work), в които политиките позволяват добавяне на custom MCP server („Add custom MCP server“ в ChatGPT Plugins). Ролята и планът трябва да се потвърдят от администратора на workspace-а; страницата не ги уточнява.
2. **Достъпност.** ChatGPT не вижда `127.0.0.1`.
   - За свързване и тест има Secure MCP Tunnel към частен server или development HTTPS tunnel.
   - За submission е нужен публичен HTTPS endpoint.
   - Забраната за тунел е граница на обхвата на SF-001, не постоянно архитектурно ограничение. Свързването чрез подходящ транспорт е планирана работа за SF-002.
3. **Transport.** Streamable HTTP на `/mcp` вече е налице. Трябва да се провери коя протоколна версия договаря ChatGPT. Bridge-ът поддържа 2025-ера stateless и 2026-07-28.
4. **Host/Origin.** Guards не се разширяват предварително. Първо трябва да се видят реалните Host и Origin заглавки, които пристигат през избрания в SF-002 транспорт. След това guards се настройват точно за тях, без общо разхлабване.
5. **Автентикация.** Нужно е решение за authentication (OAuth или без), преди bridge-ът да излезе извън loopback. В момента няма никаква.
6. **Проверка.** Първо MCP Inspector: имена, описания, схеми, annotations. След това истински Work чат: `@plugin`, директни и индиректни заявки, write действие, неподдържана заявка. Записват се избраният tool, аргументите и резултатът.

## 8. Команди

Изпълняват се от `bridge/`:

```bash
npm ci                    # install from lockfile
npm run typecheck         # tsc --noEmit
npm run build             # tsc -> dist/
npm start                 # 127.0.0.1:8787/mcp, data dir ../factory-data
FACTORY_PORT=8790 FACTORY_DATA_DIR=/tmp/sf-probe npm start   # custom port/data dir
npm run smoke             # build + end-to-end MCP smoke (own port, own temp dir)
```

Спиране: `Ctrl+C` в терминала или `kill -TERM <pid на node dist/src/main.js>`. И двата сигнала водят до чисто спиране с exit code 0 и освободен порт.

## 9. Explain yourself

Целта на SF-001 е да докаже протокола и съхранението, без да строи платформа. Затова решенията са следните:

- **Транспорт.** Официалният `createMcpHandler` с готовите localhost guards, без собствен transport.
  - Stateless режимът е минималният, който SDK-то поддържа. Няма session store.
  - Една factory обслужва и двете протоколни ери, което ще е полезно за ChatGPT.
- **HTTP слой.** Чист `node:http` вместо Express/Hono: една зависимост по-малко и без CORS слой.
- **Съхранение.** Един фиксиран файл с атомарен запис, без база данни. Callers физически не могат да изберат път.
- **Тестове.** Един end-to-end тест срещу реалния процес. Той проверява точно критериите от §5, вместо да дублира имплементацията с unit тестове. Очакваните хешове са изчислени независимо.
- **Ограничения.** Това е pilot без автентикация, достъпен само от същата машина. Всеки локален процес на машината може да вика tools-ите. Записът е ограничен до 4096 символа в един файл, така че щетата е минимална. Не е подходящ за излагане извън loopback, преди точки 2, 4 и 5 от SF-002 да са решени.

## 10. Предложение за ръчен Git

- Branch: `sf-001-local-mcp-bridge`
- Commit subject: `SF-001: add local-only MCP bridge with probe tools`
- MR заглавие: `SF-001: Local MCP bridge (Streamable HTTP, loopback-only) with probe tools`
- MR описание:

  ```text
  Adds bridge/, a local-only MCP server on the official TypeScript SDK v2
  (@modelcontextprotocol/server 2.4.0, Streamable HTTP, stateless createMcpHandler).

  - Listens on 127.0.0.1 only, path /mcp, FACTORY_PORT (default 8787)
  - Host/Origin guards from @modelcontextprotocol/node; no CORS, no tunnel, no auth
  - Tools: factory_status, factory_write_probe, factory_read_probe
  - Probe stored atomically as <FACTORY_DATA_DIR>/probe.txt (default ./factory-data, git-ignored)
  - End-to-end smoke test with the official MCP client (2025-11-25 and 2026-07-28)

  Checks: npm ci, typecheck, build, smoke: all exit 0 (see docs/reports/SF-001-report.md).
  Not included: ChatGPT connection (SF-002), events, auth, tunnels.
  ```

## Допълнение: Review 01 (2026-10-25)

Ревюто е `docs/SF-001-review-01.md`. Добавено е и като секция „Review 01“ в края на `docs/tasks/SF-001-bootstrap.md`. Изпълнено с `/implement` и `/tdd` (red→green).

### Git baseline преди корекцията

- Branch `main`, unborn: няма HEAD и няма commits.
- Staged (`A`), извън Claude: `.gitignore`, `.idea/*` (6 файла) и `bridge/` (README, package-lock.json, package.json, src/main.ts, src/probe-store.ts, src/server.ts, test/smoke.test.ts, tsconfig.json).
- Untracked: `docs/SF-001-review-01.md`, `docs/reports/SF-001-report.md`, `docs/tasks/SF-001-bootstrap.md`.
- Claude не е променял index-а: нито staging, нито unstaging. Затова промените в `bridge/src/server.ts` и `bridge/test/smoke.test.ts` се виждат като `AM` (staged версия плюс промени в работното копие).

### R1: невалиден HTTP request target → 400 (изпълнено)

- **Проблем, потвърден в тази среда (Node v24.17.0).**
  - `GET //` с разрешен Host и без Origin стигаше до `new URL(req.url, 'http://localhost')`.
  - Там се хвърляше необработено `TypeError: Invalid URL` (`ERR_INVALID_URL`, `input: '//'`) и bridge процесът излизаше с exit code 1.
  - Логове: `logs/review-01-red-manual.log` и `logs/review-01-red-smoke.log` (новият тест в red: празен отговор, 2 pass / 1 fail, exit code 1).
- **Поправка в `bridge/src/server.ts`.**
  - `new URL(...)` е заменен с `URL.parse(...)`, който връща `null` вместо да хвърля. При `null` отговорът е `400 {"error":"bad request target"}`.
  - Проверката е след Host/Origin guards и преди routing-а. Без нов framework и без общ error handling.
- **Regression сценарий в `bridge/test/smoke.test.ts`:** тест „unparseable request targets get HTTP 400 and the bridge keeps serving“.
  1. Тестът стартира собствен bridge процес на свободен loopback порт (порт 0) с временна data директория и записва известна проба през MCP client.
  2. Изпраща `GET //` и `GET //[` през суров TCP socket (`net.connect`), за да няма нормализиране от HTTP client, и очаква `HTTP/1.1 400`.
  3. Проверява, че процесът е жив (`exitCode === null`).
  4. Със същия MCP client в същия процес `factory_status` връща `{ name: "software-factory-bridge", version: "0.1.0", mode: "local-only-pilot" }`.
  5. `factory_read_probe` връща непроменената проба (61 bytes, същият sha256).
  6. Накрая SIGTERM → exit code 0.
- **Host/Origin и `/mcp`.** Съществуващият тест „listens on loopback only, guards Host/Origin…“ минава без промяна (403 за чужд Host и Origin). MCP трафикът през `/mcp` е проверен и от трите теста.

### R2: поправка на обяснението за outputSchema (изпълнено)

- Т. 7 е поправена. Обектната схема с optional полета вече е описана като опростен договор на пилота, а не като ограничение на MCP.
- Добавена е препратка към SEP-2106 в migration guide на SDK v2 и уточнението, че discriminated union изисква проверка на двата wire формата, преди да се въведе. Схемата не е променена.
- Т. 7 (SF-002, точки 2 и 4) вече уточнява:
  - Забраната за тунел е граница на обхвата на SF-001.
  - Свързването е планирано за SF-002.
  - Host/Origin guards не се разширяват предварително; първо се проверяват реалните заглавки през избрания транспорт.

### O1: отложено

Ограничено изчакване в smoke harness-а (`spawnBridge`, `stopBridge`, `after`) не е изпълнено, както позволява ревюто. Остава като бъдещо подобрение.

### Проверки след корекцията

Командите са изпълнени от `bridge/`. `npm ci` не е повтарян, защото зависимостите и lockfile-ът са без промяна.

| # | Команда | Exit code | Резултат | Лог |
| --- | --- | --- | --- | --- |
| R1-red | `npm run smoke` (преди поправката) | 1 | 3 tests, 2 pass, 1 fail: `no HTTP status line for //: ""` | `logs/review-01-red-smoke.log` |
| R1-red-manual | `node dist/src/main.js` + `printf 'GET // …' \| nc` (преди поправката) | bridge: 1 | `TypeError: Invalid URL`, code `ERR_INVALID_URL`, процесът спира | `logs/review-01-red-manual.log` |
| 1 | `npm run typecheck` | 0 | без грешки | `logs/review-01-typecheck.log` |
| 2 | `npm run build` | 0 | без грешки | `logs/review-01-build.log` |
| 3 | `npm run smoke` | 0 | 3 tests, 3 pass, 0 fail | `logs/review-01-smoke.log` |
| 4 | `node dist/src/main.js` + `nc` с `//` и `//[`, после SIGTERM | nc: 0; bridge: 0 | и двата → `HTTP/1.1 400 Bad Request`, `{"error":"bad request target"}`; процесът продължава да работи и спира чисто | `logs/review-01-green-manual.log` |

Обобщение на редове 1–3: `logs/review-01-summary.txt`.

### Променени файлове в Review 01

Общо 4 файла:

- `bridge/src/server.ts`: R1 поправка (+7/−2 реда; `git diff` спрямо staged snapshot-а е в `review/SF-001/review-01.diff`).
- `bridge/test/smoke.test.ts`: helper `rawRequestStatus` и regression тест.
- `docs/reports/SF-001-report.md`: R2, бележка за Git и това допълнение.
- `docs/tasks/SF-001-bootstrap.md`: добавена секция „Review 01“.

`docs/SF-001-review-01.md` е предоставен от потребителя и не е променян.

## Review пакет

Пакетът е в `review/SF-001/` (игнориран от Git):

- `MANIFEST.md`: списък и описание на артефактите.
- `implementation.diff`: diff на tracked файловете. Празен е, защото repository-то е unborn; вътре е отбелязано защо.
- `new-files.md`: пълното съдържание на новите авторски файлове.
- `review-01.diff`: `git diff` на работното копие спрямо staged snapshot-а (index), тоест промените от Review 01 в `bridge/`.
- `logs/`: всички логове. Тези от Review 01 започват с `review-01-`.
