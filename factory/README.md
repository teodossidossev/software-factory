# software-factory

The local factory process. It serves the planning tools to the Context owner (ChatGPT or any MCP
client), runs the jobs and provides the `sf` command. How to work with it is in [HANDBOOK.md](HANDBOOK.md); the
vocabulary is in [../CONTEXT.md](../CONTEXT.md).

The MCP endpoint serves only the planning tools (`guide`, `read_file`, `search`, `write_task`):
the Context owner reads the repository, discusses the ticket with the user and writes the Task file
with its `## Review brief`. The user starts the job, with the Start button of the ticket on the
dashboard or with `sf start`. The Implementer runs as a headless Claude
Agent SDK session (`@anthropic-ai/claude-agent-sdk`, pinned in `package.json`) in a worktree of
the job, inside Claude Code's sandbox. At Clean the Implementer writes the merge request text
and the factory commits and rebases, and the user finishes the ticket with approve (the push) or abort, from the terminal (`sf approve`,
`sf abort`) or from the dashboard (section Dashboard), or with `sf reset` (terminal only), and is
told about the states that need them through a desktop notification and ntfy. Every published
iteration is reviewed by a fresh read-only Claude session and, when it finds it clean, by the Codex
gate (section Jobs); their fix verdicts become the next Fix section without anyone in between.

## Commands

```sh
npm install && npm run build      # once, inside factory/
bin/sf workspace add <name> --read <path>   # the local checkout; every job works in a worktree of it (--work is retired)
bin/sf workspace list
bin/sf workspace remove <name>
bin/sf serve                      # foreground; Ctrl+C stops it; prints the dashboard URL
bin/sf up [--no-open] [--no-tunnel]   # sf serve plus the tunnel (../scripts/sf-tunnel.sh run, output prefixed "tunnel | ") and the dashboard opened in the browser; Ctrl+C stops both; npm start at the repository root
bin/sf dashboard [--open]         # the dashboard URL of the last sf serve start; --open opens it with xdg-open; works without sf serve
bin/sf start <workspace> <ticket> # start the job in a worktree of its own (same as the dashboard's Start); needs sf serve
bin/sf say <workspace> <ticket> <message...>   # a user message into the session; needs sf serve
bin/sf review <workspace> <ticket>             # retry a failed Claude review (needs_human with review_failed); needs sf serve
bin/sf accept <workspace> <ticket>             # accept a clean Claude review over a stopped gate (gate_rounds, gate_budget, gate_failed) and prepare the MR; needs sf serve
bin/sf status [<workspace> <ticket>]           # one job (with its worktree, sensitive and deleted paths) or all jobs, with estimated cost and elapsed time; works without sf serve
bin/sf watch <workspace> <ticket> [--once]     # the session live; works without sf serve
bin/sf approve <workspace> <ticket> [--as-is]  # push the branch prepared at Clean; --as-is pushes a tip edited by hand; needs sf serve
bin/sf mr create <workspace> <ticket>          # open the job's merge request on GitHub or GitLab (or reuse the open one); from ready_for_human_review: approve, then open; needs sf serve
bin/sf mr merge <workspace> <ticket>           # merge the job's open merge request through the host's API (refused with the host's reason); needs sf serve
bin/sf mr status <workspace> <ticket>          # the merge request on the host: open, merged or closed, mergeable or why not, the checks; needs sf serve
bin/sf abort <workspace> <ticket> [--discard]  # end the job; the worktree stays (its path printed); --discard removes the worktree and the branch; needs sf serve
bin/sf reset <workspace> <ticket>              # end the session, remove the worktree and archive the job; the branch stays; needs sf serve
bin/sf notify-test                             # one test notification on every channel; works without sf serve
bin/sf info                                    # version, directories, settings (gate: codex <version or path> | off (<reason>)), sf serve and tunnel state, workspaces, jobs; works without sf serve
bin/sf run <workspace> <ticket>                # the job's runner (section Jobs); sf serve starts it detached, one per job; refused (runner_running) while the job has one
npm run typecheck && npm test
```

Exit codes: 0 ok, 1 error, 2 usage. `sf approve` exits 1 unless the branch was pushed; `sf mr
create` exits 1 when the push or the merge request failed (the branch may be pushed then: the
output says so).

`sf up` is `sf serve` in the same process, then the tunnel as a child process (`SF_TUNNEL_SCRIPT`
names another script) and the dashboard through `xdg-open` once serve listens. When the script is
missing, its check fails (no profile or key: `scripts/sf-tunnel.sh check`) or the tunnel exits on
its own, one `tunnel | ...` line says so with the runbook path and `sf up` goes on without it; it
is not restarted (`npm run tunnel` in another terminal once it is fixed). A launcher failure is
one `sf: ...` line and the printed URL stays usable by hand. A signal stops the tunnel first, then
the servers, exit code 0.

### sf status

One line per current job (archived ones excluded), sorted by workspace and ticket: `WORKSPACE`,
`TICKET`, `STATE`, `ITER` (published iterations), `BRANCH`, `SINCE` (the last state change, in
local time), `EST_USD`, `ELAPSED` and `ERROR` (the error code; `sf status <workspace> <ticket>`
prints the message below the table). Both work without `sf serve`; they read the state directory.

- `EST_USD` is the recorded cost, an estimate of the API-equivalent price and not a charge: the
  session usually runs on the user's Claude plan. It is the sum of `cost_usd` over
  `meta.json` of the published iterations 1 to `iteration`, plus the `cost_usd` of their reviews
  (`review.json`; a failed review adds nothing), with four decimals (`0.0000` for a real zero or no iteration yet).
  A running iteration or an MR preparation turn adds nothing until its iteration is published, and
  `cost_usd_total` is never used. `unknown` means a published iteration has no usable cost (its
  `cost_usd` is null or missing, or its `meta.json` is missing); an unreadable or malformed
  `meta.json` is an error.
- `ELAPSED` is wall-clock time since `created_at` as `HH:MM:SS` (hours go beyond 23), including
  waiting for review, for the user and for MR preparation. For a job in `pushed`, `aborted` or
  `failed` it ends at `updated_at` and stops growing; for every other state it ends now.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SF_PORT` | `8787` | Port of `http://127.0.0.1:<port>/mcp` (loopback only, Host and Origin checked). |
