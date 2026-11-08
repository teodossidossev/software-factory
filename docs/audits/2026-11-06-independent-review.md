# Software Factory: independent review

Reviewer: an independent senior reviewer, read-only. Date: 2026-11-06. Repository at `main` `ae4133b`.

Sources: the repository (README, CONTEXT, docs/, factory/README.md, factory/HANDBOOK.md, factory/src,
factory/test, factory/static), `git log`, `sf metrics` and `sf status` (read only), and the job records
under `~/.local/state/software-factory/jobs/software-factory/` (job.json, events.jsonl, iterations/*/
meta.json, review.json, gate.json). I read no code of other workspaces. For the aggregate numbers I
read only the verdict, severity, token and cost fields of the other workspace's records (as `sf metrics`
does), never their patches or reports.

**[F]** marks a fact I checked (file:line, a command, a number from the records). **[O]** marks my opinion.

---

## 0. Verdict

**[O]** The core idea works, and so does most of the engineering. A planned Task file goes in, and a
reviewed, rebased, single-commit branch comes out, without anyone babysitting it. 44 of 48 self-hosted
jobs reached `pushed`. The domain model, the explicit state machine, the per-job runner processes and
the factory-owned Git are better than what most internal tools have.

The weaknesses are of three kinds:

- **Breadth over hardening.** About 24k lines of TypeScript, 6.8k lines of hand-written dashboard JS and
  about 27k lines of tests were written in six days. There is no CI, no linter and no clean build. Main
  has already been broken by two merges in sequence. On the user's own machine the suite is red: 10 of
  627 tests fail, 2 of them every time.
- **A review loop whose cost is real and whose value per round is uneven.** The Claude review stage
  mostly says "clean". The Codex gate does almost all the blocking work, rates almost everything
  `major`, and spends about 660k input tokens per round.
- **The project mostly builds itself.** 48 of 54 recorded jobs are `software-factory` tickets. On the one
  real product repository: 6 jobs, 2 aborted, 3 reached review.

It is not ready for colleagues. The sandbox and the unauthenticated tunnel need tightening first, and
the docs need to be cut down to something a newcomer can read.

---

## 1. Strengths

### 1.1 Design

- **[F] A real domain language.** `CONTEXT.md` (273 lines) defines every term (Idle gap, Task file,
  Iteration, Ledger, Gate, Gate level, Settled finding, Churn and so on), each with an `_Avoid_:` list.
  The code and docs use these terms consistently. This is rare and valuable for agent-written code: it
  keeps successive model sessions from inventing synonyms.
- **[F] An explicit, enforced state machine.** `JOB_TRANSITIONS` (`factory/src/jobs.ts:109-144`) is a
  table of (from, to, action). Every state change goes through `checkTransition` (`jobs.ts:157-164`),
  called from `Core.transition` (`execution/core.ts:101`). A refused change is recorded so tests see it
  even when the error is caught (`jobs.ts:146-152`). The README table is rendered from the code
  (`jobs.ts:168`). This is the right way to keep a 13-state lifecycle honest.
- **[F] Process isolation done properly.**
  - One detached runner per job (`runner.ts:1-7`). The runner talks to `sf serve` through a file
    mailbox (`queue/`, `replies/`), so a restart of serve leaves jobs running. The early records show
    why this was needed: `serve_restarted` stops on SF-012, SF-040 and SF-046, none after SF-042.
  - `pid-lock.ts` stores the pid plus the `/proc` start time to defeat pid reuse (`pid-lock.ts:1-5,
    70-73`). Locks are created as hard links of complete temp files.
  - Writes are atomic with an fsync of both the file and its directory (`atomic.ts:12-37`).
- **[F] The factory does Git itself, outside the model.** ADR-0005 records why: the ABC-1 rebase
  failed inside the sandbox. The Git calls of the hand-over run with `core.hooksPath=/dev/null`, so a
  branch cannot plant a hook that then runs unsandboxed (`handoff.ts:33-36`). That is good threat
  modelling.
- **[F] Careful environment hygiene for the Implementer.** It gets an allowlisted environment
  (`session.ts:26-40`), with no `SF_*` settings and no forge tokens. Reviewer events are redacted
  before they are logged (`redact.ts`).
- **[F] The dashboard is local-first and defensive.**
  - It listens on `127.0.0.1` (`dashboard.ts:58`).
  - Every path sits under a 32-byte random token, compared with `timingSafeEqual` (`dashboard.ts:740-742,
    919`).
  - Host and Origin are validated (`dashboard.ts:24`), and bodies have a size limit
    (`dashboard.ts:1613`).
  - There are no `innerHTML` uses in `static/app.js` (0 matches), so XSS is unlikely.

### 1.2 Process

- **[F] Decisions are recorded with the evidence that forced them.** ADR-0005's amendments quote the
  incident data: SF-045 ran "five gate rounds, about 2.4M tokens, ever narrower variants of one risk".
  Each loop rule (nits never block, the ledger, churn, the user override, the simplification pass) is
  traced to that incident. The project learns from its own data.
- **[F] It measures itself.** `sf metrics` reports gate yield per job and in total. `sf status` reports
  an API-equivalent cost estimate. Few agent pipelines measure anything.
- **[F] One PR per ticket, with an honest history.** There are 158 commits, conventional-ish subjects
  and fix commits that explain the root cause (for example SF-094, see 2.1).
- **[F] It delivers.** Of the 48 `software-factory` job records, 44 are `pushed`. 31 of 48 needed no
  human stop at all (17 had at least one `needs_human`). The median job takes about 0.9 h from start to
  ready.

### 1.3 Code and tests

- **[F] Strict TypeScript.** `strict` and `noUncheckedIndexedAccess` are on (`factory/tsconfig.json`).
  Errors are typed (`FactoryError` with a code), and the dashboard maps them to HTTP statuses
  (`dashboard.ts:239-253`).
- **[F] A lot of tests, with sensible fakes.** 627 tests (as `node --test` counts them) in 61 files: 24.5k lines,
  plus 2.3k lines of support code. The support code includes `fake-claude.ts`, `fake-codex.ts`,
  `fake-forge.ts`, a fake launcher and a harness, so the whole lifecycle runs without a model. Many
  tests are end-to-end through `sf serve`, the CLI, real Git and real worktrees. A live smoke test
  (`sf smoke`, `live-smoke.ts`) covers the real models.

---

## 2. Weaknesses

### 2.1 Build, CI and test hygiene (the cheapest serious problem)

- **[F] No CI and no linter.** There is no `.github/`, and no eslint, prettier or biome in either
  `package.json`.
- **[F] Main has already been broken by a semantic merge conflict.** Commit `caf9b3e` (SF-094): "SF-086
  and SF-087 merged one after the other; SF-087 made mr_conflict_turn a required job field and SF-086's
  new test fixture lacks it, so main's typecheck fails." Up to three jobs run in parallel, and each is
  reviewed against its own base. Nothing checks the combination before merge.
- **[F] The build does not clean `dist/`.**
  - The test script globs `dist/test/*.test.js` (`factory/package.json` `"test"`). `dist/test/` still
    holds compiled tests of the removed MCP Events/OAuth code: `auth.test.js`, `auth-serve.test.js`,
    `events.test.js` and `events-serve.test.js`, dated Nov 4. Their sources were deleted in SF-040.
  - In my run of `npm test`, `dist/test/auth-serve.test.js` hung for more than 6 minutes at 0.9% CPU,
    and I killed it.
  - The installed copy has the same dead files: `~/.local/lib/software-factory/factory/dist/src/auth.js`,
    `events.js` and the four tests.
- **[F] Browser-test types break the unit suite.**
  - `tsconfig.json` includes all of `test/`, so `test/browser/*.ts` is compiled by `npm run typecheck`
    and `npm test`.
  - The checkout's `node_modules` predated the `playwright` devDependency added in SF-091. Before
    `npm ci`, typecheck failed with 19 errors (TS2307 and TS7006 in `test/browser/*`), and `npm test`
    ran zero tests because `tsc` fails before `node --test`.
  - An optional, heavy dev dependency should not gate the core suite.
- **[F] The suite is red on the user's own machine.** After `npm ci`, typecheck passes. Run over the 61
  current files only, the suite gave **617 pass, 10 fail, 627 tests** in 4 min 4 s.
  - In a serial rerun of the affected files, the 2 `staleSandboxLock` tests in `sandbox-lock.test.ts`
    failed every time.
  - The other 8 failures pass alone (the SF-085 hand-over and check-task lock tests, the live-smoke
    budget test, the runner's abort test). They are timing or parallel-load flakes, or they depend on
    the same lock check.
- **[F] Root cause of the deterministic failure: the SF-085 lock cleanup cannot work on a normal desktop.**
  - The check "fails closed" when a `/proc/<pid>/fd` directory of the user's own processes cannot be
    read.
  - On this desktop 5 such processes exist, among them `ssh-agent` and `(sd-pam)`, which are
    non-dumpable. So `staleSandboxLock` never reports a stale lock, and the cleanup never fires.
  - The tests passed where the Implementer and reviewers ran them (inside the sandbox's narrower
    `/proc` view), and the PR merged. That is a clear case of "green in the agent's environment, red
    on the user's machine". CI on a plain runner, or a run on the user's machine, would have caught it.
  - **[O]** Excluding processes you cannot read, or only scanning processes of the factory's process
    tree, would fix it.
- **[O] What the tests prove and what they don't.**
  - They prove the factory's own control flow against fakes of Claude, Codex, the forge and the DOM.
  - They do not prove that the real models behave as the prompts assume (severity calibration, ledger
    answers). They do not prove that the sandbox holds (no test runs inside it).
  - The 6.8k-line `app.js` is tested mainly through an 835-line hand-written `fake-dom.ts`. That proves
    behaviour against a fake that the same agents wrote. The Playwright suite (SF-091) is the right
    correction, but it is not in `npm test`.
  - The tests and the code are written by the same Implementer and reviewed by models. A wrong
    assumption shared by the code and its tests passes both.

### 2.2 Architecture and code

- **[F] Large modules.**
  - `static/app.js` has 6,790 lines and 276 top-level functions, in one file, without a framework or a
    build step.
  - `dashboard.ts` has 1,843 lines, `cli.ts` 1,394, `live-smoke.ts` 980, `execution/mr-steps.ts` 936,
    `jobs.ts` 915, `task-check.ts` 863, `setup.ts` 778 and `execution/reviews.ts` 759.
  - `src/` totals 23.7k lines across 49 files plus 9 in `execution/`.
- **[F] Ticket archaeology in the code.** There are 746 `SF-0xx` references in `src/` comments and 133 in
  `app.js`. Comments like "(SF-067)" or "(SF-073: recover() repairs it)" explain history, not
  behaviour. Each new session pays to read them, and they rot.
- **[O] The `Execution` split (SF-089) is a service locator, not a seam.** `Core` holds `parts!: Parts`.
  The parts reach each other as `this.core.parts.<part>` (`execution/core.ts:1-5, 56`). Splitting the
  file into seven parts reduced file size but not coupling, because any part can call any other.
- **[F] The lifecycle keeps growing.** There are 13 states and about 25 actions. Several rows exist only
  to repair cut-off hand-over steps (`jobs.ts:114-121`). **[O]** Each feature (pause, usage-limit
  parking, hand-over, ask for changes, take back, simplify, settle, MR create and merge) adds rows and
  recovery paths. Adding them is now quicker than reasoning about how they interact.
- **[F] State on disk is many small JSON files plus big event logs.**
  - Each job has `job.json`, `ledger.json`, `rules.json`, `mr.md`, `task.md`, `runner.log`, `queue/`,
    `replies/`, and per iteration `meta.json`, `review.json`, `gate.json`, `gate-output.json`,
    `gate-schema.json`, `patch.diff` and `report.md`.
  - `events.jsonl` is 0.8–5.3 MB per job. The `software-factory` jobs take 149 MB for 48 jobs, with no
    retention.
  - Leftover files of the removed transport remain in the state dir: `events-queue.json`,
    `subscriptions.json`, `requests/`.
  - **[O]** This is fine for one user. It is fragile for schema evolution: the runbook warns that "an
    unknown key stops" a runner started on older code (`coordinator.md`, "Add a new key...").
- **[F] Concurrency is reasoned about.**
  - There is an in-process operation lock and a per-workspace Git lock that is also a cross-process
    file lock (`execution/core.ts:73-93`).
  - The queue says it never starts a ticket twice (`queue.ts:4-6`).
  - **[O]** The model is "one runner owns `job.json` while alive, serve sends requests". It is sound,
    but it relies on discipline. Nothing in `JobStore.write` checks that the writer is the lock owner,
    and only a comment says so (`jobs.ts:805`).
- **[F] Linux assumptions.** Lock ownership reads `/proc/<pid>/stat` (`pid-lock.ts:23-31`), and the
  sandbox-lock cleanup scans `/proc/<pid>/fd` (SF-085). The socket path limits name macOS, but the
  /proc fallbacks would quietly weaken the guarantees there.

### 2.3 The review loop: cost and token efficiency

All numbers below are **[F]**, from the job records of `software-factory`, unless marked otherwise.

| Measure | Value |
| --- | --- |
| Jobs | 48 (44 pushed, 1 aborted, 3 other) |
| Implementer, API-equivalent estimate (max `total_cost_usd` per session) | about $535 |
| Claude review, sum of `cost_usd` | about $155 over 115 runs (about $1.35/run) |
| Claude total per job | about $14 |
| Gate (Codex) runs with a `gate.json` | 100 (`sf metrics`: 113 across all workspaces) |
| Gate input tokens | 66.2M, of which 56.3M cached (85%); output 0.42M |
| Gate input per run | about 660k tokens to produce about 4k tokens of output |
| Claude review verdicts | 105 clean / 10 fix (91% clean) |
| Gate verdicts | 50 fix / 50 clean |
| Claude review item severities | 80 nit, 5 major, 1 blocker (10 untagged) |
| Gate item severities (all workspaces) | 0 nit, 58 major, 5 blocker (13 untagged) |
| Gate fix rate by round | round 1: 26/47; round 2: 13/30; round 3: 6/16; round 4: 7/8; round 5+: 6/12 |
| Ledger gate items (`sf metrics`) | fixed 45, contested 0, accepted 3, open 28; "yield" 59.2% |
| Simplification pass | offered 6 times, Skip chosen 6/6, never applied |
| Gate levels (since SF-092) | full 4 / light 0 / none 0 |
| Patch growth from iteration 1 to final | +11% overall; SF-045 +256%, SF-090 +53%, SF-085 +46%, SF-054 +42% |

What this says:

- **[O] The Claude review stage is close to a rubber stamp.** It ends "clean" in 91% of runs. In half of
  those, the gate then finds a blocking item. It has no Bash (`REVIEW_DENIED_TOOLS`, `review.ts:22`), so
  it cannot run a test, `git diff` or `rg`, and it reads the material in its prompt. It sees things
  (80 nits) but rates almost nothing as blocking. That is about $155 for 6 blocking items.
- **[O] The two reviewers are calibrated very differently.** Codex never emitted a single nit in 76
  items: everything is `major`. SF-051's rule "the factory, not the reviewer, decides by severity" does
  nothing if one reviewer marks every item major. The gate is the de facto sole reviewer, and its
  severity labels carry little information.
- **[O] "Gate yield 59%" overstates value.** "Fixed" means the Implementer answered "fixed". It never
  contested anything (0 contests in the whole history), so the metric measures compliance, not
  correctness.
- **[O] Late rounds polish edge cases of low-stakes code.** SF-090's eight gate rounds (sample of items:
  R1 to R8, all `major`) were about signal handling and process-group cleanup in a developer-only
  smoke-test command. `live-smoke.ts` grew to 980 lines. The coordinator runbook already tells the
  coordinator to cut such loops by hand ("A gate that keeps finding ever narrower items is churn: send
  the one item worth fixing as a message, then Accept"). That rule is a symptom: the human is the
  convergence mechanism.
- **[O] The gate re-reads the world each round.** About 660k input tokens per run, mostly cached, for
  about 4k of output. Every round is a fresh `codex exec --ephemeral` (`gate.ts:97`) that explores the
  worktree again. The ledger lets the gate see settled items, but not its own prior context.
- **[F] The guards against the loop's own growth are unused.** Gate levels never chose `light` or
  `none`, the simplification pass was never accepted and contests never happened. That machinery is
  code, tests, prompts and docs, kept up for zero observed effect so far (small samples for levels).

### 2.4 Security

- **[F] The planning endpoint has no authentication and is published through a tunnel.**
  - `server.ts:5-7` says "No authentication: it listens on loopback only". But `scripts/sf-tunnel.sh:39`
    initialises the tunnel with `--sample sample_mcp_remote_no_auth` to `http://127.0.0.1:8787/mcp`,
    and the ChatGPT connector is configured "with no authentication" (README).
  - So loopback-only is not the boundary. The boundary is whoever can drive the ChatGPT connector or
    the tunnel.
  - The tools read every registered workspace (`read_file`, `search`, including company code), write
    Task files (`write_task`) and queue tickets (`queue_add`, `server.ts:381-400`).
- **[F] No human gesture is needed between the remote planner and code execution.**
  - The queue starts a queued ticket by itself once its automatic Task check is `ready`
    (`queue.ts:15-17`). The check runs by itself 60 s after `write_task` (HANDBOOK Quick start step 4).
  - So `write_task` plus `queue_add` over the tunnel leads to a headless Implementer with Bash
    (sandboxed) and `permissionMode: 'auto'` (`session.ts:280`), with no click by the user.
  - The Handbook says the Context owner "never starts" a job (`HANDBOOK.md:11-13`), but `queue_add`
    effectively starts one.
  - **[O]** A prompt injection in a repository file that ChatGPT reads is a plausible way to reach this
    path.
- **[F] The sandbox is generous.**
  - `allowAllUnixSockets: true` and `allowLocalBinding: true` (`config.ts:95`), with `SSH_AUTH_SOCK`
    passed to the Implementer (`session.ts:26`).
  - The factory's own control socket `<state>/sf.sock` (mode 0600, same user, `ipc.ts:1-2`) accepts
    `approve`, `accept`, `settle`, `mr-create` and `mr-merge` (`cli.ts:220-290`).
  - **[O, not verified live]** With every Unix socket allowed, a sandboxed Implementer can probably
    connect to `sf.sock` and accept or approve its own job, or use the user's ssh-agent. I did not test
    this, by the read-only rule. It is the first thing to check.
- **[F] Reads are not confined.**
  - No `denyRead` exists for the Implementer: there are no matches for `denyRead` in `src/`, and Claude
    Code's sandbox confines writes and network, not reads.
  - The gate's protection of `~/.config` and `~/.ssh` is a sentence in the prompt (`gate.ts:59`). Its
    environment is everything except `SF_*` (`gate.ts:107-110`), so a `GITHUB_TOKEN` exported in the
    shell reaches Codex.
  - The Implementer receives `AWS_*`, `GOOGLE_*` and `CLOUD_ML_*` variables by pattern (`session.ts:27`).
  - Network egress is restricted to `registry.npmjs.org` plus `SF_SANDBOX_DOMAINS` (`config.ts:95`).
    That limits exfiltration but does not stop it: request paths to an allowed host can carry data.
  - **[O]** Across workspaces, a `software-factory` job can read another workspace's worktrees and job
    records under the same state dir. That matters the moment company repositories and personal
    projects share one install.
- **[O] Redaction is regex-based.** `redact.ts` is 437 lines: an allowlist of environment variable names
  and about a dozen key patterns. It works as defence in depth, but it is not a boundary. The project's
  own ADR cites it as the example of reviewers growing code.

### 2.5 Documentation

- **[F] The docs are too big.** `factory/README.md` has 2,736 lines. Its "Jobs" section is 755 lines and
  "Dashboard" 864. It has 232 ticket references and lines up to 1,812 characters. `HANDBOOK.md` has 313
  lines. Across all docs there are about 7,600 lines.
- **[O] Findability is poor.** The README is a ticket-by-ticket narrative of behaviour rather than a
  reference. A newcomer cannot find "what do I do when X" without searching.
- **[F] Some docs are inaccurate or stale.**
  - `docs/README.md` has 13 broken links to `docs/tasks/*.md`. That directory does not exist.
  - ADR-0005's Decision section still describes "an OpenAI model through the Responses API, with read
    and search over the worktree as function tools" and "Without an OpenAI key the gate is off". Six
    amendments in its header override it, and the reader must apply them mentally.
  - `CONTEXT.md` says the Implementer "never works in" the Workspace, while the hand-over writes Local
    Changes into that checkout. That is defensible by wording, but confusing.
  - The settings file is called `auth.env` "(a historical name)" (README).
- **[O] The language is precise but heavy.** The docs follow the vocabulary rigorously. The cost is
  sentences like "A cut-off step of the hand-over (handover.step) stays on the job through every later
  change until recover() repairs it" (`jobs.ts:114`). They are correct, but a newcomer cannot parse them
  quickly.

### 2.6 Operability

- **[F] Setup has many moving parts.**
  - Node 24, Claude Code on a plan, the Codex CLI on a ChatGPT plan, OpenAI's `tunnel-client`, a
    tunnel id and a runtime key, a ChatGPT connector, Git host tokens, `bubblewrap` for the Linux
    sandbox (implied by `failIfUnavailable: true`, `config.ts:93`), and `playwright` for the browser
    tests.
  - Updating needs a manual sequence (pull, `npm install`, build, restart serve, `sf smoke`) in the
    coordinator runbook.
  - Settings keys must not be added while an older runner is alive ("an unknown key stops it").
- **[F] Recovery paths exist and have been needed.** The `needs_human` reasons across 17 jobs include:
  - the loop's own stops: `simplify_offered` 6, `gate_rounds` 3, `iteration_limit` 2, `escalated` 2,
    `review_churn` 2;
  - failures: `session_failed` 3, `serve_restarted` 3, `review_failed` 1, `mr_serve_restarted` 1,
    `mr_conflict` 1, `registry_invalid` 1, `fetch_failed` 1.
- **[O] Observability is good for one job and weak in aggregate.** The Stream, `sf watch` and
  `events.jsonl` are rich. There is no single cost number per job that includes the gate (`sf status`
  shows Claude USD, `sf metrics` shows gate tokens). Nothing tracks trends over time, and the event logs
  have no retention.

### 2.7 Single-user, single-machine assumptions

- **[F] It is single-user by definition.** `CONTEXT.md`: "**User**: The one person who owns the machine".
  There is one dashboard token per state dir, one queue for every workspace, one ChatGPT connector, and
  `~/.config` plus `~/.local/state` paths throughout.
- **[O] The consequences for colleagues.**
  - Each colleague needs their own whole stack, including their own unauthenticated tunnel to their own
    machine.
  - There is no shared queue, no shared metrics and no way to hand a job to someone else.
  - The Git host integration assumes one personal token in `auth.env`.

---

## 3. Product critique

**[O] Does it deliver value for its cost?** For the author, on this repository: yes.

- About $14 of Claude API-equivalent spend (on a plan, so mostly quota, not money) plus about 1.4M Codex
  tokens per job buys a reviewed PR in about an hour with little attention.
- 44 merged PRs in five days is real throughput.
- Much of the "attention saved" is spent elsewhere: writing 14 KB Task files (median `task.md` 14.3 KB,
  max 31 KB), reading summaries, overriding churn and merging.

**[O] Is it proven on real work?** Not yet.

- 48 of 54 recorded jobs are the factory working on itself. Self-hosting is a good test bed, but it
  optimises the tool for its own kind of change: TypeScript, Node tests, its own conventions.
- On the one product repository there are 6 jobs. ABC-1 aborted twice (once on the sandbox rebase
  failure). DOC-1 aborted once, then reached review. ABC-2 reached review, and ABC-3 was
  handed over.
- The memory note "Priorities 2026-11-05: stabilize + real projects first" is the correct instinct. The
  record since then is 25 more self-hosted tickets.

**[O] Where it is over-engineered:**

- The simplification pass: always skipped.
- Contest and dispute handling: never used.
- Gate levels: never below full.
- A two-stage review whose first stage is 91% "clean".
- The pause, resume and usage-limit parking rules with three `on_limit` modes.
- The take-back and ask-for-changes round trips of the hand-over.
- An IDE-grade dashboard (file tree, side-by-side diff, MR editor) in hand-written vanilla JS.
- 437 lines of redaction regex.

Each of these is defensible alone. Together they create a large surface that one person and the agents
must keep consistent, and adding them has outpaced checking that they hold together. SF-094 shows this,
and so do the stale `dist/` and the 19 typecheck errors.

**[O] Where it is under-built:**

- CI and merge gating.
- A clean, reproducible build.
- Sandbox confinement of reads and sockets.
- Authentication or a human gesture on the remote path.
- Cross-job integration checking: the semantic conflicts of parallel jobs.
- Calibration of reviewer severities against outcomes, such as defects found later.
- Retention of job logs.
- Short, task-oriented docs.
- A cost view that adds both providers together.

**[O] Risks if colleagues adopt it:**

1. **Security exposure on company code.** Unauthenticated tunnel tools read every registered company
   repository and can trigger autonomous runs. The sandbox lets the agent read the user's whole home
   directory and talk to local sockets.
2. **Plan quota and cost surprises.** About 1.4M Codex tokens per job, and 4–6M on loops (SF-052 4.0M,
   SF-064 4.6M, SF-090 4.4M). Two or three parallel jobs exhaust personal plan windows. Hence the
   `waiting_limit` feature.
3. **Bus factor and comprehension.** About 55k lines (code plus tests) written by agents in a week,
   documented in about 7.6k lines of dense prose. When something breaks for a colleague, the only
   person who can debug it is the author, with an agent.
4. **Process lock-in.** It works only with Task files written to this Handbook's standard, and
   colleagues' Task files will be weaker. The factory then amplifies a weak plan through several
   expensive review rounds instead of failing fast.
5. **Trust in "reviewed".** Two model reviewers that agree only nominally, a metric that counts
   compliance, and no CI. A colleague may read "Clean" as stronger than it is.

---

## 4. Recommendations (ranked by value for effort)

1. **CI plus a clean, split build. Hours of work.**
   - Add a GitHub Actions workflow (`npm ci`, typecheck, test) on every PR, and require it to pass
     before merge.
   - Run it on the post-merge `main` too, which would have caught SF-094.
   - Make `build` start with removing `dist/`, or use `tsc --build --clean`, so the stale `auth*` and
     `events*` tests and modules disappear from the checkout and the install.
   - Move `test/browser` to its own `tsconfig.browser.json`, so the unit suite never depends on
     Playwright.
   - Add a per-test timeout (`--test-timeout`), so a hang fails instead of blocking forever.
  - Fix `staleSandboxLock` so that it ignores processes whose `/proc/<pid>/fd` cannot be read, then make
    the suite green on the user's own machine. Treat flaky timing tests as bugs.

2. **Close the sandbox holes and add a test that proves it. About a day.**
   - Replace `allowAllUnixSockets: true` with an explicit, minimal `allowUnixSockets` list (empty by
     default, or paths inside the worktree for repository tests). Drop `SSH_AUTH_SOCK` from the
     Implementer's environment.
   - Add `denyRead` rules for `~/.config/software-factory`, `~/.ssh`, `~/.codex`, `~/.aws`, the state
     dir outside the job's own worktree, and other workspaces' checkouts.
   - Give Codex the same denies through its sandbox config, rather than prompt text.
   - Add a live smoke step in which the Implementer tries to connect to `sf.sock` and to read
     `auth.env`, and must fail.

3. **Put a human gesture, or authentication, on the remote path. Hours of work.**
   - Entries added through MCP `queue_add` should land held until the user releases them on the
     dashboard.
   - Or require tunnel authentication: OAuth was removed together with the Events transport, but a
     static bearer secret in the connector would do.
   - Make the Handbook's "you never start a job" literally true.

4. **Turn the two-stage review into one that is calibrated. Days of work, with large token savings.**
   - Either give the Claude reviewer read-only Bash (tests, `git diff`, `rg`) and make it the cheap
     first gate, or drop it and save about $3 per job and a few minutes.
   - Calibrate severities: show each reviewer the other's definitions with examples, and track
     `major`-rated gate items that the user later accepts as risk, then downgrade them.
   - Make rounds proportional to stakes:
     - Default `SF_GATE_MAX_ROUNDS` 2 (data: round 1 finds a blocking item 55% of the time; by round 3
       the loop is mostly churn).
     - Use `light` for test-only and dev-tool paths.
     - Resume the gate's Codex session across rounds instead of `--ephemeral`, so it does not re-read
       about 600k tokens.
     - Pass it the diff since the last round.

5. **Prune unused features and measure the rest. Days of work.**
   - Make the simplification pass opt-in: 0 of 6 applied.
   - Freeze the contest and dispute machinery until it is used once.
   - Delete the leftover state files of the removed transport (`events-queue.json`,
     `subscriptions.json`, `requests/`).
   - Add retention for `events.jsonl`, for example gzip at `pushed` and delete after 30 days.
   - Define "yield" as items the user or a later test confirms, not items the Implementer says it fixed.

6. **Restructure the docs for readers, not for history. 1–2 days.**
   - Split `factory/README.md` into a short operator guide (setup, daily loop, what to do on each stop
     reason) and a generated reference (commands, states, settings, which already partly comes from
     code).
   - Move the SF-by-SF narrative to a CHANGELOG.
   - Fix the 13 broken links in `docs/README.md`.
   - Write ADR-0006 as the current reviewer decision instead of a sixth amendment.
   - Remove ticket numbers from code comments over time: 746 in `src/`. The comment should say what and
     why; `git blame` says when.

7. **Prove it on real work before widening it. Calendar time, low effort.**
   - Run the next ten tickets on product repositories, not on the factory. Track per ticket: total cost
     (Claude USD plus Codex tokens), wall time, human minutes, rounds, and defects found after merge.
   - Freeze new factory features until that data exists.

8. **Make it adoptable. A week, only after 1–3.**
   - An `sf doctor` that checks every prerequisite.
   - One install and update command, replacing the manual runbook sequence.
   - A written trust model: what the agent can read, reach and push.
   - Per-workspace isolation of state, so company and personal projects do not share one readable tree.
   - A combined cost view in `sf metrics`.

---

## Appendix A: commands run and their results

- `npm run typecheck` before `npm ci`: **failed** with 19 errors, all in `test/browser/*` (TS2307 `playwright`
  not found, TS7006 implicit any).
- `npm test` before `npm ci`: **ran no tests**, because `tsc` failed first.
- `npm ci`, then `npm run typecheck`: passed.
- `npm test` (the glob `dist/test/*.test.js`): included 4 stale compiled tests of deleted sources.
  `auth-serve.test.js` hung for more than 6 minutes, and I stopped the run.
- `node --test` over the 61 current test files only: 627 tests, 617 pass, 10 fail, 4 min 4 s.
- Serial rerun of `sandbox-lock`, `live-smoke` and `runner` tests: 29 tests, 27 pass. The 2
  `staleSandboxLock` tests fail every time. The others were flaky under parallel load.
- Count of the user's own processes with an unreadable `/proc/<pid>/fd`: 5 (including `ssh-agent`
  and `(sd-pam)`).
- `sf metrics`, `sf status`: read only. The status shows 2 live jobs (ABC-3 `handed_over`, SF-040
  `pushed`).