| `SF_ENV_FILE` | `~/.config/software-factory/auth.env` (a historical name) | Environment file every `sf` command reads first: `KEY=VALUE` lines, `#` comments, optional `export`, quotes allowed; a variable already set in the environment wins; a missing file is fine. Empty value: no file. The repository root's `npm run serve` relies on it. |
| `SF_DASHBOARD` | on | `off` starts no dashboard listener (and removes an old `dashboard-token`). |
| `SF_DASHBOARD_PORT` | `8788` | Port of the dashboard, `http://127.0.0.1:<port>/d/<token>/` (loopback only, Host and Origin checked). |
| `SF_CONFIG_DIR` | `${XDG_CONFIG_HOME:-~/.config}/software-factory` | Directory of the workspace registry. |
| `SF_HANDBOOK` | `factory/HANDBOOK.md` | Handbook served as instructions (its `## Quick start` section) and by `guide`. |
| `SF_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/software-factory` | Job state and the `sf.sock` socket. |
| `SF_WORKTREE_ROOT` | `${SF_STATE_DIR}/worktrees` | Where every job's worktree is created: `<root>/<workspace>/<ticket>`; absolute. |
| `SF_MAX_JOBS` | `3` | Live jobs per workspace; a further `start` is `job_limit`. |
| `SF_SENSITIVE_PATHS` | empty | Comma-separated globs added to the sensitive paths of `src/rules.ts`. |
| `SF_CHECK_AFTER_START_MIN` | `15` | `check_after_minutes` in the result of a start and of the job's status during the first iteration. |
| `SF_CHECK_AFTER_FIX_MIN` | `5` | `check_after_minutes` in the job's status during later iterations. |
| `SF_MAX_TURNS` | `150` | `maxTurns` of every Implementer turn. |
| `SF_MAX_ITERATIONS` | `5` | Fix sections a job may get (the reviewers', counted in the job's `fixes`); the next Fix is refused (`iteration_limit`, job `needs_human`). An `sf say` turn does not count. |
| `SF_CLAUDE` | bundled binary | Absolute path of the Claude Code executable (`pathToClaudeCodeExecutable`). |
| `SF_MODEL` | unset | Model of every Implementer turn, passed as is as the `model` option of `query()`; unset uses the user's Claude Code default. |
| `SF_REVIEW` | on | `off` runs no Claude review (nor the gate): a published iteration stays in `awaiting_review` until the user goes on with `sf say` or aborts. |
| `SF_REVIEW_MODEL` | unset | Model of the Claude review, passed as is as the `model` option of `query()`; unset uses the user's Claude Code default. |
| `SF_REVIEW_MAX_TURNS` | `60` | `maxTurns` of the Claude review. |
| `SF_GATE` | `codex` | The gate after a clean Claude review (SF-039): `codex` runs the Codex CLI, `off` lets the Claude verdict decide. With `codex` and no executable found the gate is off, and `sf serve` prints one line saying so. |
| `SF_CODEX` | `codex` on `PATH` | Absolute path of the Codex CLI executable. Pointing at nothing turns the gate off; it is not looked for on `PATH` then. |
| `SF_CODEX_MODEL` | unset | Model of the gate, passed as `--model`; unset uses Codex's default (the user's `~/.codex/config.toml`). |
| `SF_GATE_MAX_ROUNDS` | `5` | Fix verdicts of the gate per job (the job's `gate_fixes`); the next one is not applied (`gate_rounds`, job `needs_human`). |
| `SF_GATE_MAX_TOKENS` | `5000000` | Input plus output tokens of all gate runs of a job (the job's `gate_tokens`); a gate does not start at the limit, and a run that goes over it is not applied (`gate_budget`, job `needs_human`). |
| `SF_GATE_TIMEOUT_MS` | `900000` | How long one gate run may take; then SIGTERM, and SIGKILL 5 s later (`gate_failed`). |
| `SF_SANDBOX` | on | `off` runs the Implementer and the review without Claude Code's sandbox. |
| `SF_SANDBOX_DOMAINS` | empty | Comma-separated extra hosts sandboxed commands may reach, besides `registry.npmjs.org`. |
| `SF_DESKTOP_NOTIFY` | on | `off` disables the desktop notification. |
| `SF_NOTIFY_ITERATIONS` | off | `on` also notifies `awaiting_review` (each published iteration). |
| `SF_NTFY_URL` | unset | Full ntfy topic URL, e.g. `https://ntfy.sh/<topic>`; unset disables ntfy. |
| `SF_NTFY_TOKEN` | unset | Sent as `Authorization: Bearer <token>` to a server that needs it. |
| `SF_GITHUB_TOKEN` | unset | The GitHub token of the merge request actions (SF-048): a fine-grained token with Pull requests read/write and Contents read on the repository (Checks read too for the checks in `sf mr status`). Sent only as `Authorization: Bearer <token>` to `https://api.github.com`. Unset turns the actions off for workspaces on `github.com`, saying so. |
| `SF_GITLAB_TOKEN` | unset | The GitLab token (scope `api`) of the merge request actions, sent only as `Authorization: Bearer <token>` to the GitLab API of the workspace's origin host. Unset turns the actions off for GitLab workspaces. |
| `SF_GITLAB_URL` | `https://<host>/api/v4` | The GitLab API base when it differs (another port or path; `http` only on loopback, so the token never travels in cleartext: any other `http` URL is refused at start). Set, the GitLab token goes to this URL only, and only for workspaces whose origin is on its host name; other hosts are refused (`mr_host_unsupported`). |
| `SF_GITHUB_API` | `https://api.github.com` | Tests only: the fake GitHub on loopback (`127.0.0.1`, `localhost` or `[::1]`); any other host is refused at start. |
| `SF_TEST_HOOKS` | off | Tests only. `on` makes `sf serve` answer the socket commands `check`, `fix` and `clean` (the reviewers' verdict paths without a review session) for the end-to-end tests. Never set it in real use. |

The socket path `${SF_STATE_DIR}/sf.sock` must fit a Unix socket address (107 bytes on Linux);
a longer one is refused at start with `socket_path_too_long`.

The execution variables are read once when `sf serve` starts. `sf status` and `sf watch` read
`SF_STATE_DIR` themselves; `sf start`, `sf say`, `sf review`, `sf accept`, `sf approve`, `sf mr`, `sf abort` and `sf reset` use it to find the socket; `sf notify-test` reads the notification variables itself.

## Jobs

One job per ticket; several jobs of a workspace at a time, up to `SF_MAX_JOBS` (default 3) in a
live state (`starting`, `working`, `awaiting_review`, `needs_human`, `ready_for_human_review`,
`preparing_mr`); `pushed`, `aborted` and `failed` free a slot. A further `start` is refused with
`job_limit`, naming the live tickets. Every job works in a **worktree** of its own (SF-019,
ADR-0004): `${SF_WORKTREE_ROOT:-<state dir>/worktrees}/<workspace>/<ticket>`, created from the
workspace's checkout; the checkout itself (the user's IDE checkout) is never written by the
factory beyond its Git refs (branches) and worktree registrations.

The job operations below are the Execution's (`src/execution.ts`): the user starts a job (the
dashboard's Start, `sf start`), the reviewers' verdicts take the fix and the clean paths, and the
user goes on with `sf say`, approve, abort or reset. None of them is an MCP tool.

**Each job runs in its own process** (SF-042, `src/runner.ts`). `sf serve` creates the job at
`start`; the job's turns, its reviews and its gate run in the job's **runner**, `sf run <workspace>
<ticket>`, a detached child process (a session of its own: neither Ctrl+C nor the end of `sf serve`
reaches it). The runner resumes the Implementer session by `session_id`, runs the queued turns,
publishes, runs the review and the gate, applies their verdict (the Fix section, Clean and MR
preparation), writes the job's state, sends the notifications, and exits when the job waits for a
person (`needs_human`, `ready_for_human_review`, `awaiting_review` with no review to run) or has
ended. A restart of `sf serve` therefore leaves a working job working.

- One runner per job: `runner.pid` in the job directory holds its pid (and, from `/proc`, its start
  time, so a reused pid is not taken for it); a second `sf run` of the job is refused with
  `runner_running`, and a lock whose process is gone is taken over. Before `sf serve` starts a
  runner for a job whose last runner was killed or crashed, what that runner left behind (its
  process group: Claude Code, Codex) is ended.
- `sf serve`, the dashboard and the CLI read the state from disk and talk to the runner only
  through files: `start`, `sf say`, a Fix section, Clean, `sf review` and `sf accept` write a request
  into `queue/` of the job directory (the state is checked first, so a refused request starts no
  runner), start a runner when none runs, and wait for the runner's answer in `replies/` (at most
  120 s: `runner_timeout`; a runner that ends without answering, or that is started three times
  and never takes the request: `runner_failed`). `start` does not
  wait: it answers once the job is `working` and its first turn queued. A request queued while a
  turn runs is taken by the runner and, for `sf say`, waits in the session as the next turn.
- `sf abort` and `sf reset` stop the runner with SIGTERM (SIGKILL after 15 s): its turn, review and
  gate end without their outcome being applied, and what the runner started that is still left
  (its process group) ends too; then `sf serve` changes the state. `approve` and the merge request
  stay in `sf serve` (they only push and talk to the Git host); `approve` and `sf mr create` wait
  up to 10 s for the job's runner to end and are refused with `runner_active` while it runs or a
  request (`sf say`, a fix) waits for it.
- The runner's output goes to `runner.log` in the job directory. The dashboard of `sf serve`
  follows the state the runners write through the job files (`fs.watch`, and a look every second).
- The Git operations on a workspace's checkout (fetch, worktree add and remove, the commit and
  rebase at Clean, push) are serialized across the processes by `locks/git-<workspace>.lock` in the
  state directory.

- `start` reads `.software-factory/<ticket>.md` of the checkout (its `base` and `title`), fetches
  `origin <base>` when `origin` exists (60 s), refuses an existing branch (`branch_exists`) or a
  leftover worktree directory or registration (`worktree_exists`; `sf reset` of the ticket removes
  it), runs `git worktree add --no-track -b <ticket>-<slug> <path> <origin/base or base>` and,
  when `.gitmodules` exists, `git submodule update --init --recursive` in the worktree (120 s).
  The Task file is copied into the worktree (`.software-factory/<ticket>.md`, the directory
  excluded through the shared `info/exclude`), and the first turn `/implement
  .software-factory/<ticket>.md` runs with the worktree as cwd. A previous job of the ticket in
  `failed`, `aborted` or `pushed` is archived first; any other state refuses (`job_exists`). The
  record and the validation are under the job lock, the fetch and the worktree creation under
  the workspace's Git lock, so a long fetch holds no other job.
- When the session is idle (its last queued turn ended), the factory publishes an iteration: the
  Report (the last assistant text, plus `## Changed files` and `## Denied actions`), the Patch
  (`git diff <base commit>` plus untracked files in the worktree, without ignored,
  credential-like and `.software-factory/` paths, at most 2 MiB) and the structured file list
  (`files` in `meta.json`, SF-024: `path`, `status` added/modified/deleted, `sensitive`
  declared/undeclared/no, `additions`, `deletions`). The job goes to `awaiting_review`, and the
  Claude review of the iteration starts (below).
- The **review** (SF-038, `src/review.ts`) runs on every published iteration, after an Implementer
  turn and after the conflict re-publication of MR preparation, unless `SF_REVIEW=off`. It is a
  fresh Agent SDK `query()` (never `resume`) in the worktree, read-only: the tools `Read`, `Grep`
  and `Glob` only (`tools`), and `Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`,
  `Task`, `Agent` and the `.env` rules denied as well. It has the Implementer's permission mode,
  sandbox and filtered environment, `maxTurns` `SF_REVIEW_MAX_TURNS` and model `SF_REVIEW_MODEL`.
  It sees the Task file, the Report, the Patch and the repository, nothing the user wrote outside
  it (SF-050): `settingSources: ['project']` keeps the repository's `CLAUDE.md`, `AGENTS.md`,
  `.claude/rules` and `.claude/settings.json` and leaves out the user's settings and
  `~/.claude/CLAUDE.md`; `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in its environment leaves out the
  user's auto-memory of the project, which Claude Code loads whatever the setting sources; and
  `claudeMdExcludes` (in the `settings` option) lists the `CLAUDE.md`, `.claude/CLAUDE.md`,
  `AGENTS.md`, `.claude/AGENTS.md` and `.claude/rules/**` of every directory above the worktree,
  which Claude Code would otherwise load as project instructions (`~/CLAUDE.md`, and
  `~/.claude/CLAUDE.md` or `~/.claude/AGENTS.md` read as the home directory's). `CLAUDE.local.md`
  needs no exclude: it loads only with the `local` setting source. The Implementer's session keeps
  `['user', 'project']`.
  Its prompt says what to verify, then carries the Handbook's `## Review rules for the Context
  owner` verbatim, the Task file (with its `## Review brief` when there is one), the Report, the
  sensitive and deleted paths of the iteration and the Patch inline up to 256 KiB (beyond that, the
  first 256 KiB and a note to read the changed files). Its output is structured
  (`outputFormat: {type: "json_schema"}`), validated with zod: `{verdict: "clean" | "fix", summary,
  items: [{path, problem, expected}], accepted_sensitive}`. The SDK hands the schema to the Claude
  Code CLI as `--json-schema`. It is generated as draft-07 and sent without `$schema`, because the
  CLI refuses the draft 2020-12 `$schema` that zod writes by default (SF-044). The fake Claude of
  the tests refuses such a schema the same way.
- The review runs outside the execution lock. Its verdict is applied under the lock only while the
  job is still `awaiting_review` at the same iteration; otherwise (an `sf say` or an abort came
  first) it is recorded and ignored. `fix` writes `## Fix N` from the items (the
  summary as a lead line, then one numbered item per entry: path, what is wrong, what is expected)
  and runs the next iteration (the fix path, below). `clean` runs the clean path (below) with
  `accepted_sensitive`; an undeclared sensitive path it does not accept turns it
  into a fix item instead. A review that fails (an error, a turn that is not a success, no or an
  invalid structured output, `fix` without items) puts the job in `needs_human` with
  `review_failed`; nothing is retried by itself. `sf abort` and `sf reset` cancel a running review, whose
  outcome is then never applied; a newer review of the same job cancels an older one.
- Every review that ends is kept in `iterations/NNN/review.json`: `{reviewer: "claude", verdict,
  summary, items, accepted_sensitive, cost_usd, started_at, ended_at}`, or `{reviewer, error}` when
  it failed. One line goes to `events.jsonl`: `{type: "review", reviewer, verdict, items: <count>}`
  or `{type: "review_failed", reviewer, error}`, with `ignored: true` when the job had moved on.
  `sf watch` and the dashboard's Event stream show it as `review by claude: fix (3 items)`,
  `review by claude: clean` or `review by claude failed: <error>`. A cancelled review leaves no
  outcome.
- The reviewers live (SF-045): while a review runs, every SDK message of its session goes to
  `events.jsonl` as it arrives: `{ts, iteration, type: "review_message", reviewer: "claude",
  message}`; while a gate runs, every JSONL event of Codex's stdout that parses (other lines are
  skipped): `{ts, iteration, type: "gate_event", reviewer: "codex", event}`. A message or event
  whose JSON is above 16 KiB is cut (its strings and lists shortened) and carries `truncated:
  true`. Only the message or event itself is logged, and redacted first (`src/redact.ts`, one
  redactor per run, before the cut):
  - every value of the factory's environment, as a whole value and whatever its length, becomes
    `[redacted:<NAME>]`, except the variables named public in `src/redact.ts`: the shell's and
    the desktop session's (`HOME`, `PATH`, `USER`, `LANG`, `LC_*`, `XDG_*`, `npm_package_*`,
    `npm_lifecycle_*` and the like; not `npm_config_*`) and the factory's own settings that hold
    no secret, listed one by one (not `SF_NTFY_TOKEN` or `SF_NTFY_URL`). A short
    value of another variable (`1`, `on`) shows as `[redacted:<NAME>]` wherever it stands alone,
    except in the fields the protocol sets (`type`, `subtype`, `role`, the ids, `status`);
  - keys by their form become `[redacted]`: `sk-…`, `ghp_…`, `github_pat_…`, `AKIA…`, `xox?-…`,
    `AIza…`, JWTs, `Bearer`/`Basic` credentials, URL credentials, private key blocks, upper-case
    assignments whose name ends with KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL(S)
    (`OPENAI_API_KEY=…`), and quoted JSON, TOML or INI values of a field named that way
    (`"access_token": "…"`, `api_key = "…"`, `"apiKey": "…"`);
  - `[withheld: it may hold the environment or a file outside the worktree]` replaces the output
    of a Codex command that reaches outside the worktree (`~`, `$HOME`, `..`, `$CODEX_HOME`, `cd`
    alone, an absolute path not in the worktree other than `/dev/null` and the like), prints the
    environment (`env`, `printenv`, also by a path, `export`/`declare` without an assignment, `set`
    alone) or reads it (an interpreter with `os.environ`, `process.env`, `getenv`; a secret
    variable); an output that shows `~/.codex` or another dotfile of the home by its path (the
    worktree's own paths aside, which by default lie under `~/.local/state`), or names one the
    short way (`~/.codex/config.toml`), or holds three lines in the shape of an environment dump;
    the result, and arguments or errors that name such a file, of an MCP tool call; and the result
    of a review tool use whose path (or Glob pattern) reaches outside the worktree, or that shows
    or names such a file.
  - Such a read (a command or tool use reaching outside, an output showing a home file by its
    path, an MCP result) marks the run: from then on every string field of every later Codex
    event and Claude review message is withheld (messages, reasoning, outputs, errors of any
    shape, tool inputs and results, the result text, errors and structured verdict), but the
    protocol's fields (`type`, `subtype`, `role`, the ids, `status`), Codex's command lines and
    the review's tool names; numbers (exit codes, token counts) stay. Within one review message,
    the blocks before the read stay. Before that, prose is withheld only when it shows or names a
    home file as above, and so is a Codex error or failed turn message. A search for these words
    inside the worktree (`rg process.env`, `rg .codex`) does not mark the run.
  - The failure message of a review or a gate (`review.json`, `gate.json`, the `review_failed`
    line, the job's error) is redacted the same way and withheld like prose: the factory's
    lead-in up to the first `: ` stays (`Codex reported an error: `), and the detail after it
    (Codex's error or stderr, the review's errors) is withheld when it shows or names a home file
    or the run has read something withheld.
  - **Known issue.** Codex's command lines stay readable after a run is marked, so a command
    that repeats a value it read outside the worktree (`echo <value read from ~/.codex>`) shows
    that value on its `codex | $ …` line, in `events.jsonl` and in `sf watch`, unless the value
    is in the environment or has the form of a key. The Codex gate raised this on SF-045; it was
    accepted so that the live log keeps the commands, which are its point.

  A cancelled run keeps what it logged until then. `sf watch` and the Event stream
  show them one line each, before the verdict line:
  - Claude review: `review | <tool>(<file or pattern>)` for a tool use, `review | <text>` for each
    line of assistant text; its init, tool results and result show nothing.
  - Codex: `codex | $ <command>` when a command starts, `codex | exit <code>` and up to three
    lines of its output (`…` when there are more) when it completes, `codex | <text>` for each
    line of an agent message, `codex | reasoning: <first line>`, `codex | turn completed (<input>
    in, <output> out tokens)`, `codex | error: <message>` for an error, a failed turn or an error
    item; other events show nothing.
  - A cut one ends with ` (cut)`; one that would show nothing shows `codex | <event type> (cut)`
    (`review | <message type> (cut)`).
- `sf review <workspace> <ticket>` (SF-044), or Retry review on the dashboard, retries a failed
  review. The job goes back to `awaiting_review` with its error cleared, at the same iteration (a
  state change, no new iteration). The failed `review.json` of the last iteration is removed, and
  the review of that iteration starts again. It is refused with `invalid_state` unless the job is
  `needs_human` with `review_failed`, and with `review_off` when `SF_REVIEW=off`. The worktree must
  still exist (`worktree_missing` otherwise).
- `sf accept <workspace> <ticket>` (SF-047), or *Accept and prepare MR…* on the dashboard, lets the
  user override the gate once it stopped the job: `needs_human` with `gate_rounds`, `gate_budget` or
  `gate_failed`, and a clean Claude review of the last iteration (`review.json` with verdict
  `clean` that accepts every undeclared sensitive path). The job then takes the same path as after a
  clean gate: MR preparation with the paths Claude accepted, so the factory commits, rebases and the
  job goes on to `preparing_mr` and `ready_for_human_review` as usual. Before it moves on, the
  override is recorded: `iterations/NNN/gate-override.json` `{at, code, unapplied}` (`unapplied`
  is the Codex items of that iteration's `gate.json`, its error when the gate failed, or `[]` when
  no gate ran on it) and a `gate_overridden` event `{type: "gate_overridden", code, unapplied: <count
  of items>}`, which `sf watch` shows as `gate overridden by the user (gate_rounds): 2 Codex items not
  applied` and the dashboard's state history lists. Any other state or code, or a Claude review that
  is missing, failed, says fix or leaves an undeclared sensitive path unaccepted, is refused with
  `invalid_state` and the reason; the MR preparation's own refusals (`worktree_missing`,
  `turn_running`) apply, and nothing is recorded when it is refused. This is the way on when Claude
  is clean and Codex keeps finding ever narrower variants (ADR-0005); the Codex items not applied
  stay visible for a follow-up ticket.
- The **gate** (SF-039, `src/gate.ts`) is the second, deciding review. With the gate on
  (`SF_GATE=codex` and a Codex executable found), a clean Claude verdict (after its sensitive-path
  rule) does not go to Clean: the factory runs the Codex CLI on the user's ChatGPT sign-in (it must
  be signed in: `codex login`; no API key), without a shell: `codex exec --ephemeral --sandbox
  read-only --disable memories -c memories.use_memories=false --cd <worktree> --output-schema
  <schema file> --output-last-message <out file> --json [--model SF_CODEX_MODEL] -`, the prompt on
  stdin. The schema and out files are `gate-schema.json` and `gate-output.json` in the iteration's
  directory. The user's `~/.codex/config.toml` and login apply; the environment is the factory's
  without any `SF_*` variable. The gate sees the Task file, the Report, the Patch and the
  repository with its `AGENTS.md` (SF-050): `--disable memories` and `memories.use_memories=false`
  keep the user's Codex memories out, whatever `config.toml` says. The user's global
  `~/.codex/AGENTS.md` (or `AGENTS.override.md`) still loads: Codex documents no switch for it, and
  `CODEX_HOME` is not moved, since the login refreshes itself there. Codex reads the worktree
  itself in its read-only sandbox. Its prompt is the review prompt adapted: the base commit (so
  it can run `git diff <base_commit>`), the read-only commands
  it may run, that it must not leave the worktree or read credentials, that it decides after a
  clean Claude review, then the same rules and material as the Claude review. The schema is the
  review's in the strict form structured outputs need (every property required,
  `additionalProperties: false` at every level); the out file is validated with the same zod
  schema. The JSONL on stdout gives the usage of `turn.completed` (`input_tokens`,
  `cached_input_tokens`, `output_tokens`) and the `error` events; stderr is kept, bounded, for the
  failure message.
- The gate runs outside the lock, like the review, and its verdict applies only while the job is
  still `awaiting_review` at the same iteration. `clean` runs the clean path with the union
  of both reviewers' `accepted_sensitive`; an undeclared sensitive path the gate does not accept is
  a fix item. `fix` writes `## Fix N` (lead line `Review by Codex: <summary>`) and runs the next
  iteration, which Claude reviews again, and the gate again after a clean verdict. The job counts
  the gate's fixes in `gate_fixes`: at `SF_GATE_MAX_ROUNDS` the next one is not applied
  (`needs_human`, `gate_rounds`, the message holds both reviewers' summaries). Every run adds its
  input plus output tokens to the job's `gate_tokens`: a gate does not start once they reach
  `SF_GATE_MAX_TOKENS`, and a run that takes them over it is recorded but not applied (both
  `needs_human`, `gate_budget`). A non-zero exit, a timeout, a missing or invalid output or a
  Codex `error` event is `needs_human` with `gate_failed` (the exit code or signal and the last
  error line); nothing is retried. `sf abort` and `sf reset` kill a running gate; its outcome is
  then never applied. `sf serve` kills a running gate when it stops.
- Every gate run that ends is kept in `iterations/NNN/gate.json`: `{reviewer: "codex", verdict,
  summary, items, accepted_sensitive, model?, tokens: {input, cached_input, output}, started_at,
  ended_at}`, or `{reviewer, error, model?, tokens, started_at, ended_at}` when it failed (`model`
  only with `SF_CODEX_MODEL`). Its event lines are the review's, with `reviewer: "codex"`: `review
  by codex: clean`, `review by codex: fix (2 items)`, `review by codex failed: <error>`.
- The job counts its Fix sections in `fixes` (the reviewers'). Once it reaches
  `SF_MAX_ITERATIONS`, the next Fix is refused: `needs_human` with `iteration_limit`. An `sf say`
  turn publishes an iteration but writes no Fix section, so it does not count.
- The fix path appends `## Fix N` to the Task file of the checkout, copies it into the worktree
  and runs `/implement .software-factory/<ticket>.md Fix N` in the same session (`resume`). From
  `ready_for_human_review` it first reopens a worktree from the branch (`git worktree add <path>
  <branch>`): the next iteration's Patch is the whole change against the target, and the next
  Clean commits the whole change again as one commit.
- The clean path runs the MR preparation (section below) and ends in `ready_for_human_review` with
  the branch in the checkout. It takes `sensitive`, the undeclared sensitive paths of the reviewed
  iteration the reviewers accept; any left out refuse it with `sensitive_unacknowledged`.
- Every prompt the factory sends (the `/implement` line of a start and of the fix path, or the user's
  message of `sf say`) is followed by a blank line and `FACTORY_PROMPT_RULES` (`src/prompts.ts`):
  the factory's rules and the Report template, with the ticket and iteration filled in.
- `check` (only the end-to-end tests call it, through `SF_TEST_HOOKS=on`) returns the last published Report and Patch in every state except `working` and
  `starting`, and `files`: the sensitive paths (with `declared`) and the deleted paths of that
  iteration. `meta.json` records `cost_usd` (this iteration's cost) and `cost_usd_total` (the
  SDK's cumulative total for the session). `check` also returns `review` for the last iteration:
  `{status: "running" | "done" | "failed" | "off", verdict?, summary?, gate?}` (`running` also while the
  review is due; `failed` with the error as `summary`). After a clean Claude verdict with the gate
  on, `gate` is the gate's status in the same form (no `off`; absent with the gate off).
- `sf say` queues a message as the next turn (in `working`, `awaiting_review`, `needs_human` or
  `ready_for_human_review`, where it reopens the worktree like the fix path); outside `working`
  the job goes back to `working` and publishes a new iteration at the end.
- A failed turn, a session that does not report permission mode `auto`
  (`permission_mode_mismatch`), an unavailable sandbox (`sandbox_unavailable`, with the SDK's
  message), a failed review (`review_failed`), a failed gate (`gate_failed`), the gate's round
  limit (`gate_rounds`) or token ceiling (`gate_budget`) or the iteration limit put the job in
  `needs_human`. After a gate code, `sf accept` (above) goes on to MR preparation; otherwise `sf
  say` starts another iteration.
  When `sf serve` starts, a job found `working`, `preparing_mr` or `awaiting_review` whose runner is
  alive is left alone. Without a live runner, jobs found `working` become `needs_human`
  (`serve_restarted`) and keep their session for `sf say`; jobs found `preparing_mr` become
  `needs_human` (`mr_serve_restarted`) (`sf say` goes on: its iteration is reviewed again); a job
  found `awaiting_review` whose last iteration has no `review.json` gets a runner that runs its
  review, and one whose last iteration has a clean `review.json` and no `gate.json` gets a runner
  that runs its gate (with the gate off by now, the Claude verdict runs Clean). Nothing is retried
  automatically.
- `check` also returns `mr`, the MR text, once MR preparation produced one.
- `sf abort` works in every non-terminal state: it stops the job's runner, which aborts the running
  turn (queued prompts and requests are dropped) and sets `aborted` without `error`; the branch and the worktree stay, and the
  worktree's path is printed (`worktree` in the result). `--discard` removes the worktree
  (`git worktree remove --force`, `git worktree prune`) and the branch (`git branch -D`); a
  failing step leaves `aborted` with `error.code` `discard_failed`. `--discard` is refused
  (`rebase_in_progress`) while a rebase or a Git lock is in progress in the worktree.
- `sf reset` works in every state: it stops the job's runner (ending a live session), removes the worktree and archives the
  job directory as `start` archives a terminal job. The branch is not touched. When the workspace is
  no longer registered (or its checkout is gone), only the job record is archived and the result
  says `checkout: unavailable`; the dashboard's Archive of a finished job behaves the same.
  That Archive checks the state and retires the job in one hold of the execution lock, so a job
  that replaced the finished one in the meantime is refused (`invalid_state`), never retired.
- The ticket actions Archive and Delete (dashboard start screen) run in one hold of the same lock:
  they check the ticket (a live job refuses with `job_active`), retire its finished job, and only
  then move or delete the Task and MR files (and, for Delete, the stored request). Restore and
  `start` wait for the whole action. A retirement that fails changes no file. A file operation
  that fails after a successful retirement is reported, but the job stays archived and the files
  stay as far as they got; nothing is rolled back.

The checkout's Git operations of one workspace (fetch, worktree add and remove, branch delete,
the commit and rebase at Clean, push) are serialized through one Git lock per workspace; turns, publication,
`check`, `say` and the start of another job run concurrently.

Every turn runs with `cwd` = the job's worktree, `permissionMode: "auto"`, `settingSources: ["user",
"project"]`, a deny list from `src/rules.ts` (mutating Git commands, `sudo`, `EnterWorktree`, `.git/**`
edits, `.env` files; the same for every turn, MR preparation included), a filtered environment (no
`SF_*`, no inherited Claude Code session markers) and, unless `SF_SANDBOX=off`, the sandbox
`{enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, network: {allowedDomains:
["registry.npmjs.org", ...SF_SANDBOX_DOMAINS], allowLocalBinding: true, allowAllUnixSockets: true}}`.
Local binding and Unix sockets are allowed so that the repository's own tests, which start servers on
loopback and on Unix sockets, run inside the sandbox. The factory's own `fetch`, commit, rebase and `push` run outside
the Implementer, so the Git host is not needed there; a repository whose checks need other hosts
(another package registry, a test service) lists them in `SF_SANDBOX_DOMAINS`. Nothing is written
under `~/.claude`.

The sandbox (bubblewrap) needs a mount point for every path it masks. When such a path does not
exist in the worktree it creates it as a zero-byte file with mode 0444 and leaves it there:
`.bashrc`, `.gitconfig`, `.gitmodules`, `.mcp.json`, `.claude/settings.json`, `.claude/skills` and
others, plus the empty directory `.claude/.cc-writes/` (Claude Code's own). The factory removes them
(`src/placeholders.ts`) after every turn, before the Patch is built and before the MR commit,
and in `abort` before the Git steps, and logs what it
removed as `placeholders removed: a, b, c` in `sf watch` and the dashboard. The exact rule: in the
root of the worktree an entry whose name starts with `.`, and in `.claude/` any entry, is
removed when it is a regular file (not a symbolic link) of size 0 with mode exactly 0444; then
`.claude/.cc-writes` and `.claude` are removed when they are empty directories. Nothing else is
touched: a file with content, a writable file, a symbolic link, a non-empty directory and anything
deeper or elsewhere stay. The Patch and the MR commit also skip an untracked file that matches
the rule, in case the sandbox recreates one after the cleanup. A file the factory left in place
does not match the rule, so it is a change of the Implementer's or the user's.

### Sensitive paths

`SENSITIVE_PATHS` in `src/rules.ts` (globs from the repository root: `*` and `?` inside one
segment, `**` across directories, `{a,b}` alternatives) names dependency manifests and lockfiles
(`package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `pom.xml`, `build.gradle*`,
`requirements*.txt`, `pyproject.toml`, `Pipfile*`, `go.mod`, `Cargo.toml`, `Gemfile*`,
`composer.json` and the like), environment and tool configuration (`**/.env*`, `**/*.env`,
`.npmrc`, `.nvmrc`, `.tool-versions`, `tsconfig*.json`, `*.config.{js,ts,mjs,cjs}`, `.eslintrc*`,
`.prettierrc*`, `.editorconfig`, `.gitignore`, `.gitattributes`, `.gitmodules`), CI and containers
(`.github/**`, `.gitlab-ci.yml`, `Jenkinsfile`, `Dockerfile*`, `docker-compose*.yml`,
`compose*.yml`, `.dockerignore`, `Makefile`), IDE and agent files (`.idea/**`, `.vscode/**`,
`.claude/**`, `CLAUDE.md`, `AGENTS.md`) and every dotfile in the root. `SF_SENSITIVE_PATHS`
(comma-separated globs) adds patterns. The Task file's front matter may declare `may_touch:` with
paths or globs the ticket is expected to change (`[a, b]` or `a, b`): a sensitive path matching it
is `declared`, every other sensitive path `undeclared`. The Report's `## Changed files` lists the
sensitive paths first under `### Sensitive` (each `declared` or `undeclared`, `deleted` when it
is) and the deleted paths under `### Deleted`; `sf status <ws> <ticket>` prints `sensitive:` and
`deleted:` lines; the `awaiting_review` (with `SF_NOTIFY_ITERATIONS=on`) and
`ready_for_human_review` notifications carry the same two lines (the body holds three lines, so
the ready notification shows the title and the sensitive line). `.env` files stay denied to the
Implementer; listing them is a second net for files created by tools it runs.

## MR preparation

MR preparation runs on the deciding clean verdict (the clean path, from `awaiting_review`, or as
the retry from `needs_human` after a failed preparation, `mr_attempts > 0`); never while a turn runs.
It ends in `ready_for_human_review` with the branch, holding exactly one commit, in the user's
checkout, and the worktree removed. `sf approve` then pushes that commit and nothing else.
The Implementer only writes the MR text. The factory commits and rebases itself, outside the
sandbox (ADR-0005): inside it, `git rebase` could not unlink the sandbox's placeholders.

1. Target: `git fetch origin <base>` (60 s) when `origin` exists, target `origin/<base>`, else the
   local `<base>`. Its commit is stored as `target_commit`. A rebase left in progress by a restart
   of `sf serve` is aborted first.
2. State `preparing_mr`, `mr_attempts + 1`, and the **MR text turn**: one turn in the same session
   with the deny list of every turn (all mutating Git commands stay denied) and `mrPrompt`
   (`src/prompts.ts`). The prompt names the target and, on a retry, the previous error. It asks
   for `.software-factory/<ticket>.mr.md` only: the first line is the title, which is also the
   commit header; a blank line; the body by the MR template. It says that the factory commits,
   rebases and pushes, and that the commit body is taken from the `## Why` section. It states
   `MR_TESTING_RULE` (`src/rules.ts`): `## Testing` lists only what was run in this job, with its
   result, and anything not run goes on a line starting with `Not checked:`, saying who can run
   it. It asks for a short report (`# Report: <ticket>, MR preparation <attempt>`, `## Done`,
   `## Open questions`) and ends with the Handbook's `## Git rules` and `## MR template` verbatim.
3. When that turn ends, the factory checks the MR text, then works in the worktree under the
   workspace's Git lock. Every Git call runs with `-c core.hooksPath=/dev/null`, so no repository
   hook runs outside the sandbox, and with a 60 s timeout.
   - `git reset -q --mixed <base_commit>` when the branch has commits on top of `base_commit` (a
     fix after Clean, or a retry after a commit). `HEAD` and the index go back to the base and the
     files stay, so the result is always one commit.
   - The paths: the Patch's paths against `base_commit` (tracked and untracked, without ignored,
     credential-like, `.software-factory/` paths and sandbox placeholders), minus submodules (a
     directory whose index entry has mode 160000). The Git rules forbid changing a submodule
     pointer; the Patch already reports one.
   - `git add --all -- <paths>`, 200 paths per call. An empty index diff is `mr_empty`.
   - `git commit -q -m <title> -m <body>`: the body is the non-empty lines of the MR text's
     `## Why` section, at most five. The identity and the signing configuration are the user's
     Git configuration.
   - `git rebase -q <target commit>`, unless the target is already an ancestor of `HEAD`.
4. A rebase that stops on conflicts (unmerged paths in `git diff --name-only --diff-filter=U`)
   stays in progress, the job stays `preparing_mr`, and the factory sends one **conflict turn**
   (`conflictPrompt`, the same deny list). It lists the files and asks the Implementer to resolve
   them by editing: keep the reviewed behaviour and the target's changes, leave no conflict
   markers, edit other files only as far as the merge needs them to build and pass, run the
   checks of those files, run no Git command, and report
   (`# Report: <ticket>, conflict resolution`, `## Done` per file, `## Checks`,
   `## Open questions`). When that turn ends:
   - a failed turn, or a listed file that still holds a line starting with `<<<<<<< `, `=======`
     alone or `>>>>>>> `, is `git rebase --abort` and `needs_human` with `mr_conflict`, naming the
     files;
   - otherwise the factory stages every change of the turn, not only the conflicted files:
     `git add --all` over the listed files plus the worktree's changes against the target, with
     the exclusions of its commit (`.software-factory/`, ignored, credential-like and placeholder
     paths, submodule pointers), then `git -c core.editor=true rebase --continue`;
   - a continue that fails keeps the resolution: before the abort the factory saves the resolved
     worktree as `iterations/NNN/conflict-resolution.diff` of the last published iteration
     (`git diff --binary <target commit>` of the working tree plus the untracked files, the paths
     of the Patch, uncut), then `git rebase --abort` and `needs_human` with `mr_conflict`, whose
     message gives Git's reason (stderr, or stdout when stderr is empty) and the patch's path.
     Nothing is retried; the user or the coordinator applies the patch on the target
     (`git apply --index`) and finishes by hand;
   - after a successful continue the change is no longer the reviewed one. `base_commit` and
     `target_commit` become the target, and a new iteration is published: the conflict turn's
     report plus `## MR preparation` (the rebase onto `<target ref>` (`<commit>`) had conflicts in
     `<files>`, resolved by the Implementer), and the Patch against the target. The worktree stays
     and the job goes back to `awaiting_review`. The next Clean commits again, and its rebase has
     nothing to do.
5. Failures end in `needs_human` with the worktree kept for the retry. Nothing is committed when
   the MR text fails its check.

   | Code | Meaning |
   |---|---|
   | `mr_text_missing` | `.software-factory/<ticket>.mr.md` absent or empty |
   | `mr_text_invalid` | over 64 KiB, a first line that breaks `commitHeader(ticket)` in `src/rules.ts` (`<type>(<ticket>): <summary>`, type one of `feat fix chore refactor docs test perf build ci style revert`, at most 72 characters, no trailing period), or a missing `## What`, `## Why`, `## How`, `## Why the change`, `## Special things to note`, `## Change outline`, `## Testing` or `## Checklist` heading, or a `## Testing` line that starts with `By hand` or `Manual` (after any list marker, checkbox or emphasis) and does not contain `not` (`testingProblem` in `src/rules.ts`) |
   | `mr_empty` | the reviewed change has nothing to commit against `base_commit` |
   | `mr_commit_failed` | `git commit` failed, for example without a Git identity (stderr in the message) |
   | `mr_rebase_failed` | `git rebase` failed without conflicts; it was aborted |
   | `mr_conflict` | the conflict turn failed or left markers, or the rebase did not continue; it was aborted. When the continue failed, the resolution is kept in `iterations/NNN/conflict-resolution.diff` (named in the message) |
   | `worktree_remove_failed` | the branch is prepared but the worktree could not be removed |
   | `mr_failed`, `mr_serve_restarted` | the factory failed, or `sf serve` restarted, during preparation |

   A failed MR text turn keeps its own code (for example `turn_failed` or `sandbox_unavailable`).
   Fix with `sf say` (its iteration is reviewed again, and a clean verdict prepares again) or by
   hand in the worktree followed by an `sf say`.
6. Ready: the MR text is copied to `mr.md`, `base_commit` and `target_commit` become the target,
   `prepared_commit` the branch tip, the worktree is removed (`git worktree remove --force`,
   `git worktree prune`; `worktree` becomes null) and the job is `ready_for_human_review`,
   notified with the MR title and the file lines. `git checkout <branch>` in the checkout then
   gives the user the change.
7. `sf approve` (or the dashboard's Approve): allowed in `ready_for_human_review`, and in
   `needs_human` after a failed push. It refuses when the branch tip is not `prepared_commit`
   (`branch_changed`, with both hashes: the user edited the branch by hand), unless `--as-is`
   (`as_is` on the dashboard) pushes the tip as it is; `branch_missing` when the branch is gone.
   Then `git push origin <branch>:<branch>` with the protection below (120 s); `pushed` with the
   title and the merge request link (GitHub's compare page for `github.com`, GitLab's new merge
   request form otherwise; only the branch when the `origin` URL cannot be parsed). A failed
   push is `needs_human` with `mr_push_failed` or `mr_push_protected`; `sf approve` again
   retries it.

   | Code | Meaning |
   |---|---|
   | `mr_push_protected` | the branch is `main`, `master` or the job's base: nothing is pushed there directly, every change goes through a merge request |
   | `mr_push_failed` | `git push origin <branch>:<branch>` failed (120 s; stderr in the message) |

8. `sf mr create` (or the dashboard's Create merge request, SF-048): for a `pushed` job, opens a
   pull request (GitHub) or merge request (GitLab) from the branch into the base, titled with the
   MR text's first line, the rest of the MR text as the body; one already open for the branch is
   reused, never duplicated. From `ready_for_human_review` (or `needs_human` after a failed push)
   it is approve and then the merge request, in one action; the host and the token are checked
   before anything is pushed. The host is chosen from the checkout's `origin` URL (as for the
   compare link): `github.com` is GitHub, any other host GitLab (except hosts known not to be
   GitLab). The job records `mr: {host, number, url, state: "open"}`, appends a `merge_request`
   event, and the notification and the dashboard show the link. A merge request that fails to
   open after a push leaves the job `pushed`, with the failure in the result.
9. `sf mr merge` (the dashboard's Merge): merges the job's open merge request through the host's
   API: GitHub's merge method `merge` with GitHub's own commit title, GitLab's `PUT .../merge`.
   No push, no force. A draft, a conflict or anything else the host refuses (failing required
   checks, missing approvals) is `mr_not_mergeable` with the host's reason, and nothing changes.
   Merged: `mr.state` `merged`, `mr.merge_commit`, a `merge_request` event and a notification.
10. `sf mr status` (the dashboard's Refresh MR status): what the host says now: open, merged or
    closed, draft, mergeable or why not, and the checks (GitHub's check runs of the head commit,
    GitLab's head pipeline) when the host reports them. A merge request merged or closed on the
    host meanwhile is recorded so, without a notification.

   | Code | Meaning |
   |---|---|
   | `mr_token_missing` | the workspace's host has no token: `SF_GITHUB_TOKEN` or `SF_GITLAB_TOKEN` is named |
   | `mr_host_unsupported` | the origin names no GitHub or GitLab repository, or a host other than `SF_GITLAB_URL`'s |
   | `mr_auth_failed` | the host refused the token (401); the message names the variable, never the token |
   | `mr_host_error` | the host refused the request (its status and words), or answered with a redirect, which is never followed |
   | `mr_host_unreachable` | the host did not answer (30 s) |
   | `mr_not_mergeable` | the host cannot merge it: a draft, conflicts, failing required checks, ...; the host's reason in the message |
   | `mr_not_open` | the merge request is merged or closed on the host |
   | `mr_host_changed` | the job's merge request is on another host than the checkout's origin now is |

   The tokens are read from the environment file, kept out of every child process (the
   Implementer, the reviewers, Git, `notify-send`), never logged and never written to a job file;
   `sf info` says only whether each is set, and shows `SF_GITLAB_URL` as checked at start; a
   refused `SF_GITHUB_API` or `SF_GITLAB_URL` is named in its message with any credentials, query
   or fragment replaced by `[redacted]`.

## Notifications

On `ready_for_human_review`, `needs_human`, `pushed` and `failed` (iterations are silent unless
`SF_NOTIFY_ITERATIONS=on`, which adds `awaiting_review` with `Priority: default`, `Tags: eyes` and
the body "Report and Patch of iteration N are ready for the reviewers") the
factory sends a desktop notification (`notify-send --app-name="Software Factory" "<ticket>:
<state>" <body>`, 5 s, when `notify-send` is on `PATH`) and, with `SF_NTFY_URL` set, one ntfy POST
(10 s; headers `Title`, `Priority` high for `needs_human` and `failed`, `Tags`). The body has at most
three lines: the branch, the error, or the MR title and link when pushed. Once the factory opens
or merges a merge request (SF-048), the title is `<ticket>: merge request #<n> opened` (or `merged`)
and the body has its link. A failure never changes
the job; it is appended to `events.jsonl` as `{type: "notify_failed", channel, message}` and shown
by `sf watch`. `sf notify-test` sends one test notification on both channels and prints what each
did.

ntfy is a push notification service: install the ntfy app on the phone and add a topic
name of your choice, then set `SF_NTFY_URL` to that topic's URL (for example
`https://ntfy.sh/<topic>`). On the free public server the topic name is the only secret, so make it
long and unguessable.

State layout under `${SF_STATE_DIR}`:

```
sf.sock                                  # 0600, while sf serve runs; one JSON request/response per connection
dashboard-token                          # 0600, the dashboard token of the last sf serve start
jobs/<workspace>/<ticket>/job.json       # workspace, ticket, branch, base, base_commit, target_commit, worktree, prepared_commit, mr_attempts, state, iteration, fixes, gate_fixes, gate_tokens, session_id, created_at, updated_at, error, mr ({host, number, url, state, merge_commit?} or null)
jobs/<workspace>/<ticket>/events.jsonl   # {ts, iteration, message | prompt | state | type: "notify_failed" | "review" | "review_failed" | "review_message" | "gate_event" | "gate_overridden" | "merge_request" | ...}; what sf watch reads
jobs/<workspace>/<ticket>/iterations/NNN/{report.md,patch.diff,meta.json,review.json,gate.json,gate-override.json,gate-schema.json,gate-output.json,conflict-resolution.diff}
worktrees/<workspace>/<ticket>/          # the job's worktree (SF_WORKTREE_ROOT), from start to Clean, abort or reset
jobs/<workspace>/<ticket>/mr.md              # the MR text, once the branch is ready or after a conflict iteration
jobs/<workspace>/<ticket>/runner.pid     # the pid of the job's runner (sf run) while it runs (SF-042)
jobs/<workspace>/<ticket>/queue/, replies/   # sf serve's requests to the runner, one JSON file each, and the runner's answers
jobs/<workspace>/<ticket>/runner.log     # the output of the job's runners
locks/git-<workspace>.lock               # held during a Git operation on the workspace's checkout, by sf serve or a runner
jobs/<workspace>/<ticket>.<timestamp>/   # an archived earlier job
```

`iteration` in `job.json` counts published iterations; `updated_at` is the time of the last state
change (`since` in `check` and `SINCE` in `sf status`).

Every stored time is ISO 8601 UTC with `Z`. What the factory shows is local time (SF-049):
`sf watch`, the dashboard's live log and `SINCE` in `sf status` in the zone the `sf` process runs
in (`TZ`), the rest of the dashboard in the browser's (`YYYY-MM-DD HH:MM:SS`, the stored UTC value
on hover).

## Dashboard

A page served by `sf serve` on a second loopback listener,
`http://127.0.0.1:${SF_DASHBOARD_PORT:-8788}/d/<token>/`, separate from the MCP port so the
tunnel never reaches it. The first `sf serve` writes a random token (32 bytes, hex) to
`${SF_STATE_DIR}/dashboard-token` (0600) and prints the URL; later starts reuse the file, so a
bookmark keeps working across restarts, and `sf dashboard` prints the URL again from that file
and `SF_DASHBOARD_PORT`. `sf dashboard --rotate` removes the file: the next `sf serve` start makes
a new token and prints the new URL (a running `sf serve` keeps the old one until then). A missing
or unusable file is replaced at start the same way; `SF_DASHBOARD=off` removes it. Any path
without the right token answers 404 with an empty body.

`sf dashboard --open` prints the same URL and then opens it in the browser with `xdg-open` (Linux
only, from `xdg-utils`), run without a shell with the URL as its one argument and waited for up to
10 s. The same checks as without `--open` come first (dashboard off, no or invalid token, invalid
port: exit 1, nothing launched). When `xdg-open` is missing, exits unsuccessfully or does not finish
in time, `sf` exits 1 with the reason; the printed URL stays usable by hand. Exit 0 means the
launcher accepted the URL, not that the page loaded: nothing checks that `sf serve` is running.
On another platform `--open` is refused (`open_unsupported`); plain `sf dashboard` works everywhere.

**The board (SF-046).** The page is a board that reads like a Kanban board, with five columns whose
headers count their cards: **Planned** (the Task files of every usable workspace whose ticket has no
job, or whose last job is `failed` or `aborted`: skeletons and written tasks, with that state as a
mark), **Implementing** (`starting`, `working`), **Reviewing** (`awaiting_review`, that is the
Claude review or the Codex gate runs or is due, and `preparing_mr`), **Your turn** (`needs_human`,
`ready_for_human_review`) and **Done** (`pushed`, and `aborted` or `failed` when the ticket has no
Planned card, its Task file archived or deleted; the most recent first; the last ten, then *Show
all*). A ticket shows in one column only (SF-057): a pushed one only under Done, a failed or aborted
one only under Planned, one with an active job only in that job's column. The Done card of a pushed
job whose Task file is still active carries *Archive ticket* (the Archive of the Planned card it no
longer has). A workspace filter above the board keeps one workspace's cards (and counts) or all. A
job card shows the ticket key, the workspace and the title of its Task file (of its archived copy
when the Task file is archived; the branch when neither is there); a five-segment pipeline bar
(Implement, Claude review, Codex gate, MR, You) with the segments passed in green, the current one
marked and a halted one red (a `needs_human` or `failed` job halts where its error points:
`review_failed` at the Claude review, `gate_*` at the gate, a failed push at You, `mr_*` at MR,
anything else at Implement; a pushed job has every segment done); one line saying who acts now and
since when (`Implementer · 3 min`, `Claude review · 1 min`, `Codex gate · 4 min` counted from the
end of the clean Claude review, `MR preparation · 1 min`, `You · approve · 2 min`, `You · retry
review · …`, `You · <error code> · …`, `Pushed · 2 h 5 min ago`), the error of a halted job, and
chips for the iteration, the files of the last iteration (and its undeclared sensitive ones) and the
estimated cost ("est. $", not a charge). A Your turn card carries the one action that unblocks it:
*Approve…* (the job opens with its approve confirmation), *Retry review* after a failed Claude
review (sent at once, as the button in the drawer) or *Open the job*; the job's last outcome shows
under it. A Planned card shows the ticket, its base and, after a failed or aborted job, that state
as a mark that opens the job, and **Start** to run it (again) (a skeleton says "waiting for the
plan" instead), **Task**, Archive and Delete…. Start asks first, naming the workspace, the ticket
and the base branch, then sends `POST api/tickets/<ws>/<ticket>/start` once: `Execution.start`, the
same call as `sf start`, with its refusals (`task_draft`, `job_limit`, `job_exists`,
`branch_exists`, `checkout_dirty`, ...) shown as they come; the job's card appears under
Implementing from the stream. An answer that does not settle the outcome (no answer, a body cut
after the headers, a 2xx without a result, a 5xx without a factory code) is an unknown outcome:
nothing is re-sent, and Start stays off for that ticket until `api/jobs` is read again (at once;
when that read fails, until the stream's next `jobs` event), with a line saying to check the board
before starting again. Task opens the Task file (`GET api/tickets/<ws>/<ticket>/task`) in the drawer
as text: one line per line, Markdown headings bold by a line rule, never HTML from the file; for a
ticket not archived, the drawer also offers its ChatGPT conversation (below). The board follows the
stream's `jobs`, `tickets` and `workspaces` events: a card moves column when its job changes state,
and "since when" moves on every minute. On a phone-wide window (below 760 px) the columns stack with
Your turn first; light and dark follow the system as before.

**The drawer.** Clicking a job card opens the job in a wide drawer on the right, over the board
(the whole width on a phone): the job detail described below (SF-047), the URL becomes
`#<workspace>/<ticket>` (opening that URL opens the drawer) and the stream follows that job;
✕, a click beside the drawer or Escape closes it and the stream follows no job. A job that leaves
the board (its ticket archived or deleted) closes it. The same drawer holds the Task text and the
setup, which moved behind the header: **Workspaces** lists the registry (name, path, live jobs, a
problem such as a missing checkout) with Remove (off while the workspace has a live job; the
registration only, nothing on disk changes) and an Add form: a name and the path of the local
checkout, typed or pasted (the page cannot browse the machine's disk), validated as `sf workspace
add` does (an absolute path that exists and is the root of a non-bare Git work tree, a name not
registered yet) with the refusal shown as it comes. **New ticket** takes the workspace (the
filter's by default), the ticket key, a one-line title, what the user wants in their own words
and the Context owner (ChatGPT; Claude Code is listed and disabled until SF-023), and writes a
**ticket skeleton** (SF-028), `.software-factory/<ticket>.md` in the checkout, through the Task
file writer: the front matter (`ticket`, `title`, `base` = the branch `origin/HEAD` points at, else
`main`), `# <ticket>: <title>` and `## Status: waiting for the Context owner` with one line of
explanation. The user's words are **not** written into it: they are kept in the state directory
(`<state dir>/requests/<workspace>/<ticket>.md`) and become the first message of the ticket's
conversation. An existing Task file is never replaced from the page (`409 ticket_exists`).
**Archived** (a link in the header, with the count) lists the archived tickets with Task (the
archived text), Restore and Delete…; Archive, Restore and Delete… are described under SF-027 (a
finished job of the ticket leaves the board with them). With no workspace, or no ticket and no
job, a line above the board says where to begin.

The ticket's **conversation** in its Task drawer: *Open the conversation*, a link (`target=_blank`,
opened only by the user's click, and the same URL in a box to copy) to `https://chatgpt.com/?q=`
plus the message of `ticketConversation` URL-encoded. The message names the connector, `guide`, the
ticket and the workspace, carries the user's words, and tells the Context owner to investigate
(`read_file`, `search`), discuss, write the Task file over the skeleton with `write_task` with a
`## Review brief`, and then tell the user it is ready: it only plans and never starts, reviews or
approves a job; the user reads the Task file and presses Start on its Planned card. A message too
long for a link (over 7500 characters of URL) is offered in the box to copy instead.
Whether ChatGPT sends a prefilled message by itself is up to ChatGPT, so the page says to press
Enter if it is not. Only the server's ChatGPT URL becomes a link. A change made with `sf workspace
add|remove` or `write_task` shows at the next refresh of the stream (a state change, an action
from a page, or a reload). The ChatGPT reviewer of SF-031 to SF-035 is gone with its back end
(SF-040): there is no Reviewer line, no "Set up the reviewer in ChatGPT", no Nudge, no Send test
event and no Subscriptions.

**The job detail (SF-047).** The drawer shows the job live, in the shape the user chose from the
dashboard redesign prototype (variant C, branch `prototype-dashboard-redesign`):

- **Header**: the ticket key, the state badge and the file badges (`N files`, `M sensitive` in red,
  `K deleted`), the branch with *Copy checkout command* (`git checkout <branch>` on the clipboard,
  or shown selected for Ctrl+C when the browser refuses it), and the **pipeline stepper**:
  Implement → Claude review → Codex gate → MR preparation → You. Each step is done (✓), current
  (with since when: `since 10:05 (4 min)`; the gate from the end of the clean Claude review), halted
  (red, with its error code) or to do; the gate step reads *off* when `SF_GATE` is off, and
  *overridden by you* after `sf accept`. A halted job has a line with the code and a plain sentence
  of what moves it on: `review_failed` "The Claude review could not run. Retry it.", `gate_rounds`
  "Codex asked for fixes more often than the round limit allows. Accept and prepare the MR, tell
  the Implementer what to do, or abort.", `gate_budget`, `gate_failed`, `iteration_limit`,
  `mr_conflict`, a failed push, `serve_restarted`, and a general sentence for any other code.
- **Next action** (a right rail on a wide window, above the tabs below about 1100 px): who acts now
  and for how long (`Now · Implementer`, `Now · Claude review`, `Now · Codex gate`, `Now · Factory`,
  `Your turn`, `Finished`), what they do and what follows, and the actions that move the job on:
  *Approve…* (`ready_for_human_review`, and `needs_human` after a failed push), *Accept and prepare
  MR…* (only for `gate_rounds`, `gate_budget` and `gate_failed` with a clean Claude review of the
  last iteration), *Retry review* (`needs_human` with `review_failed`), *Abort…*, *Archive* for a
  finished job, and the message box to the Implementer (say). Under it the **facts**, stacked one
  per row: base, iteration (and MR attempts), Fix sections, gate rounds, gate tokens, the estimated
  cost ("est. $", not a charge; the iterations and their Claude reviews), the update time and the
  worktree path, wrapping inside the rail. Then the **state history** as a compact list: the time,
  `from → to`, the error code (its message on hover), and the user's override of the gate.
- **Flat tabs** (no tabs inside tabs; the selected one is kept when another job is opened):
  **Task** (the Task file through `GET api/tickets/<ws>/<ticket>/task`, Fix sections included, as
  text; read when the tab opens and again when a Fix section is written; the archived file when the
  ticket was archived), **Changes** (the default: an iteration picker when there is more than one,
  the meta line, the Implementer's Report, and the file list next to the Patch; see Files below),
  **Reviews** (per iteration, newest first, the Claude verdict and the Codex verdict side by side:
  the verdict with its cost or tokens, the summary, the numbered items, the accepted sensitive
  paths, or why it failed, or *reviewing now…*, *after a clean Claude review*, *not run* or *off*;
  an iteration accepted over the gate says so), **MR** (the MR text once there is one, else a note;
  *Copy MR text* puts the title line, a blank line and the body on the clipboard, or shows the text
  selected for Ctrl+C when the browser refuses; after `sf accept`, *Codex items not applied* under
  it lists the items (path, problem, expected) or the gate's error, for a follow-up ticket) and
  **Live log** (the event stream as `sf watch` prints it, with the filters All, Implementer, Claude
  review, Codex and State: the `review |` and `codex |` lines of SF-045 and the reviewers' verdict
  lines go to Claude review and Codex, the state changes, the override and the factory's own lines
  (placeholders removed, a failed notification) to State, the session to Implementer; new lines follow the filter; follow keeps the newest line in view and scrolling up
  switches it off).

The job's actions take the user's commands with the same meaning as in the terminal: approve (`sf
approve`, the push of the branch prepared at Clean, with an explicit "as it is" choice for a tip
edited by hand: `sf approve --as-is`), abort (`sf abort`, with an explicit discard choice that is
unchecked every time a confirmation opens: `sf abort --discard`), say (`sf say`: a multiline
message; Enter adds a line, only the Send button submits), Retry review (`sf review`, SF-044, sent
at once without a confirmation) and Accept and prepare MR (`sf accept`, SF-047: its confirmation
names the job and lists the Codex items that will not be applied, path and problem, or the gate's
error, so the user accepts them knowingly). The merge request (SF-048) has Create merge request
(`sf mr create`; its confirmation shows the title, the host and the target branch, and from
`ready_for_human_review` says the branch is pushed first), Merge (`sf mr merge`; its confirmation
names the number and the target branch) and Refresh MR status (`sf mr status`) in the next-action
panel, with the merge request's link; the Your turn cards offer Create merge request… next to
Approve…, the Done cards of pushed jobs Create merge request… or Merge… and the link. Without the
token for the workspace's host the buttons stay off and the reason names the missing variable.
Approve stays for users who open merge requests themselves. Each is one deliberate click; approve, abort and accept ask for a confirmation that names the
job, explains what follows (the push; the session ends and the worktree stays, or the worktree and
the branch go with discard; MR preparation without the Codex items) and sends nothing when
cancelled. The page enables
a control from the state it shows (approve in `ready_for_human_review` and in `needs_human`
after a failed push; abort in every non-terminal state; say in `working`, `awaiting_review`,
`needs_human` and `ready_for_human_review`; accept after a gate code with a clean Claude review)
and says why one is off, but the factory decides: a
refusal such as
`invalid_state` or `turn_running` from a concurrent `sf` command or reviewer verdict is
shown as it comes. Nothing is retried or replayed: a reload, a reconnect or a network error never
repeats an action. An answer that does not settle the outcome (no answer, a body cut after the
headers even with status 200, a 2xx without a result, `internal_error` or any 5xx without a
factory code) is reported as an unknown outcome, because the action may have run; a 4xx, with or
without JSON, and a 5xx with a factory code are definite. After an unknown outcome the draft stays
and that job's controls stay off until a state read started after it succeeds (abort stays on while
a preparation is known to run). A failed read says so and shows a Refresh state button; the next
`job` event of the stream tries the read too. The read then lifts the hold but not the doubt: the
page says to check the state and the event stream, in a line of its own that a definite answer
does not replace, until the next action for the job starts; it sends nothing by itself. A read
without an answer in 10 s counts as failed, and a confirmation that the hold makes unavailable
closes. Start, approve and abort
stay the user's: the Context owner has no tool for them.

Approve answers when the push ends. The outcome is shown as the factory reports it: pushed with
the branch, the MR title and the link as text to copy (the branch and the title only, with a
note to open the merge request by hand, when the origin URL cannot be parsed); `needs_human`
with the push error; `branch_changed` as the refusal it is. Abort stays available in
`preparing_mr` (a Clean being prepared); it ends the preparation. Say shows whether
the message was queued behind a running turn (it has not run yet) or started a turn; the draft
stays on any error, only the text that was sent is cleared on acknowledgement, and drafts are
kept per job when another job is opened. A confirmation and a request are bound to the job they
were opened for: opening another job or closing the drawer closes the confirmation and never
retargets a request, and an answer that arrives for another job changes nothing on the shown one
(it shows on that job's card and when it is opened again).

The page is plain HTML, CSS and JavaScript from `static/`, with no external resources, under
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self'` and `Cache-Control: no-store`; every value is rendered as text.

Endpoints under `/d/<token>/`. The read endpoints are GET only (anything else `405` with
`Allow: GET`); the action endpoints are POST only (anything else `405` with `Allow: POST`; GET,
HEAD and OPTIONS never act); `api/workspaces` and `api/tickets` list on GET and act on POST
(anything else `405` with `Allow: GET, POST`):

| Path | Answer |
|---|---|
| `api/jobs` | `{jobs: [...]}`: workspace, ticket, branch, base, state, iteration, mr_attempts, fixes, gate_fixes, gate_tokens, updated_at, created_at, error, and for the board (SF-046) `title` (of the Task file, or `null`), `cost_usd` (the estimate of the iterations and their Claude reviews, or `null`), `review` and `gate` (the last iteration's verdicts: `clean`, `fix`, `failed` or `null`) and `review_ended_at` (the end of that clean or fix Claude review, or `null`); `mr` (the merge request on the Git host or `null`) and `mr_host` (`{host, reason}`: `github`, `gitlab` or `null`, and why the merge request actions are off or `null`) |
| `api/jobs/<ws>/<ticket>` | `{job, iterations: [{number, started_at, ended_at, cost_usd, changed_files, patch_truncated, denials, files, review, gate, gate_override}], mr, gate, history: [{ts, from, to, error?} or {ts, event: "gate_overridden", code, unapplied} or {ts, event: "merge_request", action, number, url, state}], mr_title}`; `mr_title` is the MR text's first line or `null`; `gate` is whether the Codex gate is on, `gate_override` the iteration's `gate-override.json` or `null` |
| `api/workspaces` | `{workspaces: [{name, path, liveJobs, problem}]}`: the registry, the checkout's path, its non-terminal jobs, and why the checkout cannot be used now or `null` |
| `api/tickets` | `{tickets: [{workspace, ticket, title, base, draft, request, job, conversation: {message, url}}], archived: [{workspace, ticket, title}]}`: the Task files without a live job; `draft` is true for a skeleton; `request` the user's words of New ticket or `null`; `job` is the last job's state or `null`; `url` is `https://chatgpt.com/?q=<message URL-encoded>`, or `null` when too long |
| `api/jobs/<ws>/<ticket>/iterations/<n>/report` | the Report, `text/markdown` |
| `api/jobs/<ws>/<ticket>/iterations/<n>/patch` | the Patch, `text/x-diff` |
| `api/jobs/<ws>/<ticket>/mr` | the MR text, `text/markdown`; 404 until there is one |
| `api/tickets/<ws>/<ticket>/task` | the ticket's Task file, `text/markdown`, read through the Task file reader (a regular file of valid Task content); `?archived=1` reads `.software-factory/archive/<ticket>.md` instead (any other `archived` value is 404); an unknown workspace or a missing file is an empty 404, a file the reader refuses its refusal (`400 invalid_content`) |
| `api/stream?job=<ws>/<ticket>&from=<line>` | server-sent events: `jobs` (on connect and on every state change), `workspaces` and `tickets` (as the two endpoints, at the same times and after every setup action from a page), `job` (the job's detail, on connect and when it changes state), `event` (`{line, ts, iteration, type, text}` for every visible line of `events.jsonl` from the 0-based `from`, as `sf watch` formats it); a comment every 15 s; at most 8 streams, then 503 |

| Method and path | JSON body | Calls |
|---|---|---|
| `POST api/jobs/<ws>/<ticket>/approve` | `{"as_is"?: boolean}` | `Execution.approve(ws, ticket, as_is)`: the push of the prepared branch; `as_is` pushes a tip edited by hand; it waits up to 10 s for the job's runner to end and is refused with `409 runner_active` while the runner runs or a request (`sf say`, a fix) waits for it (SF-042) |
| `POST api/jobs/<ws>/<ticket>/abort` | `{"discard": false}`; `discard` optional, default false | `Execution.abort(ws, ticket, discard)` |
| `POST api/jobs/<ws>/<ticket>/say` | `{"message": "<text>"}` | `Execution.say(ws, ticket, message)`; the text goes as it is (nothing trimmed or split); answered by the job's runner (SF-042), so `500 runner_failed` or `500 runner_timeout` can come back |
| `POST api/jobs/<ws>/<ticket>/review` | `{}` | `Execution.retryReview(ws, ticket)` (`sf review`): the failed review of the last iteration runs again; result `{state, iteration}`; `409 invalid_state` unless the job is `needs_human` with `review_failed`, `409 review_off` with `SF_REVIEW=off`; answered by the job's runner, so `500 runner_failed` or `500 runner_timeout` can come back |
| `POST api/jobs/<ws>/<ticket>/accept` | `{}` | `Execution.acceptGate(ws, ticket)` (`sf accept`, SF-047): the override of the stopped gate, then MR preparation; result `{state, iteration, branch}`; `409 invalid_state` with the reason unless the job is `needs_human` with `gate_rounds`, `gate_budget` or `gate_failed` and a clean Claude review of the last iteration; the MR preparation's refusals (`409 worktree_missing`, `409 turn_running`); answered by the job's runner, so `500 runner_failed` or `500 runner_timeout` can come back |
| `POST api/jobs/<ws>/<ticket>/mr-create` | `{}` | `Execution.createMergeRequest(ws, ticket)` (`sf mr create`, SF-048): result `{state, branch, title?, link?, mr?: {host, number, url, state, reused}, error?}`; from `ready_for_human_review` it waits for the job's runner like approve; `409` for `invalid_state`, `runner_active`, `mr_token_missing`, `mr_host_unsupported`, `mr_text_missing`; `502` for `mr_auth_failed`, `mr_host_error`, `mr_host_unreachable` |
| `POST api/jobs/<ws>/<ticket>/mr-merge` | `{}` | `Execution.mergeMergeRequest(ws, ticket)` (`sf mr merge`): result `{state, branch, mr}`; `409 mr_not_mergeable` with the host's reason, `409 mr_not_open`, and the codes above |
| `POST api/jobs/<ws>/<ticket>/mr-status` | `{}` | `Execution.mergeRequestStatus(ws, ticket)` (`sf mr status`): result `{state, branch, mr, status: {number, url, state, draft, mergeable, reason?, checks?, merge_commit?}}`; every page gets the jobs again, and the pages that show the job its detail (a merge request merged or closed on the host shows so at once) |
| `POST api/workspaces` | `{"name": string, "path": string}` | `Setup.addWorkspace`: the rules of `sf workspace add`; result the workspace row |
| `POST api/workspaces/<name>/remove` | `{}` | `Setup.removeWorkspace`; `409 workspace_busy` while the workspace has a live job; result `{removed}` |
| `POST api/tickets` | `{"workspace", "ticket", "title", "request"}` | `Setup.createTicket`: the ticket skeleton through the Task file writer, the request kept for the conversation; result `{workspace, ticket, path, base}` |
| `POST api/tickets/<ws>/<ticket>/start` | `{}` | `Execution.start(ws, ticket)` (`sf start`, SF-040, SF-046): the job's record, branch and worktree, then iteration 1; result `{branch, state, check_after_minutes, worktree}`; refusals as they come (`409 task_draft` for a skeleton, `409 job_exists`, `409 job_limit`, `409 branch_exists`, `404 task_not_found`, ...); every page gets the jobs, the workspaces and the tickets again |
| `POST api/tickets/<ws>/<ticket>/archive`, `.../restore`, `.../delete` | `{}` | `Setup.archiveTicket`, `restoreTicket`, `deleteTicket` (SF-027) |

The actions go to the same `Execution` as the socket commands, under its lock and guards; there
is no second state machine and no other mutation endpoint. The setup
actions go to `src/setup.ts`, which writes the same registry file as `sf workspace add|remove`
and the same Task files as `write_task`, under the Execution's lock, so a registry change and a
start never interleave. An action request must carry the
token, an `Origin` equal to the page's exact origin (`http://127.0.0.1:<port>` with the actual
port; a missing Origin, another loopback address or port and the MCP origin are refused with
`403 invalid_origin`; a `null` or foreign Origin is already refused, `403`, by the loopback
Origin check every request passes), `Content-Type: application/json` (a `charset=utf-8`
parameter is accepted; anything else `415 unsupported_media_type`) and a body of at most 128 KiB
(`413 body_too_large`, checked against `Content-Length` and while reading; nothing is truncated)
that is UTF-8 JSON (`400 invalid_json`) of exactly the shape above: an object with the listed keys
of the listed types, no other key, no null, no array (`400 invalid_body`). Invalid names and
unknown jobs are an empty `404`, as for the reads. Nothing reaches the Execution until every check
has passed; a body cut by a disconnect is dropped without an answer. There is no CORS and no
form-encoded variant; the Host and Origin checks of the reads apply to every request.

Answers are JSON with the same security headers. A completed call is
`200 {"ok": true, "result": <the method's result, unchanged>}` whatever the outcome: an approve
that ended in `needs_human`, `awaiting_review` or `aborted`, and an abort that ended the job but
failed to discard (`result.error.code` `discard_failed`; the page says the discard may be partial
and never that the branch or the files were removed) are `200` too; the page reads `result`.
A `FactoryError` is `{"ok": false, "error": {"code", "message"}}` with its code and message kept,
under `409` for `invalid_state`, `turn_running`, `rebase_in_progress`, `review_off`, `runner_active`, `job_exists`, `job_active`,
`job_limit`, `task_draft`, `checkout_dirty`, `branch_exists`, `branch_changed`, `branch_missing`,
`worktree_exists`, `worktree_missing`, `sensitive_unacknowledged`, `ticket_exists`,
`workspace_exists` and `workspace_busy`,
`404` for `job_not_found`, `workspace_not_found` and `task_not_found`, `400` for `invalid_content`, `invalid_ticket`, `invalid_name` and
`workspace_invalid`, and `500` for any other code (a Git failure before the preparation, for
example; `runner_failed` and `runner_timeout` of a request the job's runner answers: say,
review, accept). Any other failure is `500`
with `internal_error` and a fixed message; the cause is logged, never the body or the token.

When the page's approve request is cut, the push goes on and its outcome is recorded in the job;
a second approve of a pushed job is refused (`invalid_state`).

**Files (SF-024, SF-047).** The Changes tab shows the structured file list of the selected
iteration next to its Patch, in the shape of IntelliJ's Changes list. One row per file, the file
name first and its directory after it in a muted colour, the row coloured by status (added green,
modified blue, deleted grey with the name struck through), labels `sensitive, undeclared` /
`sensitive, declared` / `deleted`, and the counts `+n −m` at the right. Groups in this order:
sensitive undeclared, sensitive declared, deleted, then the rest, each sorted by file name, under
the summary `Files N · M sensitive undeclared · K deleted`. The Patch beside it is the whole
unified diff of the iteration (loaded once per iteration), added lines green, removed lines red,
hunk headers muted, one block per file. A click on a row marks it and its block and scrolls the
diff to that file; a file the Patch omits (binary, or beyond the Patch size limit) says so above
the Patch; an iteration published before the list existed says so instead of rows. On a narrow
window the list goes above the Patch.
The job's header carries badges: `N files`, and `M sensitive` (red) and
`K deleted` (orange) when the last iteration has undeclared sensitive or deleted files (the board
card shows the files and the sensitive ones as chips); the
`ready_for_human_review` job keeps the list of that iteration. The job detail's `iterations`
carry `files` (the list, or `null`), and `api/jobs` rows `files`, `undeclared`, `deleted`
counts, `worktree` and `prepared_commit`.

### Checking the page by hand

The automated checks run the page's script against a stand-in document
(`test/support/fake-dom.ts`), not a browser: layout, focus, Enter in the textarea and the form's
own behaviour are only checked by hand. With `sf serve` running on a throwaway repository and
`SF_CLAUDE` pointing at `dist/test/support/fake-claude.js` (or a real job you are willing to
end), in a browser:

1. Board: open the URL of `sf dashboard --open`: five columns with their counts; each job is in
   the column of its state, with the pipeline bar, the line of who acts now and since when, and
   the chips. The workspace filter keeps one workspace's cards. With more than ten finished jobs
   Done shows ten and *Show all N*.
2. Start: on a Planned card with a written Task file click Start: the dialog names the workspace,
   the ticket and the base branch; Cancel sends nothing (`sf status` unchanged). Confirm: the line
   at the bottom says the job started, and the card appears under Implementing, then moves to
   Reviewing and Your turn as the job goes on, without a reload. A skeleton shows "waiting for the
   plan" and no Start; Start on a ticket whose workspace already runs `SF_MAX_JOBS` jobs shows
   `job_limit` as it comes.
3. Task: click Task on a Planned card: the drawer shows the Task file as text, headings bold; a
   line `<script>alert(1)</script>` written into a Task file shows as that text, nothing runs.
   Archived → Task shows an archived file.
4. Drawer: click a job card: the wide drawer opens on the right with the header, the stepper, the
   next-action rail and the tabs; the URL ends in `#<workspace>/<ticket>`; reload: the drawer
   opens on the same job. Copy checkout command puts `git checkout <branch>` on the clipboard. ✕, a click on the
   board beside it and Escape close it (Escape in an open approve or abort dialog closes only
   the dialog).
5. Say: in the drawer of a job in `awaiting_review` type two lines (Enter adds a line and submits
   nothing), click Send: "Sent" and an empty box; while that turn runs, send another: "Queued";
   `sf watch` shows both prompts as typed.
6. Abort: click Abort…; the dialog names the job and the branch and says the files stay; Cancel:
   `sf status` is unchanged. Open it again: the discard box is unchecked; tick it: the button
   reads "Abort and discard the branch" in red; Cancel and reopen: unchecked again. Confirm a
   plain abort on a job you can lose: "Aborted; the branch … stays"; the card moves to Done.
7. Approve: on a Your turn card in `ready_for_human_review` click Approve…: the drawer opens with
   the approve dialog; confirm: "Pushed …" with the title and the merge request link to copy (or
   the note to open it by hand); the card moves to Done.
8. Retry review (a fake review scripted to fail): the job is under Your turn with the review
   segment red and *Retry review* on its card; click it: the card moves to Reviewing.
9. Switching: start a say or an approve and open another job before the answer: that job's
   controls, status and draft are untouched; open the first again: the outcome is there.
10. Unknown outcome: with DevTools offline (or `sf serve` stopped) send a message: "outcome is
   unknown", the draft stays and Send, Approve… and Abort… stay off with a reason; the read fails
   and Refresh state appears; back online, click it: the state is current and nothing was
   re-sent. The same for Start: offline, confirm a Start: its outcome is unknown and Start stays
   off for that ticket until the board is read again; nothing is re-sent.
11. Reconnect: stop `sf serve` with the page open: the header says reconnecting and no request is
   re-sent; start it again and reopen the page with the new URL (the old token is 404).
12. Setup: with an empty registry (`SF_CONFIG_DIR` pointing at an empty directory) the board says
   to add a workspace; Workspaces opens the drawer with the Add form; add a throwaway repository by
   its path (a wrong path shows the refusal in place). New ticket with a key, a title and two lines
   of request writes `.software-factory/<key>.md` as a skeleton (`## Status: waiting for the
   Context owner`, no request text), and the ticket appears under Planned with "waiting for the
   plan". Its Task drawer has *Open the conversation*: a new tab on chatgpt.com with your words
   in the first message (press Enter if it stays there); the same URL is in the box and Copy puts
   it on the clipboard. Once ChatGPT wrote the Task file, Start appears on the card. Remove on a
   workspace with a live job is off with the reason. Nowhere on the page is there a Reviewer
   line, a reviewer setup, Nudge, Send test event or Subscriptions.
13. Tabs: Changes opens by default; Task shows the Task file with its Fix sections; Reviews shows
   both verdicts of every iteration side by side; MR says there is no text until MR preparation
   wrote it, then shows it, and Copy MR text puts the title, a blank line and the body on the
   clipboard (paste it into the MR form); Live log follows the job and its filters keep one source;
   the chosen tab stays when another job is opened. The facts' worktree path wraps inside the rail.
14. Changes: the file list in the IntelliJ shape and order beside the Patch; click a row: the
   Patch scrolls to that file and marks it; a binary file says the Patch omits it.
15. Layout: narrower than 760 px the columns stack with Your turn first and the drawer takes the
   whole width; between 760 and about 1200 px the board scrolls sideways inside the page; in the
   OS dark scheme the pipeline colours, the chips and the dialogs stay readable; Tab reaches each
   card, its action, the drawer's ✕, the tabs, Approve…, Abort…, the dialog's buttons, the
   textarea and Send. Between about 760 and 1100 px the next-action panel sits above the tabs; on a
   phone the stepper stacks.
16. Accept and prepare MR (a fake Codex scripted to ask for fixes past `SF_GATE_MAX_ROUNDS=1`): the
   job is under Your turn with the gate step red and `gate_rounds`; the rail offers *Accept and
   prepare MR…*; its dialog lists the Codex items; Cancel sends nothing; confirm: the job goes to
   MR preparation and Your turn, the state history shows the override, and the MR tab lists the
   Codex items not applied.

## Workspace registry

`<config dir>/workspaces.json`, written by `sf workspace add|remove` and by the dashboard's start
screen (`POST api/workspaces`):

```json
{ "workspaces": { "my-app": { "read_checkout": "/abs/path" } } }
```

Names are 1-64 characters of `a-z`, `0-9` and `-`, starting and ending with a letter or digit.
The path must be absolute and, whenever a tool uses it, the root of a non-bare Git work tree.
An invalid file is an error, never ignored. `read_file` and `search` read the checkout;
`write_task` writes `.software-factory/<ticket>.md` in it and adds `.software-factory/` to its
`.git/info/exclude`; every job's worktree is created from it (SF-019). A `work_checkout` field of
an older registry is read and ignored, with one warning when `sf serve` starts; `sf workspace add
--work` is refused.

## History

`factory/` replaced the bridge of SF-001 to SF-010: one process with a Workspace registry instead of
a single fixed repository root, Task files instead of instructions under `factory-data/` and
dispatch to a separate gateway, and an Agent SDK session instead of a file-based execution loop.
The file reader is a copy of the bridge's. SF-011-e removed the bridge; the factory took over its
port 8787 behind the tunnel (see `docs/design/SF-011-factory.md`).
