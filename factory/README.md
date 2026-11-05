# software-factory

The local factory process. It serves the planning tools to the Context owner (ChatGPT or any MCP
client), runs the jobs and provides the `sf` command. How to work with it is in [HANDBOOK.md](HANDBOOK.md); the
vocabulary is in [../CONTEXT.md](../CONTEXT.md).

The MCP endpoint serves only the planning tools (`guide`, `read_file`, `search`, `write_task`,
`task_check`, `read_attachment` (a ticket's image, section Ticket images), and the run queue's
`queue_list` and `queue_add`, section Run queue): the Context owner reads the repository, discusses the ticket with the user and
writes the Task file with its `## Review brief`. Before Start, the Task check (section Task check)
reads the Task file and the repository and says whether it is ready to build. The user starts the job, with the Start button of the ticket on the
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
bin/sf workspace add <name> --read <path> [--handoff checkout|off] [--color <name>]   # the local checkout; every job works in a worktree of it (--work is retired); --color: its colour on the board; again with the same path: changes --handoff/--color
bin/sf workspace list
bin/sf workspace remove <name>
bin/sf serve                      # foreground; Ctrl+C stops it; prints the dashboard URL
bin/sf up [--no-open] [--no-tunnel]   # sf serve plus the tunnel (../scripts/sf-tunnel.sh run, output prefixed "tunnel | ") and the dashboard opened in the browser; Ctrl+C stops both; npm start at the repository root
bin/sf dashboard [--open]         # the dashboard URL of the last sf serve start; --open opens it with xdg-open; works without sf serve
bin/sf check-task <workspace> <ticket>  # the Task check (section Task check): paraphrase, findings by severity, verdict; stored by sha; works without sf serve
bin/sf rules <workspace> [ticket] # the coding rules the agents would be given (section Coding rules): paths, sources, sizes, the files left out; never their text; works without sf serve
bin/sf attach <workspace> <ticket> <file> [name]   # attach an image to the ticket (section Ticket images): .software-factory/<ticket>/<name>, name by default the next number; works without sf serve
bin/sf attach <workspace> <ticket> --remove <name>  # remove one; refused while a job of the ticket runs (paused aside)
bin/sf start <workspace> <ticket> # start the job in a worktree of its own (same as the dashboard's Start); a start by hand is never held by the run limit; needs sf serve
bin/sf queue list                 # the run queue (section Run queue): the limit, the running count, held or not, the queued tickets in order with what each waits for, the next one, the starts that failed; needs sf serve
bin/sf queue add <workspace> <ticket> [--at N]  # queue a planned ticket at position N (1-based; default the end); needs sf serve
bin/sf queue remove <workspace> <ticket>        # take it out of the queue; needs sf serve
bin/sf queue move <workspace> <ticket> <N>      # move a queued ticket to position N; needs sf serve
bin/sf queue limit <N>            # run up to N jobs at once (1-20, every workspace); needs sf serve
bin/sf queue hold [reason...]     # the queue starts nothing until release; needs sf serve
bin/sf queue release              # needs sf serve
bin/sf say <workspace> <ticket> <message...>   # a user message into the session; on a handed-over job it is Ask for changes (section Hand-over to your checkout); needs sf serve
bin/sf review <workspace> <ticket>             # retry a failed Claude review (needs_human with review_failed); needs sf serve
bin/sf accept <workspace> <ticket>             # accept a clean Claude review over a stopped gate (gate_rounds, gate_budget, gate_failed) or a ledger stop (review_churn, review_disputed) and prepare the MR, or skip the simplification pass's suggestions (simplify_offered); needs sf serve
bin/sf simplify <workspace> <ticket>           # apply the simplification pass's suggestions (needs_human with simplify_offered): one Fix section "Simplify", reviewed as usual; needs sf serve
bin/sf settle <workspace> <ticket> <id> accept|fix [note...]  # settle an escalated or contested finding of the ledger (needs_human); needs sf serve
bin/sf status [<workspace> <ticket>]           # one job (with its worktree, sensitive, out-of-scope and deleted paths) or all jobs, with estimated cost and elapsed time; works without sf serve
bin/sf watch <workspace> <ticket> [--once]     # the session live; works without sf serve
bin/sf approve <workspace> <ticket> [--as-is]  # push the branch prepared at Clean; --as-is pushes a tip edited by hand; needs sf serve
bin/sf mr create <workspace> <ticket>          # open the job's merge request on GitHub or GitLab (or reuse the open one); from ready_for_human_review: approve, then open; needs sf serve
bin/sf mr merge <workspace> <ticket>           # merge the job's open merge request through the host's API (refused with the host's reason); needs sf serve
bin/sf mr status <workspace> <ticket>          # the merge request on the host: open, merged or closed, mergeable or why not, the checks; needs sf serve
bin/sf pause <workspace> <ticket>              # stop a working job or one awaiting review at once (section Pause, Resume and Restart); worktree, branch, session and history stay; needs sf serve
bin/sf resume <workspace> <ticket> [message...]   # go on with a paused job where it stopped; a Task file changed meanwhile goes with its diff; needs sf serve
bin/sf restart <workspace> <ticket> [--keep-files] # start the ticket again from its current Task file on a fresh worktree and branch (paused, aborted, failed, needs_human); needs sf serve
bin/sf handover <workspace> <ticket>           # Hand over to my checkout: the job's branch in the workspace's checkout with its changes as Local Changes (ready_for_human_review); needs sf serve
bin/sf takeback <workspace> <ticket>           # Take it back: the branch back from your checkout into the job (handed_over); needs sf serve
bin/sf handed-done <workspace> <ticket>        # I opened the MR myself: pushed once origin has the branch with your changes (handed_over); needs sf serve
bin/sf abort <workspace> <ticket> [--discard]  # end the job; the worktree stays (its path printed); --discard removes the worktree and the branch; needs sf serve
bin/sf reset <workspace> <ticket>              # end the session, remove the worktree and archive the job; the branch stays; needs sf serve
bin/sf notify-test                             # one test notification on every channel; works without sf serve
bin/sf info                                    # version, directories, settings (gate: codex <version or path> | off (<reason>)), sf serve and tunnel state, workspaces, jobs; works without sf serve
bin/sf run <workspace> <ticket>                # the job's runner (section Jobs); sf serve starts it detached, one per job; refused (runner_running) while the job has one
npm run typecheck && npm test
```

Exit codes: 0 ok, 1 error, 2 usage. `sf check-task` exits 0 when the check ran (ready or not
ready) and 1 when it failed. `sf approve` exits 1 unless the branch was pushed; `sf mr
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
| `SF_MAX_JOBS` | `3` | The default of the run queue's limit `max_running` (section Run queue), within 1-20, while `queue.json` does not exist yet; `sf queue limit` and the board's stepper change the limit from then on. |
| `SF_SENSITIVE_PATHS` | empty | Comma-separated globs added to the sensitive paths of `src/rules.ts`. |
| `SF_CHECK_AFTER_START_MIN` | `15` | `check_after_minutes` in the result of a start and of the job's status during the first iteration. |
| `SF_CHECK_AFTER_FIX_MIN` | `5` | `check_after_minutes` in the job's status during later iterations. |
| `SF_MAX_TURNS` | `150` | `maxTurns` of every Implementer turn. |
| `SF_TURN_LIMIT_CONTINUES` | `1` | Continuations the factory sends by itself, per chain of Implementer turns, after a turn that reached `SF_MAX_TURNS` while making progress (SF-069, below); `0` to `10`, `0` stops at the first limit. |
| `SF_MAX_ITERATIONS` | `5` | Fix sections a job may get (the reviewers', counted in the job's `fixes`); the next Fix is refused (`iteration_limit`, job `needs_human`). An `sf say` turn does not count. |
| `SF_CLAUDE` | bundled binary | Absolute path of the Claude Code executable (`pathToClaudeCodeExecutable`). |
| `SF_MODEL` | unset | Model of every Implementer turn, passed as is as the `model` option of `query()`; unset uses the user's Claude Code default. |
| `SF_REVIEW` | on | `off` runs no Claude review (nor the gate): a published iteration stays in `awaiting_review` until the user goes on with `sf say` or aborts. |
| `SF_REVIEW_MODEL` | unset | Model of the Claude review, passed as is as the `model` option of `query()`; unset uses the user's Claude Code default. |
| `SF_REVIEW_MAX_TURNS` | `60` | `maxTurns` of the Claude review. |
| `SF_HANDOFF` | `checkout` | The hand-over at ready for review (SF-073, section Hand-over to your checkout): `checkout` checks the job's branch out in the workspace's checkout with its changes as Local Changes; `off` leaves the job in `ready_for_human_review` with its worktree. A workspace's own `handoff` in `workspaces.json` wins over it (SF-083). Anything else refuses to start (`invalid_config`). |
| `SF_SIMPLIFY` | on | The simplification pass (SF-055) after the deciding clean verdict of a job with at least one Fix section; `off` goes straight to MR preparation. It uses `SF_REVIEW_MODEL` and `SF_REVIEW_MAX_TURNS`. |
| `SF_TASK_CHECK_MAX_TURNS` | `30` | `maxTurns` of the Task check (SF-054); its model is `SF_REVIEW_MODEL`. |
| `SF_RULES_MAX_BYTES` | `49152` (48 KiB) | The bytes of rule file content the agents are given at most (SF-059, section Coding rules); the headings and the fixed sentence do not count. A positive integer up to 16 MiB. |
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
`SF_STATE_DIR` themselves; `sf start`, `sf queue`, `sf say`, `sf review`, `sf accept`, `sf simplify`, `sf settle`, `sf approve`, `sf mr`, `sf abort` and `sf reset` use it to find the socket; `sf notify-test` reads the notification variables itself.

## Task check

The Task check (SF-054, `src/task-check.ts`) reads a Task file before Start, the way the
Elephant–Goldfish model reviews a plan before anyone builds it: with a reader that sees only the
document and the code. It only advises: Start is never refused for it.

- **The run**: a fresh Agent SDK `query()` with the Claude review's session options (section Jobs,
  the review): the tools `Read`, `Grep` and `Glob` only, the review's denied tools, sandbox and
  filtered environment, `settingSources: ['project']`, no auto-memory, no instruction file above
  the checkout; `maxTurns` `SF_TASK_CHECK_MAX_TURNS` (default 30), model `SF_REVIEW_MODEL`. Its
  prompt is fixed instructions, the coding rules read at the commit of its checkout (SF-059,
  section Coding rules) and the Task file, nothing else: not the Context owner's conversation, the
  user's request, the jobs, their reviews or the ledger.
- **What it can read** (the repository, nothing else):
  - It runs in its own checkout: a detached worktree of the workspace's work checkout at the Task's
    `base` (fetched from `origin` when there is one, as Start does: the code the Implementer starts
    from), in a new directory under the system's temporary directory, removed when the check ends.
    The worktree has no `.software-factory/` folder (the other Task files, the MR texts, the
    archive are never committed). A base that cannot be checked out is a failed check.
  - Every symbolic link in it whose target is outside the worktree (or does not resolve) is
    replaced by a small file saying so before the session starts, so a search from the root that
    follows links stays inside.
  - A PreToolUse hook of the factory (`guardHooks`, SDK `hooks`) sees every tool call before it
    runs. It lets the SDK's `StructuredOutput` tool through unchecked (SF-070): the session gives
    its answer (`outputFormat`) by calling it, and it carries that answer, not a file access; the
    name is matched exactly, so no other tool passes as it. Any other tool but `Read`, `Grep` and
    `Glob` is denied. Of these three, it denies any path it names (`file_path`,
    `path` or `notebook_path`, whichever is given, and the `Glob` pattern up to its first glob
    segment) that resolves (symlinks followed) outside the worktree or into a `.software-factory`
    folder in it; a value Claude Code would trim or expand (`~`, `~/...`, surrounding spaces),
    refused rather than guessed; and a pattern that climbs with `..`. A pattern's brace
    alternatives (`{a,b}`, nested ones too) are expanded and each checked on its own (an absolute
    one by its own prefix; any absolute one in Grep's `glob` filter is refused); braces that do
    not pair, a backslash, an extglob or `|` (`@(a|b)`, `!(a)`, ...), more than 16 brace groups or
    64 alternatives, or a value over 4096 characters refuse the call. The guard never throws: a
    call it fails to check is denied (Claude Code would take a hook that throws as no decision). This
    covers Grep and Glob, which Claude Code's `Read(...)` rules cover only on a best-effort basis.
  - On top of that, `Read(//<dir>/**)` rules deny the work checkout's `.software-factory/` folder,
    the state directory (jobs, ledgers, requests, checks) and the config directory.
  - The stored check records the base `commit` it read.
- **The output** (one zod definition, `checkOutput`, sent as the JSON schema): `paraphrase` first,
  what the Task proposes in the checker's own words (3–8 sentences), written before any finding;
  `findings`, each `{kind, severity, where, problem, expected}` with `kind` `decision` (a choice the
  Implementer would have to make), `contradiction` (a claim about the code that the code
  contradicts, with its `path:line`), `missing` (a file, test or acceptance criterion the goal
  needs and the Task does not name), `overreach` (a part the goal does not need) or `unclear`, and
  severity `blocker`, `major` or `nit` as for the reviews (SF-051); `files`, `{path, action:
  create | modify | delete}`, the files the checker expects to change; `verdict`.
- **The factory's rules**: a `contradiction` is always a blocker; when the Task has `scope:`
  (SF-053), an expected file outside it (and outside `may_touch:`) is a `missing` major finding
  and a scope entry no expected file matches an `overreach` nit, unless the checker named them
  already; the verdict is `ready` with no blocker or major and `not_ready` otherwise, whatever the
  checker wrote.
- **Storage**: `<state>/checks/<ws>/<ticket>/<first 16 hex of the Task file's sha256>.json`: the
  output, the model, the estimated cost and the times; never in the work checkout. A later check
  of the same Task file replaces it. A check of another version of the Task file than the current
  one is **stale**. A failed check (an error, a turn limit, no or an invalid output) is stored as
  `failed` with its error, withheld or redacted like a failed review's (SF-045); it never counts
  as ready.
- **Where it runs and shows**: `sf check-task <workspace> <ticket>` runs one in its own process
  (no `sf serve` needed) and prints the paraphrase, the findings by severity, the files and the
  verdict, and where it stored the record (an open dashboard shows it at its next refresh). On the dashboard a Queue card has **Check** (`POST
  api/tickets/<ws>/<ticket>/check`: answers at once, refused with `check_running` while one runs
  or is being set up for the ticket (the ticket is reserved before anything else, so two requests
  at once start one check) and with `task_draft` for a skeleton) and a note with the last check (`not
  checked`, `checking…`, `check: ready`, `not ready: N blocker, M major`, `check failed`, `· stale`); the
  tickets of the stream carry the summary (`check`). `GET api/tickets/<ws>/<ticket>/check` is the
  last check with `stale`, `running` and the current sha256; the planned ticket page shows it in its
  Plan check card (section Dashboard, SF-081) and the job's Task tab above the Task text, the
  paraphrase above the findings. Start's confirmation adds "Task
  check: not checked", "stale", "check failed" or "not ready: N blocker, M major" when that is the
  case, and starts anyway once confirmed. The Context owner reads it with the read-only MCP tool
  `task_check` (`{workspace, ticket}`): the check of the current Task file (`verdict` `ready`,
  `not_ready` or `failed`, the paraphrase, findings and files), or `verdict: "none"` when the
  current version has none, so ChatGPT can rewrite the Task from the findings; it cannot run one.

## Coding rules

Repositories keep their coding rules in `AGENTS.md` and the documents it links to; the user keeps
rules of their own outside the repository. The factory hands the agents these documents as they
are (SF-059, `src/rules-docs.ts`): no rule format, no checks of its own. The repository's rules win
over the user's when they disagree; neither changes the factory's own rules (Git, the Task file,
the Report, the Fix sections, the tools).

- **What is collected**, in this order:
  1. **Repository**: the instruction file at the root (`AGENTS.md`, else `CLAUDE.md`, else
     `.github/copilot-instructions.md`), then, for `AGENTS.md` only, every Markdown file it links
     to: one hop, in link order, once each. A link is an inline `[text](path)` or a reference link
     `[text][ref]` with `[ref]: path`, outside fenced code blocks (an image `![alt](path)` is not
     one), read from the whole of `AGENTS.md` whatever its size; the `#fragment` and `?query` are
     stripped and the path resolved from `AGENTS.md`'s directory. Only a target ending in `.md`
     that is a regular file at the commit counts: URLs, absolute paths, paths that leave the
     repository and symbolic links are ignored. An instruction file must be a regular file too: an
     `AGENTS.md` that is a symbolic link is passed over for the next one. Everything is read from Git at a commit
     (`ls-tree`, `cat-file`), never from a working tree.
  2. **Workspace**: `<config dir>/rules/<workspace>.md`, if it exists.
  3. **Global**: `<config dir>/rules/global.md`, if it exists (once, for a workspace named `global`).
- **`rules_skip`**: a workspace's globs in `workspaces.json` (section Workspace registry) leave
  repository files out (the instruction file or a linked one; never the user's rules files). The
  software-factory workspace skips `docs/runbooks/coordinator.md`, the coordinating session's
  runbook its `AGENTS.md` points to.
- **Budget**: at most `SF_RULES_MAX_BYTES` (default 48 KiB) of file content; the headings and the
  sentence do not count. Files are taken whole in order; the first that does not fit and every
  later one are named in a closing line `Not included, read them if relevant: …`.
- **The block**: `<rules>`, the sentence "These are the repository's and the user's coding rules:
  …", each file under `### <source>: <path>` (`repository` with its repository path, `workspace`
  as `rules/<workspace>.md`, `global` as `rules/global.md`), the closing line when files were left
  out, `</rules>`. No rule file found: no block, and every prompt is as before.
- **When**: once at Start (and at Restart), at the job's first base commit. The block is stored as
  `<job dir>/rules.md` and its list (the commit, the budget, each file given with its source, size
  and sha256, the files left out and the ones `rules_skip` skipped) as `<job dir>/rules.json`;
  every later prompt reuses that copy, after a rebase or an `sf serve` restart too, so a job cannot
  change the rules it is judged by. Each published iteration copies `rules.json` to
  `iterations/NNN/rules.json`. A job started before SF-059 has no `rules.md`: no block, no copy.
  When the rules cannot be collected or stored (an unreadable rules file, say), the job fails with
  `rules_failed` before any Implementer session, its worktree kept; fix the cause, then
  `sf restart` the ticket.
- **Where it goes**:
  - the prompt that opens an Implementer session: Start and Restart send `/implement <Task file>`,
    a blank line, the block (then the kept-files note of `--keep-files`); a Resume without a
    session yet sends the same first prompt without a message, or the block, a blank line and the
    message (or "Continue where you stopped."). Later turns in the session do not repeat it;
  - every Claude review and Codex gate prompt (`reviewBody`), before the Task file, with the line
    "A review item that is a rule violation names the rule's file (and heading) in `problem`";
  - the Task check's prompt (section Task check), collected at the commit of its checkout.
- **`sf rules <workspace> [ticket]`** lists the files that would be given (paths, sources, sizes,
  the files left out by the budget and by `rules_skip`), never their text. For a ticket whose job
  has started it prints the job's stored `rules.json`, the rules its prompts carry whatever the
  rules files and `SF_RULES_MAX_BYTES` say today (or says the job has none: started before SF-059,
  or failed with `rules_failed`); otherwise it reads them at the Task file's `base` (fetched from
  `origin` as Start does), and, without a ticket, at the checkout's `HEAD`.

## Ticket images

SF-064. The user explains a ticket with screenshots: pasted from the clipboard (Ctrl+V / Cmd+V)
into New ticket or onto the planned ticket's page, dropped there as files, or added with
`sf attach`. They live next to the Task file, in `.software-factory/<ticket>/` of the work
checkout (out of Git with the folder), and ChatGPT reads them with `read_attachment` while it
writes the Task file. The Task file refers to an image with plain Markdown, the path relative to
the Task file: `![the login form](<ticket>/1.png)`; only the images the Task file refers to count
for the job (handing them to the Implementer and the reviewers is SF-065).

One set of rules (`src/attachments.ts`) for the dashboard, the CLI and MCP:

- **Type** from the first bytes only: PNG, JPEG, WebP or GIF; anything else (a text file renamed
  `.png`, an SVG, a PDF) is `attachment_type` (400).
- **Limits**: at most 5 MB (`5 * 1024 * 1024` bytes) each, `attachment_too_large` (413), and 10 per
  ticket, `attachment_limit` (409).
- **Names**: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|jpg|webp|gif)$` with the extension of the
  detected type (`jpg` for JPEG), else `invalid_name` (400): no `/`, no `..`, nothing outside the
  ticket's folder. A name that exists is refused, never replaced. Without a name, the next number:
  the highest number in the folder + 1 (`1.png`, `2.png`, …; a gap after a removal is not reused;
  numbers of any length a name allows count, and a successor too long for a name is `invalid_name`).
- **Listing and counting**: only the regular files whose names match the pattern and whose bytes
  are the type their extension says; anything else in the folder (a link, a directory, a text
  file) is ignored, and is never served.
- **The Task file** `.software-factory/<ticket>.md` must exist to add, remove, list or read
  (`task_not_found`, 404): an archived ticket's images cannot be changed. The ticket `archive` (the
  archive folder's name) and a key ending in `.md` cannot have images (`invalid_ticket`).
- **Guard**: `write_task`'s rule: adding or removing is refused with `job_active` (409) while a job
  of the ticket is in a non-terminal state other than paused. Reading goes on.

`write_task` (and the page's Save) refuses with `attachment_missing` (400) a Task file whose image
reference `![…](<ticket>/<name>)` (outside fenced code blocks; the target is the text after `(` up
to the first space or `)`, as written) names an image the ticket does not have; other targets (a
URL, `./…`, another ticket's) are not checked, and neither is a Fix section.

**Archive, restore, delete** (`src/setup.ts`): Archive moves `.software-factory/<ticket>/` to
`.software-factory/archive/<ticket>/` after the Task file, replacing an older archived folder, so a
reference in `archive/<ticket>.md` still resolves next to it; Restore moves it back after the Task
file and is refused with `ticket_exists` before anything moves while `.software-factory/<ticket>/`
exists; Delete removes both folders with the Task files. A new ticket starts without images (a
folder left behind by a Task file removed by hand goes when New ticket writes the skeleton).

**`read_attachment(workspace, ticket, name)`** returns the image as MCP image content
(`{type: "image", data, mimeType}`) and one text line `<name>: <type>, <bytes> bytes`. Whether
ChatGPT's connector shows MCP image content to the model is checked live (SF-064 Step 1); until
then the page's **Copy image** puts an image on the clipboard to paste into ChatGPT by hand. The
ticket's first message names its images and how to read and refer to them: "The ticket has
images: 1.png, 2.png. Read each with read_attachment (workspace "<ws>", ticket "<ticket>", name). In
the Task file, refer to the images the Task needs as ![what it shows](<ticket>/<name>)." The
tickets payload follows the folder on each refresh, so the link and the message do too.

**`sf attach <workspace> <ticket> <file> [name]`** copies a file into the folder under the same rules
(a file over 5 MB is refused unread); `--remove <name>` removes one. Both work on the files
directly, without `sf serve`, with the same guard.

**On the dashboard** (section Dashboard): New ticket takes images pasted anywhere in its form or
dropped on it, shows each as a thumbnail (`blob:` URLs, so the CSP's `img-src` is `'self' blob:`)
named `1.png`, `2.png`, … in paste order with its real type's extension, with ×; "Create the ticket"
posts `api/tickets` as before, then uploads each image in order under that name. When an upload
fails the ticket stays created, and the form says which images failed and why, to be added on the
ticket's page. The planned ticket page's **Images** card shows each image (a click opens it whole
in a new tab), × to remove it and **Copy image** (`navigator.clipboard.write` with an `image/png`
item; JPEG, WebP and GIF are drawn on a canvas and copied as PNG), and the area "Paste an image
here (Ctrl+V) or drop one.": a paste anywhere on the page while it is shown, or a drop of one or
more files on the area, uploads each at once without a name. A text paste (into the Task file
editor, the request) goes on as usual: only clipboard files are taken. There is no file picker
(the prototype's "choose a file" is left out: the user said none is needed).

## Jobs

One job per ticket; several jobs of a workspace at a time. A start by hand (the board's Start,
`sf start`) always goes; the run queue (SF-071, section Run queue) starts the queued tickets by
itself while fewer than its limit `max_running` of jobs run in every workspace together. Every job works in a **worktree** of its own (SF-019,
ADR-0004): `${SF_WORKTREE_ROOT:-<state dir>/worktrees}/<workspace>/<ticket>`, created from the
workspace's checkout; the checkout itself (the user's IDE checkout) is never written by the
factory beyond its Git refs (branches) and worktree registrations, except by the hand-over to it
and back (SF-073, section Hand-over to your checkout).

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
  through files: `start`, `sf say`, a Fix section, Clean, `sf review`, `sf accept` and `sf settle` write a request
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
  Its prompt says what to verify and defines the item severities, then carries the Handbook's
  `## Review rules` verbatim, the Task file (with its `## Review brief` when there is one), the Report, the
  marked paths of the iteration (`<marked_paths>`: sensitive, outside the Task's scope, deleted;
  below), the ledger's settled findings
  (`<settled_findings>`, SF-052) and the Patch inline up to 256 KiB (beyond that, the
  first 256 KiB and a note to read the changed files). Its output is structured
  (`outputFormat: {type: "json_schema"}`), validated with zod: `{verdict: "clean" | "fix", summary,
  items: [{path, problem, expected, severity, reopens, caused_by}], accepted_sensitive}`, `severity`
  one of `blocker` (the change is wrong, unsafe or breaks the Task's acceptance), `major` (a real
  defect or a Task requirement not met, but contained) or `nit` (style, naming, wording, a narrower
  variant of a risk already accepted, a nice-to-have); `reopens` (the settled finding the item
  reopens) and `caused_by` (the fix whose change caused it) each a ledger id (`R7`) or `""`, by the
  pattern `^(?:R[1-9]\d{0,5})?$`, required in the schema sent and read as `""` when absent (records
  before SF-052); any other value is an invalid verdict. One definition, `reviewItem` in
  `src/review.ts` (SF-051, SF-052), for both reviewers. The SDK hands the schema to the Claude
  Code CLI as `--json-schema`. It is generated as draft-07 and sent without `$schema`, because the
  CLI refuses the draft 2020-12 `$schema` that zod writes by default (SF-044). The fake Claude of
  the tests refuses such a schema the same way.
- The review runs outside the execution lock. Its verdict is applied under the lock only while the
  job is still `awaiting_review` at the same iteration; otherwise (an `sf say` or an abort came
  first) it is recorded and ignored. The factory decides how to act on a verdict, the same way for
  both reviewers (`decide` in `src/review.ts`, SF-051): it is a fix only when it has at least one
  `blocker` or `major` item (whatever the verdict says), or when an undeclared sensitive path or a
  path outside the Task's scope (SF-053) is not in `accepted_sensitive` (that path is then a
  `major` item, whatever the reviewer said of it);
  otherwise it is clean, whatever the reviewer wrote, so a `fix` with nits only goes on as clean
  (Claude's to the gate, the gate's to MR preparation). Before that rule the ledger applies to the
  verdict (SF-052, below): dropped items, disputes and churn. A fix writes `## Fix N` (the summary as
  a lead line, then one numbered line per blocker and major item with its ledger id, `1. [R7, major]
  \`path\`: problem Expected: expected`, then the nits numbered on under `Nits (optional):`, which
  the Implementer may leave) and runs the next iteration (the fix path, below). A clean runs the clean path
  (below) with `accepted_sensitive`. A review stored before SF-051 (items without `severity`) reads
  as all `major`. A review that fails (an error, a turn that is not a success, no or an
  invalid structured output, `fix` without items) puts the job in `needs_human` with
  `review_failed`; nothing is retried by itself. `sf abort` and `sf reset` cancel a running review, whose
  outcome is then never applied; a newer review of the same job cancels an older one.
- Every review that ends is kept in `iterations/NNN/review.json`: `{reviewer: "claude", verdict,
  summary, items, accepted_sensitive, dropped?, cost_usd, started_at, ended_at}` (`dropped`: the
  items that reopened an accepted risk, SF-052), or `{reviewer, error}` when
  it failed. The verdict is recorded as the reviewer gave it. One line goes to `events.jsonl`:
  `{type: "review", reviewer, verdict, items: <count>}`, with `effective: "clean" | "fix"` when the
  factory acted otherwise (a `fix` with nits only; a `clean` with a blocker or major item, or one
  that leaves an undeclared sensitive path unaccepted), or `{type: "review_failed", reviewer, error}`, with `ignored: true` when the job had
  moved on. `sf watch` and the dashboard's Event stream show it as `review by claude: fix (3
  items)`, `review by claude: fix (2 items), acted on as clean`, `review by claude: clean` or
  `review by claude failed: <error>`. A cancelled review leaves no
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
  `clean` or `fix`, with no blocker or major item, that accepts every undeclared sensitive path). The job then takes the same path as after a
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
  stay visible for a follow-up ticket. Since SF-052 it also takes on the ledger's stops
  `review_churn` and `review_disputed` (below), with the same clean Claude review; `unapplied` is
  then the ledger's open findings (open entries, fixes the user decided, disputed contests), each
  with its `id`, plus the items of the iteration's gate that reopen none of them.
- The **findings ledger** (SF-052, `src/ledger.ts`): `jobs/<ws>/<ticket>/ledger.json`, one entry per
  review item that went into a Fix section: `{id, iteration, reviewer, severity, path, problem,
  expected, status, response, evidence, reopened, asked, caused_by, dispute, settled}`. `id` is
  `R1`, `R2`, … per job, in Fix order; `asked` is the Fix section that listed it last. `status` is
  `open`, `fixed`, `contested`, `escalated`, `left` (a nit not done), `accepted_risk` or `user_fix`.
  It is written atomically under the job lock, and `sf reset` archives it with the job.
  - Fix sections carry the ids: `1. [R7, major] \`path\`: problem Expected: expected`; a fix the
    user decided ends with `The user decided: fix.` and the user's note, and is never optional.
  - The Implementer answers each item in the Report: `| R7 | fixed / contested / escalated / left
    | <evidence or note> |`. After each iteration the factory reads the table of the Fix section it
    answers, leniently: a row it cannot read leaves its entry `open`. `contested` needs evidence a
    reviewer can check without the Implementer: a `path:line` of a file in the worktree (the line
    within it), a test file or a quoted test name that a test file of the worktree holds (`git grep
    --untracked`), or a `§section` of the Task file; without it the
    entry is `open`. `escalated` needs a question; `left` is for nits only (a blocker or major reads
    as `open`); a `user_fix` entry is settled by `fixed` only. An `open` blocker or major comes back
    in the next Fix section, even under a clean verdict. An entry for an undeclared sensitive path
    is settled by the reviewers' acceptance of the path instead. The factory's item for a path not
    accepted reopens the path's entry and goes through the same rules as a reviewer's: dropped once
    the user accepted the risk (the path then counts as accepted and Clean passes it), a dispute
    when the entry is contested, reopened (and churn the second time) when it was fixed, the same id
    while it is open.
  - **Escalation** stops the job before the review: `needs_human` with code `escalated` and the
    questions in the message.
  - The reviewers see `<settled_findings>` (every entry not `open`, with its response, evidence and
    the user's decision) and the rule not to raise a settled finding again, nor a narrower variant;
    only a settlement wrong by evidence in the worktree is raised again, with `reopens` set to its
    id. Both reviewers' item schema has `reopens` and `caused_by` (a ledger id or `""`; `""` when
    absent in older records). A fix verdict of either reviewer reads against the ledger, in this
    order: an item that reopens an `accepted_risk` entry is dropped (`dropped` in `review.json` or
    `gate.json`), by its `reopens` id or, raised again without it, by the same path and problem text
    (the known limit: a narrower variant in new words is not matched; only the prompt's rule keeps
    the reviewer from raising it); a blocker or major that reopens a `contested` entry is a dispute (`needs_human`
    `review_disputed` with the contest's evidence and the reviewer's reason); a blocker or major
    that reopens a `fixed` or `left` entry makes it `open` with `reopened` + 1 and the higher of the
    two severities (a nit never reopens one: it stays optional under the entry's id), and a second
    reopening is
    `needs_human` `review_churn`; when every blocker and major item left names an existing entry in
    `caused_by`, it is `review_churn` as well. Otherwise the verdict applies as before (SF-051).
  - `sf settle <workspace> <ticket> <id> accept|fix [note...]`, or *Accept risk* / *Must fix* on the
    dashboard (`POST api/jobs/<ws>/<ticket>/settle`), settles an `escalated` or `contested` entry
    while the job is `needs_human`: `accept` makes it `accepted_risk`, `fix` makes it `user_fix`.
    The result is `{state, id, status, waiting}` (`waiting`: the entries still to settle). Once a
    stop with `escalated` or `review_disputed` has no escalated entry and no disputed contest left,
    the job goes on by itself (after `review_churn` a settlement is only recorded; `sf say` goes on).
    When the user decided a fix, a Fix section by "the user" follows with the `user_fix` entries
    (named in its lead line) and the open blockers and majors carried along; otherwise the review
    that stopped runs again, and brings the open entries back itself (the gate when the
    gate stopped it, the Claude review otherwise; `review.json` or `gate.json` of the iteration is
    removed first). Refused with `invalid_state` in another state or for another entry, with
    `invalid_content` for a bad id, decision or note.
  - A stop's message (the job's error) stays within 2,000 characters. Its question with its answers
    is fixed text and always kept whole; what happened names at most ten ids (`R1, …, R10 and 50
    more`); the facts get the room left: as many as fit at 120 characters or more, each shortened
    to an equal share and marked `…`, the rest counted (`… and 50 more findings: see ledger.json.`).
    Nothing is cut from the assembled message (`stopMessage` in `src/ledger.ts`).
  - At a ledger stop the user has one question with three answers: accept and prepare the MR
    (`sf accept`, when the last Claude review of the iteration is clean), continue (`sf settle` or
    `sf say`), or back to planning (`sf abort`, keeping the branch). There is no rule of two clean
    rounds: one clean gate ends the loop, and `SF_GATE_MAX_ROUNDS` stays the cap.
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
  still `awaiting_review` at the same iteration, by the same rule as Claude's (`decide`, SF-051).
  Clean (a `fix` with nits only too) runs the clean path with the union of both reviewers'
  `accepted_sensitive`; an undeclared sensitive path or a path outside the Task's scope the gate
  does not accept is a major fix item.
  A fix writes `## Fix N` (lead line `Review by Codex: <summary>`) and runs the next
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
  summary, items, accepted_sensitive, dropped?, model?, tokens: {input, cached_input, output},
  started_at, ended_at}` (`dropped` as in `review.json`), or `{reviewer, error, model?, tokens, started_at, ended_at}` when it failed (`model`
  only with `SF_CODEX_MODEL`). Its event lines are the review's, with `reviewer: "codex"`: `review
  by codex: clean`, `review by codex: fix (2 items)`, `review by codex: fix (2 items), acted on as
  clean`, `review by codex failed: <error>`.
- The job counts its Fix sections in `fixes` (the reviewers'). Once it reaches
  `SF_MAX_ITERATIONS`, the next Fix is refused: `needs_human` with `iteration_limit`. An `sf say`
  turn publishes an iteration but writes no Fix section, so it does not count.
- The fix path appends `## Fix N` to the Task file of the checkout, copies it into the worktree
  and runs `/implement .software-factory/<ticket>.md Fix N` in the same session (`resume`). From
  `ready_for_human_review` it first reopens a worktree from the branch (`git worktree add <path>
  <branch>`): the next iteration's Patch is the whole change against the target, and the next
  Clean commits the whole change again as one commit.
- The clean path runs the MR preparation (section below) and ends in `ready_for_human_review` with
  the branch in the checkout. It takes `sensitive`, the undeclared sensitive paths and the paths
  outside the Task's scope of the reviewed iteration the reviewers accept; any left out refuse it
  with `sensitive_unacknowledged`.
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
- The **simplification pass** (SF-055, `src/simplify.ts`): reviewers add, nobody removes, so once
  per job, after the deciding clean verdict (the gate's, or with the gate off the Claude review's;
  clean as the factory acts on it, SF-051) of a job with `fixes` ≥ 1 (at `SF_MAX_ITERATIONS` too),
  a fresh read-only Agent SDK
  `query()` runs like the Claude review (its tools, the isolation of SF-050, the sandbox,
  `SF_REVIEW_MODEL`, `SF_REVIEW_MAX_TURNS`; its messages go to `events.jsonl` as `review_message`
  of reviewer `simplify`, redacted). `SF_SIMPLIFY=off` skips it. Its prompt holds the Task file
  without its Fix sections (cut at the first `## Fix N` heading), the whole ledger, per Fix section
  N the files iteration N+1 changed (its Patch compared file by file with iteration N's), and the
  final Patch; it asks what in the change exists only to satisfy a review item and is not needed
  for the Task's goal, its acceptance or a blocker or major ledger entry still valid, and forbids
  touching what a `fixed` blocker entry needed (named by id, security above all). Its answer is
  `{summary, suggestions: [{path, what, why, saves_lines, ledger_ids}]}`; the factory drops every
  suggestion whose `ledger_ids` name a `fixed` blocker entry or whose path is the path of one (the
  prompt names those paths too), whatever the pass says: the path check does not trust the pass's
  `ledger_ids`. It stores
  `iterations/NNN/simplify.json` (`{reviewer: "simplify", summary, suggestions, dropped, cost_usd,
  model, started_at, ended_at}`, or `{reviewer, error, started_at, ended_at}` for a failed run, its
  message redacted) and a `simplify` event (`{reviewer, suggestions, dropped, error?, ignored?}`; a
  pass the job moved on from leaves only its event, `ignored`).
  - No suggestion, or a failed run: the job goes on to MR preparation as before.
  - Suggestions: `needs_human` with `simplify_offered`, the message listing them (within 2,000
    characters, `stopMessage`). The user chooses:
    - **Simplify**: `sf simplify <workspace> <ticket>`, or *Simplify…* on the dashboard (`POST
      api/jobs/<ws>/<ticket>/simplify`), writes one Fix section `## Fix N: Simplify` with the
      suggestions and runs the normal pipeline (the Implementer, the Claude review, the gate). It
      counts in `fixes`, and it is written even at `SF_MAX_ITERATIONS` (the one Fix that may go
      over the limit; the next reviewer fix after it stops with `iteration_limit` as usual). Each
      suggestion becomes a ledger entry of reviewer `simplify`, `accepted_risk` with the note
      "removed by the user's choice", asked in that Fix: the reviewers see it as the user's choice,
      an item that reopens it, by its id or the same path and problem text, is dropped whatever its
      severity (SF-052 rule 1), a defect the removal causes is a new item reviewed as usual, and the
      MR's `### Review findings not fixed` leaves it out. An item the Implementer answers other than `fixed` becomes `left` with its note
      (no longer the user's removal). Result `{state, iteration, check_after_minutes}`; a
      `simplify_chosen` event (`choice: "simplify"`). Refused with `invalid_state` outside
      `simplify_offered`, and once the ledger holds a Simplify.
    - **Skip**: `sf accept` (*Accept and prepare MR…*), allowed for `simplify_offered`: MR
      preparation with the paths both reviewers accepted; `simplify.json` gets `skipped_at`, a
      `simplify_chosen` event (`choice: "skip"`), no `gate-override.json`. The suggestions go into
      the MR text (below). Answering the offer with `sf say` is neither: nothing is listed.
  - At most once per job: before the pass starts, the factory writes the iteration it runs on to the
    job (`simplify_iteration` in `job.json`), and a job that has it never gets another pass, whether
    that run ended, failed, was cancelled, or the job moved on (`sf say`) while it ran. A runner that
    ended before the outcome applied is resumed: the stored `simplify.json` applies; one that ended
    while the pass ran records it as failed ("interrupted") and goes on to MR preparation.
- `sf say` queues a message as the next turn (in `working`, `awaiting_review`, `needs_human` or
  `ready_for_human_review`, where it reopens the worktree like the fix path); outside `working`
  the job goes back to `working` and publishes a new iteration at the end.
- **The turn limit** (SF-069, `src/turn-limit.ts`). An Implementer turn that reaches `SF_MAX_TURNS`
  (the SDK's `error_max_turns`) goes on by itself when it made progress: the worktree changed
  during the turn (its changed paths or the hash of its whole Patch, binary content included and
  never cut at the Patch's 2 MB display limit, differ from the turn's start; taken at the start of
  every turn, continuations too) and the turn was not repeating itself (among its
  last 20 tool calls, no call with the same tool and the same input appears more than 3 times). The
  factory then sends one continuation into the same session, with the same deny list: "You reached
  the turn limit of this turn. Continue where you stopped; do not redo finished work." It records
  `{ts, iteration, type: "turn_limit_continued", continued, allowed, max_turns, changed_paths,
  tool_calls}` in `events.jsonl` and the chain's count in `job.json` (`turn_limit: {continued,
  allowed}`). A chain gets at most `SF_TURN_LIMIT_CONTINUES` continuations (default 1), bounded by
  the session driver whatever the progress test says; every prompt the factory or the user sends
  (the first turn, a Fix section, `sf say`, Resume, MR preparation) starts a new chain and clears
  the count. `sf status`, `sf watch`, the notifications and the board's card show the continuation
  as one line ("The Implementer reached the turn limit while making progress; the factory went on
  by itself (1 of 1)."). Otherwise the job stops in `needs_human` with code `max_turns` and one of:
  - "The Implementer used all <N> steps of this turn without changing files."
  - "The Implementer used all <N> steps of this turn and was repeating `<tool> <input>`." (with
    "without changing files and was repeating" when both hold)
  - "The Implementer used all <N> steps of this turn twice in a row; it may need a smaller task or
    a higher SF_MAX_TURNS." (with `SF_TURN_LIMIT_CONTINUES=0`: "… of this turn; it may need …").

  The Claude review's, the gate's and the Task check's turn limits are not affected.
- A failed turn, a session that does not report permission mode `auto`
  (`permission_mode_mismatch`), an unavailable sandbox (`sandbox_unavailable`, with the SDK's
  message), a failed review (`review_failed`), a failed gate (`gate_failed`), the gate's round
  limit (`gate_rounds`) or token ceiling (`gate_budget`), the iteration limit, or the ledger
  (`escalated`, `review_disputed`, `review_churn`), or the offer of the simplification pass
  (`simplify_offered`) put the job in `needs_human`. After a gate code, `review_disputed` /
  `review_churn` or `simplify_offered`, `sf accept` (above) goes on to MR preparation; after a
  ledger code `sf settle` settles a finding; after `simplify_offered` `sf simplify` applies the
  suggestions; otherwise `sf say` starts another iteration.
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
- `sf pause`, `sf resume` and `sf restart`: section Pause, Resume and Restart below.
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

### Marked paths

The factory marks three kinds of changed path in the structured file list (`files` of
`meta.json`), the Report, the reviewers' prompt (`<marked_paths>`), `sf status`, the notifications
and the dashboard's file list: sensitive, outside the Task's scope, and deleted.

Sensitive. `SENSITIVE_PATHS` in `src/rules.ts` (globs from the repository root: `*` and `?` inside one
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
is), the paths outside the Task's scope under `### Outside the Task's scope` (below) and the
deleted paths under `### Deleted`; `sf status <ws> <ticket>` prints `sensitive:`, `out of scope:`
(only when the Task declares a scope) and `deleted:` lines; the `awaiting_review` (with
`SF_NOTIFY_ITERATIONS=on`), `ready_for_human_review` and escalated `needs_human` notifications
carry the same summaries on one line, separated by `; ` (`notificationLine` in `src/patch.ts`): the
body holds three lines, so the ready notification shows the branch, the title and every marked-path
summary, the out-of-scope one included. `.env` files stay denied to the Implementer; listing
them is a second net for files created by tools it runs.

Outside the Task's scope (SF-053). The Task file's front matter may declare `scope:`, in the forms
of `may_touch` (`[a, b/**]` or `a, b`): the files the ticket is expected to create, modify or
delete, tests and docs included. Each changed path gets `scope: "in" | "out" | "none"` in the file
list (`fileChanges` in `src/patch.ts`, `scopeOf` in `src/rules.ts`, the same glob rules): `in` when
`scope` or `may_touch` names it, `out` otherwise, `none` when the Task declares no scope (no field
or an empty list: nothing is checked). A file list written before SF-053 reads as `none`. A path
`out` of scope stays only when a reviewer names it in `accepted_sensitive` (the field keeps its
name for stored records; its schema says "the undeclared sensitive or out-of-scope paths you
accept, each justified in summary") and justifies it; otherwise the factory adds the major fix
item `` `path`: Outside the Task's scope. Expected: Remove the change, or justify it in the Report. ``,
as it does for an undeclared sensitive path, with its own ledger entry. A path that is both
undeclared sensitive and out of scope raises both items, each with its own entry; naming it once in
`accepted_sensitive` (or the user accepting it as a risk) settles both.
The dashboard's file list marks such a path "out of scope".

### Pause, Resume and Restart

SF-067. To change course without abort, reset and a branch deleted by hand.

- **Pause** (`sf pause`, the job's *Pause*, no confirmation) takes a `working` or `awaiting_review`
  job. It stops the job's runner the way abort does (the SDK abort, then SIGTERM and SIGKILL of
  the runner's process group, so no Claude Code and no Codex is left) and the job goes to
  `paused`. The worktree, the branch, the Implementer's `session_id`, the iterations, the ledger
  and the events stay. `job.json` records `paused`: the state it was paused in (`from`), what was
  interrupted (`step`: `turn`, `review`, `gate`, `simplify`, or null when nothing ran, as while
  awaiting review with `SF_REVIEW=off`) and when. A review, gate or simplification round that ran is
  thrown away: no `review.json`, `gate.json` or `simplify.json` and no verdict event, only an
  `interrupted` event (`sf watch`: "review by claude interrupted by the pause"); an interrupted
  simplification pass does not use up its one run per job. `preparing_mr` is refused
  (`invalid_state`, with the reason: the MR text, the commit and the rebase); so is any other state.
  A step that ended on its own while the runner stopped leaves the job as it left it; one that had
  just begun MR preparation hands the job over as `needs_human` (`mr_interrupted`; `sf say` goes on).
- **Resume** (`sf resume [message...]`, the paused job's *Resume*, no confirmation) goes on where
  the job stopped. A paused turn: the job is `working` again and the same Implementer session is
  resumed with the message, or "Continue where you stopped." (a job whose first turn never reported
  a session runs `/implement` again). A paused review round: the job is `awaiting_review` again and
  that round (the Claude review, the gate or the simplification pass) runs again on the same
  iteration; a message is refused then (`invalid_content`: resume, then `sf say`). A paused job
  needs its worktree (`worktree_missing`); Resume is a start by hand, never held by the run queue's
  limit (SF-071), and a paused job does not count as running.
- **The Task file while paused.** The factory keeps the Task file as the Implementer was last given
  it, `task.md` in the job directory, and the sha256 of the version the job works from as
  `task_sha256` in `job.json`, both written at Start and at every later copy into the worktree (a Fix
  section, `sf say`, MR preparation). `write_task`
  is allowed while the job is `paused` (refused, `job_active`, in the other live states). On Resume
  a Task file that differs is copied into the worktree, its sha256 recorded in `job.json` at once
  (a resumed turn and a resumed review round alike) and a `task_changed` event written; the
  reviewers read the new one from then on. A resumed turn's message carries the unified diff (at
  most 64 KiB; a longer one asks the Implementer to read the file again); after a resumed review
  round `task.md` keeps the version the Implementer was last given, and the Implementer gets the
  diff with its next prompt (the Fix section or `sf say`), taken before the factory appends its own
  Fix section. The
  board shows "Task file changed since the job started" on a paused job whose Task file differs
  (`task_changed` in `api/jobs`).
- **Restart** (`sf restart [--keep-files]`, the job's *Restart…*, confirmed with what is thrown
  away and a *Keep the files* checkbox) takes a `paused`, `aborted`, `failed` or `needs_human` job.
  It starts the ticket again from its current Task file (its base and title: the branch name may
  change) as a new job on a fresh worktree and branch from the Task's base, after the checks of
  `start` (`task_draft`, a new branch name that exists: `branch_exists`; no run limit, SF-071). The old job is retired as `sf reset` retires it (its runner stopped, its worktree
  removed, its directory archived as `<ticket>.<timestamp>`; `archived` in the result). Its branch is
  deleted only when it has no commit beyond the job's base commit and was never pushed (checked
  before anything changes, and again in the Git lock that deletes it, once the runner has stopped): no merge
  request, no upstream, no remote-tracking branch of that name, on none of the checkout's
  configured remotes (`git ls-remote` of each, at most 30 s each: a push needs neither an upstream
  nor a fetched remote-tracking branch). Otherwise the restart is refused before anything changes
  (`restart_refused`, HTTP 409, with the reason: the commits, the remote, or a remote not
  answering); push or delete the branch
  by hand first. With `--keep-files` the old worktree's changed and new files (the Patch's paths
  against its base: ignored and credential-like files left out; deleted files not repeated) are
  saved under `<state dir>/tmp/`, copied into the new worktree before the first turn, and the first
  prompt names them; `kept` in the result lists them. Once the old worktree is removed, a failure
  (a branch delete that fails, `restart_failed`, or the new job failing to start) leaves the saved
  files where the error says.
- Notifications: `paused` is notified (default priority, "Paused during the <step>; Resume goes on
  from there."). `sf status` shows `paused` like any state.

## MR preparation

MR preparation runs on the deciding clean verdict (the clean path, from `awaiting_review`, or as
the retry from `needs_human` after a failed preparation, `mr_attempts > 0`); never while a turn runs.
It ends with the branch holding exactly one commit: handed over to the user's checkout
(`handed_over`, section Hand-over to your checkout) or, with hand-over off (the workspace's
`handoff`, else `SF_HANDOFF`) or when the hand-over was refused, in `ready_for_human_review`.
The worktree stays until the hand-over or the push (SF-073).
`sf approve` then pushes that commit and nothing else.
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
   rebases and pushes, and that the commit message is the whole MR text: the title as the header,
   then the body. It states `MR_TESTING_RULE` (`src/rules.ts`): `## Testing` lists only what was
   run in this job, with its result, and anything not run goes on a line starting with
   `Not checked:`, saying who can run it. It asks for a short report (`# Report: <ticket>, MR
   preparation <attempt>`, `## Done`, `## Open questions`) and ends with the Handbook's `## Git rules` and `## MR template` verbatim.
3. When that turn ends, the factory checks the MR text, then works in the worktree under the
   workspace's Git lock. Every Git call runs with `-c core.hooksPath=/dev/null`, so no repository
   hook runs outside the sandbox, and with a 60 s timeout.
   Before the commit, the factory writes the nits of the iteration that reached Clean into the MR
   text (SF-051): those of its `review.json` and `gate.json`, deduplicated by path and problem
   text, as a `### Nits not applied` list (`- [nit] \`path\`: problem Expected: expected`) at the
   end of `## Special things to note`. It replaces any such list already there and drops a lone
   `- None.`; without nits the text stays as written. The list is cut, with a closing line that
   counts the rest, to keep the text within 64 KiB (`withNits` in `src/mr.ts`). After it the
   factory writes `### Review findings not fixed` (SF-052, `withFindings`): every `accepted_risk`,
   `contested` and `left` entry of the ledger, one line each with its id
   (`- R7 [major, accepted risk] \`path\`: problem — <the user's note or the Implementer's>`), the
   same way; the user's simplifications are not findings and stay out. When the user skipped the
   simplification pass (SF-055), `### Simplifications not applied` lists its suggestions before it
   (`withSimplifications`: the job's last `simplify.json`, when it has `skipped_at`; `- \`path\`: what Why: why (saves about N lines; added for R3)`), so they can become a
   follow-up ticket.
   - `git reset -q --mixed <base_commit>` when the branch has commits on top of `base_commit` (a
     fix after Clean, or a retry after a commit). `HEAD` and the index go back to the base and the
     files stay, so the result is always one commit.
   - The paths: the Patch's paths against `base_commit` (tracked and untracked, without ignored,
     credential-like, `.software-factory/` paths and sandbox placeholders), minus submodules (a
     directory whose index entry has mode 160000). The Git rules forbid changing a submodule
     pointer; the Patch already reports one.
   - `git add --all -- <paths>`, 200 paths per call. An empty index diff is `mr_empty`.
   - `git commit -q --cleanup=verbatim -F <file>`: the commit message is the whole MR text, the
     factory's subsections included, normalised by `mrMessage` (`src/mr.ts`): CRLF becomes LF,
     every line loses its trailing whitespace, the title is the first line and the body the rest
     without the blank lines around it; the message is the title, a blank line and the body (the
     title alone when the body is empty). The file is `git rev-parse --git-path
     factory-commit-msg`, inside the Git dir, so it is never a change of the worktree, and is
     deleted after the commit, also when it fails (`mr_commit_failed`). `--cleanup=verbatim` keeps
     the lines that start with `#`, the MR text's headings. The forge's merge request uses the
     same `mrMessage` title and body. The identity and the signing configuration are the user's
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
   | `mr_failed`, `mr_serve_restarted` | the factory failed, or `sf serve` restarted, during preparation |

   A failed MR text turn keeps its own code (for example `turn_failed` or `sandbox_unavailable`).
   Fix with `sf say` (its iteration is reviewed again, and a clean verdict prepares again) or by
   hand in the worktree followed by an `sf say`.
6. Ready: the MR text, with the nits, is copied to `mr.md` (an MR text the user saved on the Merge
   request screen stays, below), `base_commit` and `target_commit` become the target,
   `prepared_commit` the branch tip, and the worktree stays (SF-073). With hand-over on (the
   workspace's `handoff`, else `SF_HANDOFF`, SF-083) the factory hands the job over to the checkout
   at once (`handed_over`); otherwise, or when the hand-over is refused, the job is
   `ready_for_human_review` with `handoff_skipped` saying why. Either is
   notified with the MR title and the file lines.

   **A new Clean after the user edited the MR text** (SF-080: the user saved their own text, then
   asked for changes or a fix round ran): the user's text stays the MR text. When `mr-factory.md`
   exists and `mr.md` differs from it, Clean writes the new factory text to `mr-factory.md` only,
   commits with the user's text (`mrMessage` of `mr.md`) and records `{type: "mr_edited", action:
   "factory_new"}` ("Clean wrote a new MR text; yours is kept. Compare or reset on the Merge
   request screen."). A user text that fails the rules is kept in `mr.md`, but the commit is made
   with the factory's text; approve and `sf mr create` then refuse with `mr_text_invalid` until a
   valid text is saved or the text is reset. Without an edit Clean writes `mr.md` and deletes
   `mr-factory.md`. The notification, the hand-over's prefilled message and the ready line carry
   the text the commit was made with.
7. `sf approve` (or the dashboard's Approve): allowed in `ready_for_human_review`, in
   `handed_over` (section Hand-over to your checkout), and in `needs_human` after a failed push
   (the worktree is kept then; such a job is not the retry of MR preparation). After the push the
   worktree is removed (`git worktree remove --force`, `git worktree prune`; `worktree` becomes
   null); a failed removal does not fail the push: the job keeps the path, the event log gets a
   note, and the next action that needs it gone removes it. `sf say` or a Fix section on a job
   with a prepared commit drops it (`prepared_commit` null) before the turn, so a stale commit is
   never pushed. It refuses when the branch tip is not `prepared_commit`
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
   pull request (GitHub) or merge request (GitLab) from the branch into the base, with the title
   and the body of `mrMessage`, the same as the commit's message; one already open for the branch
   is reused, never duplicated. From `ready_for_human_review` (or `needs_human` after a failed push)
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

## Hand-over to your checkout

SF-073, `src/handoff.ts`. When the factory says a job is ready for review, its changes are already
on its branch in the workspace's checkout (the one open in the IDE), so the user can read, run,
debug and change them there, push from the IDE, or ask the Implementer for changes. One name per
action, the same on the board and in the CLI:

| Board button | Command | Who may use it |
|---|---|---|
| Hand over to my checkout | `sf handover <ws> <ticket>` | `ready_for_human_review` |
| Ask for changes | `sf say <ws> <ticket> <message>` | `handed_over` (and today's states) |
| Take it back | `sf takeback <ws> <ticket>` | `handed_over` |
| I opened the MR myself | `sf handed-done <ws> <ticket>` | `handed_over` |
| Approve | `sf approve <ws> <ticket>` | `handed_over` too |

The board shows "In your checkout on <branch>" for a `handed_over` job, `sf status` and the
notification "in your checkout on <branch>" with the MR title and the file lines.

**The hand-over** runs under the workspace's Git lock, with S the job's commit (`prepared_commit`)
and B the target commit it used (`base_commit`), never the local branch named by the base:

1. Refused when the checkout has changes to tracked files (`checkout_dirty`: "<ticket>: ready, but
   your checkout has changes; hand it over when you are ready") or a rebase, merge, cherry-pick or
   revert in progress (`checkout_busy`).
2. Refused (`handover_refused`, "These files in your checkout are in the way: <paths>.") when
   anything, ignored or not, exists in the checkout at a path S adds to the checkout's `HEAD`
   (`git switch` would overwrite an ignored file there silently). Nothing has changed yet.
3. `git update-ref refs/factory/<ticket> S`: the job's commit is saved.
4. The checkout's branch (or detached commit), its untracked files that are not ignored (the
   user's own: never touched, never in the job) and its local `commit.template` and
   `commit.cleanup` are recorded on the job as `handover`, with `step: "handing_over"`.
5. The worktree lets go of the branch (`git switch --detach`, files untouched).
6. `git switch <branch>` in the checkout; Git's refusal is `handover_refused` with its text, and
   step 5 is undone.
7. `git reset -q --mixed B`: the branch at the base, the job's files as Local Changes.
8. `git add -N` of the files S adds, so the IDE lists them.
9. `git diff --quiet S` must hold; otherwise everything is put back (`handover_mismatch`).
10. The MR text's title and body go to `.git/factory/<ticket>.commit-msg`; `commit.template` points
    at it and `commit.cleanup` is `scissors`, so a commit from the command line keeps the `#`
    headings.
11. The worktree is removed (a failure is a note in the event log; the job keeps the path).
12. The job is `handed_over` with `handover: {branch, saved, base, previous, untracked, template,
    cleanup, at, checked_at, step: null}`.

Every step keeps the working tree, or refuses, or is a Git command that refuses to overwrite, after
step 2 made sure nothing sits where the job adds a file. An undo that fails is
`handover_interrupted` (`needs_human`), naming where the branch, the saved ref and the worktree are;
the record keeps its step, so `recover()` repairs it when `sf serve` starts. A checkout already on
the job's branch is refused (`handover_refused`).

**When it runs.** At the end of MR preparation when hand-over is on for the job's workspace: the job
goes from `preparing_mr` to `handed_over` with one notification. A refusal leaves it in
`ready_for_human_review` with the refusal as `handoff_skipped: {code, message}` (in the
notification, `sf status` and the board, next to Hand over to my checkout); it is cleared on a
hand-over and whenever the job leaves `ready_for_human_review`. By hand: `sf handover` from
`ready_for_human_review`; a refusal answers its code and leaves the job as it was.

**The sandbox's config lock** (SF-085). Claude Code's sandbox protects `.git/config` by binding an
empty, read-only `.git/config.lock` into every sandboxed command; it creates that file in the
checkout's Git directory (the one holding its config, shared by the job's worktrees) and never
removes it, so Git refuses every config write there afterwards: the hand-over's `commit.template`
and `commit.cleanup`, and the user's own `git config`. The factory takes the lock for the sandbox's
leftover only when it is a regular file, empty, without any write permission bit, and open in no
process (no `/proc/*/fd` link to it; on other platforms than Linux, never). That check fails
closed: without a readable `/proc`, or when the descriptors of a process of the factory's user or
of the lock's owner cannot be read (for any reason but the process having ended), the lock counts
as open. Processes of other users are skipped: an unprivileged user can never read their
descriptors, and neither the sandbox nor Git runs as them. It removes such a lock,
under the workspace's Git lock, after every Implementer turn, Claude review, gate run and
simplification pass of a job, after a job's session is stopped (abort, pause, restart, reset),
after the last running Task check of the workspace in `sf serve` ends and after `sf check-task`,
and right before a hand-over or Take it back, but only while no other job of the workspace is in
`working`, `awaiting_review` or `preparing_mr` (the states in which its Implementer turns and
reviewers run: their sandboxes may be using it; the open-file check does not see the sandbox's bind
mount). Each removal is the event `sandbox_lock_removed {path}` in the job's log (after a Task
check, the ticket's job's, if it has one). When a hand-over meets such a lock while another job
runs, it is refused before anything changes with `config_locked` ("Another job of this workspace is
running; the hand-over runs when it ends."), which becomes the job's `handoff_skipped` (for `sf
handover` too); Take it back is refused with `config_locked` as well. `sf serve` hands a job waiting
with `config_locked` over by itself when the last job of its workspace leaves those three states
(a move from one of them to another does not count; and at its start, when none runs); a refusal then becomes the job's
`handoff_skipped`, and the job stays where it is, so the retry cannot repeat itself. A lock that is
not the sandbox's leftover (not empty, writable, or open) is never touched: the hand-over refuses
with `handover_failed` and Git's message ("could not lock config file ... File exists").

**Per workspace** (SF-083). A workspace's `handoff` in `workspaces.json` (`"checkout"` or `"off"`;
`sf workspace add --handoff`, the dashboard's workspace form) wins over `SF_HANDOFF` for its jobs;
without it `SF_HANDOFF` applies (default `checkout`). The registry is read when the job is ready, so
an edit applies to running jobs too. Hand-over off leaves the job in `ready_for_human_review` with
`handoff_skipped` code `handoff_off`, whose message names the setting that decided: "hand-over off
for this workspace (handoff "off" in workspaces.json)" or "hand-over off (SF_HANDOFF=off)".
`sf status` and the board show it; the notification leaves it out (a setting is not news) and keeps
the MR title and the file lines. `sf handover` still hands the job over by hand. Use `off` for a
workspace whose checkout must not be switched to every job's branch, such as the factory's own,
where a coordinating session opens and merges the merge requests with `sf mr create` and
`sf mr merge`.

**The state `handed_over`** does not count as running for the run queue (nothing of the job runs) but is not
terminal: no new job of the ticket starts. It goes to `working` (Ask for changes),
`ready_for_human_review` (Take it back), `pushed` (Approve, `sf mr create`, the user's push found,
`sf handed-done`) and `aborted` (`sf abort` without `--discard`: the config is restored, the
checkout and the branch stay as they are). `sf fix`, `sf abort --discard`, `sf reset` and `sf
restart` are refused with `handed_over` ("<ticket> is in your checkout on <branch>; take it back
first."); `mark_clean`, `sf pause` and `sf resume` with `invalid_state`. Every way out puts
`commit.template` and `commit.cleanup` back to what they were (unset when they were unset), only
while they still hold the factory's values. The prefilled message file goes when the job is pushed.

**Ask for changes** (`sf say` on a handed-over job; the board's Send button reads Ask for changes):
the user's own, so never held by the run queue's limit (SF-071); refused with `checkout_moved` ("Your checkout is not on
<branch>; switch back to it, or use Take it back.") when the checkout is on another branch; nothing
changes then. In the job's runner, under the Git lock, before the turn: a snapshot of the checkout
(a temporary index: `HEAD`, every change, every untracked file that is not ignored, without the
user's own files from before and without new files under `.software-factory/`) becomes the commit
`refs/factory/<ticket>-ask` on the branch's tip; a second snapshot that differs is
`checkout_changing` (try again). Then `git switch --discard-changes` back to what the checkout was
on (everything it discards is in the snapshot), and the untracked files the switch left are
deleted, each only while its content is its blob in the snapshot (a changed one stays and is named
in the event log), so the checkout is clean and the next hand-over finds nothing in the way. The
branch moves to the snapshot, the worktree is added on it and reset to B, so the user's edits and
commits are uncommitted changes there; the config is restored, `prepared_commit` dropped, and the
Implementer gets the message. The next ready hands over again with the same rules.

**Take it back** (`sf takeback`, to `ready_for_human_review`, which does not count as running): refused with
`takeback_changed` ("Your checkout changed since the hand-over: <files>. Use Ask for changes to
send your edits to the job, or undo them.") unless the checkout is on the branch at B and its
snapshot is S, and with `handover_refused` when an ignored file, one of the user's own untracked
files from before or a Task file sits where the switch back would write (as at Ask for changes).
Then `git reset -q --mixed S`, `git switch` back, the config restored, the worktree
on the branch again, and the job in `ready_for_human_review` with `prepared_commit` S. A switch
back that fails is undone and refused with `takeback_switch_failed`: the checkout and the branch
are as before.

**Approve on a handed-over job** (`sf approve`, the board's Approve, `sf mr create`) reads the
branch's tip T in the checkout: T is B (the user did not commit): `git push origin
refs/factory/<ticket>:refs/heads/<branch>`, then the branch moves to S in the checkout (only while
it is still at B), so the IDE shows only the user's own edits: "Pushed the factory's commit <S>."
plus "Your uncommitted changes (<n> files) were not pushed." when there are some. T descends from
B: the branch is pushed as it is, "Pushed your commit <T> (<subject>)."; `--as-is` is not needed.
Otherwise `branch_changed` ("The tip of <branch> does not descend from the job's base <B>; push it
yourself or take it back."). A failed push keeps the job `handed_over` with `error` set and changes
nothing else; Approve again, push from the IDE, or take it back.

**The user's own push.** The board's job detail asks origin, without waiting and at most once a
minute (`handover.checked_at`), `git ls-remote origin refs/heads/<branch>` (20 s). A commit R there
that is known locally, is not B and descends from B moves the job to `pushed` with
`prepared_commit` R and the event `handover_pushed {commit, same_tree}` (whether R's tree is S's).
Errors change nothing and are logged. `sf handed-done` (I opened the MR myself) runs the same
check on demand: `not_pushed` ("The branch <branch> is not on origin with your changes; push it
first.") when the branch is missing, at B or not descending from B; a commit not known locally
still counts (`same_tree: null`).

**Interrupted** (`recover()` when `sf serve` starts, for a job with `handover.step` set and no
live runner): `handing_over` is undone when it is safe (the checkout on the branch with exactly S,
or still on what it was on); the job goes to `ready_for_human_review` with `handoff_skipped`
`handover_interrupted` and its worktree on the branch; otherwise nothing in the checkout changes
and the job is `needs_human` with `handover_interrupted`. `asking` is finished from the snapshot
without the turn: `needs_human` with `ask_interrupted` ("sf serve restarted during Ask for changes;
your edits are in the job's worktree; use sf say to go on."). Take it back, I opened the MR myself,
the push check and abort of a handed-over job wait for the job's runner like approve
(`runner_active`).

**No turn while the checkout holds the branch.** Before every Implementer turn (`sf say`, a Fix
section, Clean) the factory checks that the user's checkout is not on the job's branch and that the
job's worktree is on it; a detached worktree (a hand-over cut off, a worktree that could not be
removed) is switched back to the branch, which Git refuses while another checkout has it. Otherwise
the turn is refused with `branch_in_checkout` and nothing changes: switch the checkout to another
branch, then try again.

**Saved refs.** `refs/factory/<ticket>` and `refs/factory/<ticket>-ask` are deleted when `sf serve`
starts, once their job is `pushed` or `aborted` for more than 7 days, or when no job of that ticket
exists.

| Code | Meaning |
|---|---|
| `checkout_dirty` | the checkout has changes to tracked files |
| `checkout_busy` | a rebase, merge, cherry-pick or revert is in progress in the checkout |
| `handover_refused` | a file is in the way of the hand-over (or of the switch back at Ask for changes), or Git refused the switch |
| `handover_mismatch` | after the hand-over the checkout did not hold the job's commit; it was put back |
| `handover_failed` | a Git command of the hand-over failed (Git's message), such as a config lock that is not the sandbox's leftover |
| `config_locked` | the sandbox's leftover config lock is in the checkout while another job of the workspace runs; the hand-over runs when it ends (SF-085) |
| `checkout_changing` | a file changed during Ask for changes; try again |
| `checkout_moved` | the checkout is not on the job's branch |
| `takeback_changed` | the checkout changed since the hand-over |
| `takeback_switch_failed` | the switch back failed; the checkout is as before |
| `not_pushed` | origin does not have the branch with the user's changes |
| `handed_over` | the job is in the user's checkout; take it back first |
| `handover_interrupted` | a hand-over was cut off or could not be undone |
| `ask_interrupted` | an Ask for changes was cut off; the edits are in the worktree |
| `branch_in_checkout` | a turn was refused: the job's branch is checked out in the user's checkout, or its worktree cannot be put back on the branch |

## Notifications

On `ready_for_human_review`, `handed_over`, `needs_human`, `paused`, `pushed` and `failed` (iterations are silent unless
`SF_NOTIFY_ITERATIONS=on`, which adds `awaiting_review` with `Priority: default`, `Tags: eyes` and
the body "Report and Patch of iteration N are ready for the reviewers") the
factory sends a desktop notification (`notify-send --app-name="Software Factory" "<ticket>:
<state>" <body>`, 5 s, when `notify-send` is on `PATH`) and, with `SF_NTFY_URL` set, one ntfy POST
(10 s; headers `Title`, `Priority` high for `needs_human` and `failed`, `Tags`). The body has at most
three lines: the branch, the error, or the MR title and link when pushed, and the marked paths of
the iteration on one line. Once the factory opens
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
jobs/<workspace>/<ticket>/job.json       # workspace, ticket, branch, base, base_commit, target_commit, worktree, prepared_commit, mr_attempts, state, iteration, fixes, gate_fixes, gate_tokens, simplify_iteration (SF-055, absent until the simplification pass starts), session_id, created_at, updated_at, error, mr ({host, number, url, state, merge_commit?} or null)
jobs/<workspace>/<ticket>/events.jsonl   # {ts, iteration, message | prompt | state | type: "notify_failed" | "review" | "review_failed" | "review_message" | "gate_event" | "gate_overridden" | "simplify" | "simplify_chosen" | "merge_request" | "mr_edited" | ...}; what sf watch reads
jobs/<workspace>/<ticket>/iterations/NNN/{report.md,patch.diff,meta.json,review.json,gate.json,gate-override.json,simplify.json,gate-schema.json,gate-output.json,conflict-resolution.diff}
jobs/<workspace>/<ticket>/ledger.json    # the findings ledger (SF-052): one entry per review item of a Fix section, from the first one on
worktrees/<workspace>/<ticket>/          # the job's worktree (SF_WORKTREE_ROOT), from start to Clean, abort or reset
jobs/<workspace>/<ticket>/mr.md              # the MR text, once the branch is ready or after a conflict iteration
jobs/<workspace>/<ticket>/mr-factory.md      # the factory's MR text, once the user saved their own (SF-080)
jobs/<workspace>/<ticket>/runner.pid     # the pid of the job's runner (sf run) while it runs (SF-042)
jobs/<workspace>/<ticket>/queue/, replies/   # sf serve's requests to the runner, one JSON file each, and the runner's answers
jobs/<workspace>/<ticket>/runner.log     # the output of the job's runners
locks/git-<workspace>.lock               # held during a Git operation on the workspace's checkout, by sf serve or a runner
jobs/<workspace>/<ticket>.<timestamp>/   # an archived earlier job
```

`iteration` in `job.json` counts published iterations; `updated_at` is the time of the last state
change (`since` in `check` and `SINCE` in `sf status`).

Every stored time is ISO 8601 UTC with `Z`. What the factory shows is local time (SF-049):
`sf watch` and `SINCE` in `sf status` in the zone the `sf` process runs in (`TZ`), the dashboard
in the browser's (`YYYY-MM-DD HH:MM:SS`, the stored UTC value on hover; `HH:MM` in the Stream).

## Run queue

SF-071. The planned tickets of every workspace form one **run queue**: an order of what runs next,
a limit `max_running` of the jobs that run at once (1-20, every workspace together; default
`SF_MAX_JOBS`, 3), and `sf serve` starting the next queued ticket by itself when a slot is free.
It lives in `<state dir>/queue.json` (written atomically): `{"version": 1, "max_running": N,
"held": false, "hold_reason": null, "entries": [{workspace, ticket, queued_at}], "errors":
[{workspace, ticket, code, message, at}]}`. A missing file is an empty queue; an invalid one stops
`sf serve` at its start (`queue_invalid`), as an invalid registry does.

- **Running** is `starting`, `working`, `awaiting_review` or `preparing_mr` (`RUNNING_STATES` in
  `src/jobs.ts`), whoever started the job. A paused job and the jobs that wait for the user
  (`needs_human`, `ready_for_human_review`, `handed_over`) do not count.
- **The limit gates only the queue's own starts.** A start by hand (the board's Start, `sf start`),
  a restart, a resume, an Ask for changes and a take back always go; their jobs count when the
  queue decides whether a slot is free. The user's answer to a job that waits (`sf say`, a Fix,
  `sf settle`, `sf accept`) is not a start either and may take the count above the limit for a
  while; the queue then starts nothing until it is below again. Lowering the limit stops no job.
- **The scheduler** (`RunQueue` in `src/queue.ts`) runs a pass after the recovery at `sf serve`'s
  start, on every job state change (`sf serve`'s own and the ones the runners write to disk, as a
  job reaching `ready_for_human_review`), on every queue, limit or hold change, and every 5 minutes
  while a slot is free and a queued ticket waits for a dependency. Passes and changes run one at a
  time. A pass, unless the queue is held: the entries whose Task file is gone (deleted or archived)
  or whose ticket has a live job (started by hand) leave the queue without an error; then, while
  fewer than `max_running` jobs run, the first entry whose `lands_after` tickets are all **merged**
  leaves `queue.json` (written before the start) and starts (`Execution.start` with `queued`,
  which checks the count again under the Execution's lock: `job_limit`, "N jobs run (SF-1 working,
  …); the limit is M."). The ticket leaves the queue before its start and a second job of a ticket
  is refused (`job_exists`), so the queue never starts a ticket twice, across concurrent events and
  restarts alike; `sf serve` stopping between the two leaves the ticket out of the queue without a
  job. A start refused with `job_limit` (a start by hand took the slot) puts the entry back where it
  was and ends the pass; any other refusal (`task_draft`, `invalid_content`, `branch_exists`, …)
  leaves the ticket out of the queue with `{code, message, at}` in `errors`, shown on its card as
  "Start failed: <message>"; adding it again clears it.
- **`lands_after`** (SF-084's Task file key, `<ticket>` or `<workspace>/<ticket>`): an entry starts
  only when every ticket it names is `merged` by SF-084's rule (section Dashboard, Dependencies);
  `pushed`, `running`, `planned` and `missing` keep it in place and the next entry is tried. That
  rule reads `origin/<base>` without fetching, so before it decides that an entry still waits (a
  slot free), the queue fetches the dependency's base (`Execution.fetchBase`: `git fetch
  --no-recurse-submodules origin <base>` in the workspace's checkout under its Git lock, once per
  workspace and base in a pass) and asks again past the 30 s cache (`Setup.dependencyStates(refs,
  {fresh: true})`); a failed fetch leaves the state as it was.
- **Changes**: `sf queue add <ws> <ticket> [--at N]` (refused: `task_not_found`, `task_draft` for a
  skeleton, `job_exists` for a ticket with a live job, `already_queued`; N beyond the end is the
  end), `sf queue remove` and `sf queue move <ws> <ticket> <N>` (`not_queued` for a ticket not
  queued), `sf queue limit <N>` (`invalid_limit` outside 1-20), `sf queue hold [reason…]` and
  `sf queue release` (the hold and its reason survive a restart); `sf queue list` prints the limit,
  the running count, the hold, the next ticket to start, the entries with what each waits for, and
  the starts that failed. They go to `sf serve` over its socket, as `sf start` does. The board
  posts the same changes (`api/queue/*`, section Dashboard) and the Context owner has `queue_list`
  and `queue_add` (below); neither removes nor moves.
- **MCP tools** for the Context owner: `queue_list({})` returns `{max_running, running, held,
  entries: [{workspace, ticket, position, queued_at, waits_for}]}` (`waits_for`: the `lands_after`
  tickets not merged yet, `[{workspace, ticket, state}]`); `queue_add({workspace, ticket, at?})`
  returns `{position}`, with the refusals of `sf queue add`.

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

**The board (SF-046, v3 since SF-077).** The page is the board of the dashboard v3 design
(`docs/design/dashboard-v3/`, ported from its prototype: the same CSS, light and dark by the system,
the same markup and keys). The top bar has the title, "N wait for you · M running" (the page title
is `(N) Software Factory` while N > 0), the connection as a tag while the stream is not connected,
the workspace filter (*All workspaces*, then one chip per workspace with its colour dot and name:
a click keeps that workspace's cards and counts, a second click shows all again), *Archived* (with its count),
*Workspaces* and *New ticket*, and the run queue's controls (SF-071, section Run queue): "Run up
to [− N +] jobs at once" (the stepper posts `api/queue/limit`, off at 1 and 20 and while a change
is out) and the queue's status, "2 running · 1 slot free · next: SF-069" ("nothing ready" when no
entry can start) or, held, "Queue held: <reason> · 2 running" in the warning colour. The Rules menu
stays hidden until SF-072. Five columns, each heading with its count: **Queue** (the Task files of
every usable workspace whose ticket has no job, or whose last job is `failed` or `aborted`: first
the queued ones in the queue's order, each with its position, or "The queue is empty: add a ticket
below.", then a "Not queued" divider and the other planned tickets; the heading counts the queued
ones), **Implementing** (`starting`, `working`), **Reviewing** (`awaiting_review`, that is the
Claude review or the Codex gate, and `preparing_mr`), **Your turn** (`needs_human`,
`ready_for_human_review`, `handed_over`, `paused`) and **Done** (`pushed`, and `aborted` or `failed` when the
ticket has no Queue card; the most recent first; the last eight, then *Show all N*, which shows the
rest in place and becomes *Show the last 8*). A ticket shows in one column only (SF-057): a pushed
one only under Done, a failed or aborted one only in the Queue, one with an active job only in that
job's column. An empty column says so.

Each **card** has a 4 px stripe on its left in its workspace's colour (SF-084) and a first line
with the ticket key (never wrapped), the workspace chip (the colour dot and the workspace's name,
shortened in the middle when long, the full name as its title: the colour is never the only sign),
the stop code as a tag on a `needs_human` job, and the money at the right: the estimated cost
of its iterations and Claude reviews ("$1.23", not a charge) and the time since the job was
created, "so far" while it runs (`$1.23 so far · 14 min`; only the time while there is no cost
yet), or the time it took (`$1.23 · 1 h 4 min`); then the title of its Task file (the branch
without one). A card never grows wider than its column: long text wraps or is cut with an ellipsis
and its full text as the title. A **running** card (`starting`,
`working`, `awaiting_review`, `preparing_mr`) says who acts now and what: "Now: Implementer" with
its last tool call (`Read factory/src/jobs.ts`) or the first line of its last text, "Now: Claude
review" or "Now: Codex gate" reviewing iteration N, "Now: MR writer" writing the MR text, and the
iteration with the Implementer's tool calls. While a card runs and the page is visible, the page
reads `api/jobs` again every 15 s so this line and the time move; nothing else is polled, and the
board is drawn again every minute for the other cards' times. A **Your turn** card carries the one
primary button of the board: on `needs_human` the reason in plain words and the button of the stop
table below (it opens the job's page at the stop, *Retry review* is sent at once, *Push again*
opens the Approve confirmation), with *Create merge request…* beside it when the branch is
prepared; on `ready_for_human_review` "Ready to push: reviews clean, MR text written" with *Review
the MR and push* (the job's page with the Approve confirmation open) and *Create merge request…*,
and the reason when the automatic hand-over was refused (SF-073); on `handed_over` "In your
checkout on <branch>" with the same buttons; on `paused` "Paused by you" with *Resume* (sent at once; SF-067: "Task file changed since the job
started" when it did). The job's last outcome shows under them. A **Done** card says "Pushed · 2
iterations · 14:05" (Aborted, Failed); a pushed one keeps its merge request (`#N state` with the
link), *Create merge request…* or *Merge…* and, while its Task file is active, *Archive ticket*;
an aborted or failed one has no button (its page has Restart and Archive). SF-069's line about a
turn that went on by itself after the turn limit stays on the card. The iteration is numbered from
1 and is the same on the card and on the job's page: the one under way while the Implementer works
on it (`starting`, `working`, paused in its turn, stopped by its session), else the last one
published.

A **Queue card** shows the ticket key, the workspace chip, the mark of its last job (`last job
failed`, a button that opens that job's page), the Task check's chip at the right (`checking…`,
`check: ready`, `not ready: 1 blocker, 2 major`, `check failed`, each with ` · stale` when the Task
file changed since, `not checked`, or `draft` for a skeleton; a click opens the planned ticket with
the check's findings; on a card too narrow for it, it moves to its own line under the title) and
the title, "Start failed: <message>" when the queue's start of it failed (SF-071), then **Start** (an outline button, as every Queue button: the only solid ones on the
board are Your turn's) or "waiting for the plan" for a skeleton, **Add to queue** or **Remove from
queue** (SF-071; not on a skeleton), **Task**, and **⋯**, a menu with
**Check** (section Task check), Archive and Delete… (Escape or a click elsewhere closes it). A
click on the card (or on **Task**, or on the check's chip) opens the planned ticket's page (below).
A queued card is dragged to its new place (a drop on another queued card puts it before that one)
or moved one place with Alt+Up and Alt+Down while focused (the hint "⠿ drag · Alt+↑↓"); each posts
`api/queue/move` and the board shows the queue as the server sends it back.

**Dependencies** (SF-084). A Task file's `lands_after: [<ticket>, <workspace>/<ticket>]` names
the tickets it waits for. While one of them is not merged, the Queue card has a line **Waits for**
with a chip per ticket: its key and its state, ✓ merged (the success colour), ⧗ pushed, running or
planned (the warning colour), ✗ missing (the error colour), the state in words as the chip's
title; Start's title then says "Waits for <keys>" (Start by hand still starts it; the run queue
starts it only once all are merged). A
card whose dependencies are all merged shows nothing more. The card of a ticket others wait for
(in any column) has **Needed by** with their keys. Hovering or focusing a card outlines its
dependencies and dependents in the accent colour and dims the other cards; leaving the card, or
Escape, clears it. A chip's click scrolls to that card and focuses it (lifting a workspace filter
or Done's limit that hides it; a ticket without a card says so in the toast). A cycle (A waits for
B, B for A, at any length) shows on each of its cards as "Dependency cycle: A → B → A" in the error
colour. The job page header shows the workspace chip, Waits for and Needed by the same way. The
state is the server's, one rule, worked out when the tickets payload is built: **merged** when the
ticket's last job (live or archived) is `pushed` and its merge request is recorded `merged`, or,
only when no merge request state is recorded, its branch tip (origin's branch, else the prepared
commit, else the local branch) is an ancestor
of `origin/<base>` in the workspace's checkout (`git merge-base --is-ancestor`, no fetch; the
answer kept 30 s per ticket; a merge request recorded `open` or `closed` is not merged: run `sf mr
status` to record a merge done on the host); **pushed** when pushed but not merged by that rule (its Task file active, or none); **running**
while it has a live job in any other state; **planned** with a Task file (active, or archived with a
job not merged, a pushed one included) and no live job; **missing** otherwise. `api/tickets` (and the stream's `tickets`
event) gives each ticket `lands_after: [{workspace, ticket, state}]` and, for the tickets with a
live job, `job_lands_after: [{workspace, ticket, lands_after}]`.

**Workspace colours** (SF-084). Each workspace has a colour of the palette blue, teal, green,
olive, orange, red, purple and grey (`--ws-<name>` in `static/app.css`, a light and a dark value,
each at least 4:1 against the page's backgrounds): its `color` in `workspaces.json`, else the
entry at (the sum of the UTF-16 code units of its name) mod 8. `api/workspaces` gives each
workspace's `color`; the page only reads it. Start asks first,
naming the workspace, the ticket and the base branch (and the Task check's note: not checked,
stale, check failed or not ready: N blocker, M major), then sends `POST
api/tickets/<ws>/<ticket>/start` once: `Execution.start`, the same call as `sf start`, with its
refusals (`task_draft`, `job_exists`, `branch_exists`, `checkout_dirty`, ...; never the run limit) shown
as they come; the job's card appears under Implementing from the stream. An answer that does not
settle the outcome (no answer, a body cut after the headers, a 2xx without a result, a 5xx without
a factory code) is an unknown outcome: nothing is re-sent, and Start stays off for that ticket
until `api/jobs` is read again (at once; when that read fails, until the stream's next `jobs`
event), with a message saying to check the board before starting again. The board follows the
stream's `jobs`, `tickets` and `workspaces` events: a card moves column when its job changes state.
On a phone-wide window (below 760 px) the columns stack with Your turn first, then Implementing
and Reviewing.

**The stop table.** A stop is a **decision** (the factory needs the user's choice; nothing failed:
never red, never "Stopped") or an **error** (its reason in red). The card shows the reason and the
button; the job's page (SF-078) says the sentence in its header, its stop block and its composer;
one table, `STOPS` in `static/app.js`:

| Code | Kind | Reason on the card | Button |
|---|---|---|---|
| `simplify_offered` | decision | Simplification offered | Simplify or skip |
| `escalated` | decision | Question for you | Answer N questions |
| `review_disputed` | decision | A reviewer disputes a contest | Settle N findings |
| `review_churn` | decision | Fixes keep making findings | Decide N findings |
| `gate_rounds` | decision | Codex round limit reached | Decide N findings |
| `gate_budget` | decision | Codex token budget used up | Decide |
| `iteration_limit` | decision | Fix round limit reached | Give a direction |
| `max_turns` | decision | Turn limit reached | Tell it to go on |
| `gate_failed` | error | Codex gate gave no verdict | Decide |
| `review_failed` | error | Claude review could not run | Retry review |
| `serve_restarted` | error | Interrupted by a restart | Tell it to go on |
| `mr_serve_restarted`, `mr_interrupted` | error | MR preparation interrupted | Tell it to go on |
| `session_failed` with the usage-limit message | error | Usage limit reached | Tell it to go on |
| `session_failed`, `turn_failed`, `permission_mode_mismatch` | error | Implementer session failed | Tell it to go on |
| `sandbox_unavailable` | error | Sandbox unavailable | Tell it to go on |
| `publish_failed` | error | Iteration not published | Tell it to go on |
| `mr_conflict` | error | Rebase conflict | Tell it how |
| `mr_text_missing`, `mr_text_invalid` | error | MR text missing or invalid | Tell it to fix it |
| `mr_empty` | error | Nothing to commit | Tell it what is missing |
| `mr_commit_failed`, `mr_rebase_failed`, `mr_failed` | error | MR preparation failed | Tell it to go on |
| `worktree_remove_failed` | error | Worktree not removed | Tell it to go on |
| `mr_push_failed` | error | Push failed | Push again |
| `mr_push_protected` | error | Push refused | Open the job |
| any other code | error | Stopped | Open the job |

N is the number of findings or suggestions the job waits on (`stop` of `api/jobs`); the card's
second line says "N findings to decide", or "stopped at HH:MM" when there is none.

On the job's page each stop says in its block what it waits on, and its composer offers what moves
it on, the first one primary (every action is the API route the page already had, with its
confirmation where it has one; *Tell it to go on* is a message, "Go on." when the box is empty):

| Code | The stop block shows | The composer's actions |
|---|---|---|
| `simplify_offered` | each suggestion: its path, what, why and the lines it saves | Simplify, Skip (Accept and prepare MR without them: they are listed in the MR text), Send, Abort… |
| `escalated` | each escalated finding with the Implementer's question, a note and *Accept risk* / *Must fix* (sent at once) | Send, Abort… |
| `review_disputed` | each contested finding with the contest, its evidence and the reviewer's reason, a note and *Accept risk* / *Must fix* | Accept and prepare MR (with a clean Claude review), Send, Abort… |
| `review_churn` | the open findings of the ledger (*Accept risk* / *Must fix* on those to settle) | Accept and prepare MR (with a clean Claude review), Send, Abort… |
| `gate_rounds` | the last gate's findings (nothing to settle one by one: the API settles only escalated and contested ones) | Accept and prepare MR (with a clean Claude review), Send, Abort… |
| `gate_budget` | the gate's tokens used | Accept and prepare MR (with a clean Claude review), Send, Abort… |
| `iteration_limit` | the last verdicts' findings | Send, Restart…, Abort… |
| `max_turns` | nothing | Tell it to go on, Abort… |
| `gate_failed` | the gate's error | Accept and prepare MR (with a clean Claude review), Tell it to go on, Abort… |
| `review_failed` | the review's error | Retry review, Abort… |
| `serve_restarted` | nothing | Tell it to go on, Restart…, Abort… |
| `mr_serve_restarted`, `mr_interrupted`, `publish_failed` | nothing | Tell it to go on, Abort… |
| `session_failed` with the usage-limit message, `sandbox_unavailable` | the message | Tell it to go on, Abort… |
| `session_failed`, `turn_failed`, `permission_mode_mismatch` | the whole message | Tell it to go on, Restart…, Abort… |
| `mr_conflict` | the conflicting files | Tell it how (Send), Abort… |
| `mr_text_missing`, `mr_text_invalid` | the rule it breaks | Send, Abort… |
| `mr_empty` | nothing | Send, Abort… |
| `mr_commit_failed`, `mr_rebase_failed`, `mr_failed` | the whole message | Tell it to go on, Abort… |
| `worktree_remove_failed` | the worktree's path | Tell it to go on, Abort… |
| `mr_push_failed` | the whole message | Push again (Approve, its confirmation), Abort… |
| `mr_push_protected` | nothing | the Merge request screen (rename the branch, change the base, SF-080), then Approve; Abort… |
| any other code | the whole message | Send, Abort… |

A settled finding shows its decision ("Accepted risk", "Must fix") instead of the buttons.

**Full pages.** One view shows at a time: the board, a job's page or a planned ticket's page; the
URL hash says which, and the browser's Back and Forward move between them: `#<workspace>/<ticket>`
is the job's page on its Stream (today's job links keep working), `#<workspace>/<ticket>/changes`
and `/mr` the same page on its Changes or Merge request screen, and `#<workspace>/<ticket>/ticket`
the planned ticket's page (SF-081, below). A hash for a job or
ticket the board does not have shows the board. A click on a job card opens its page (below); the
stream follows that job. A job that leaves the board (its ticket archived or deleted) goes back to
the board. **Keys** on the board: `j` and `k` move between the cards, Enter opens the focused card;
on a job's page `s`, `c` and `m` switch to the Stream, Changes and Merge request, and on the Stream
`j` and `k` select an entry, `G` the last one and Enter opens or closes the selected one;
Ctrl+Enter in the message box sends it; Escape closes an open confirmation, then goes back one
level (Changes or Merge request to the job's Stream, the Stream or a planned ticket to the board)
and the focus returns to the card that opened it. Alt+Up and Alt+Down move the focused queued card
one place (SF-071).

**The planned ticket page** (SF-081). A planned ticket opens as a full page with everything about
its planning, read from `GET api/tickets/<ws>/<ticket>/page` (the tickets row with its
conversation, `task: {text, sha256}`, `plan: {starts_from, files: [{path, sensitive}], scoped,
waits_for: [{ticket, state, merged}]}`, `check` (the Task check's view, `null` without the Task
checks), `history: [{ts, kind, by, text}]` and `queue: null` (SF-071 leaves the queue out of this page); a ticket that is not in
the tickets list is an empty 404, and the page goes back to the board). The header has *← Board*
(Escape), the key, the workspace, the title and `draft` for a skeleton; *Open the ChatGPT
conversation ↗* (the server's link only), **Check the plan** (*Check again* after a check,
*Checking…* while one runs; today's `POST api/tickets/<ws>/<ticket>/check`) and **Start now**; its
line says "waits for …" while a dependency is not merged, "Starts from <branch>" and the plan check
in words. On the left the **Task file** (`.software-factory/<ticket>.md`): *Preview* (the default)
renders the body without the front matter as Markdown (headings, lists and task lists, code
fences, tables, `code`, bold, italic; DOM nodes, never HTML from the file, links only to http(s)
URLs), *Edit* is the whole file, front matter included, with *Unsaved changes* and **Save**
(Ctrl+S while editing). "edited by you" marks a file saved from the page.

On the right the plan in plain words, read-only (the front matter is changed in the Task file
itself), each card with a short help line:

| Card | Front-matter key | What it means |
| --- | --- | --- |
| **Starts from** | `base` | The branch the job's branch is created from; a feature branch when the ticket needs work that is not merged yet. |
| **Files it will change** | `scope` and `may_touch`, in one list | The files the job is expected to create, change or delete (one path or pattern per row). A change outside the list needs your OK before it can ship. 🔒 marks a `may_touch` entry: a sensitive file (build, CI, packages, credentials) the ticket may change on purpose. Without `scope`: "No list: the job may change any file, and nothing is checked." |
| **Waits for** | `lands_after` | Each ticket with SF-084's state in words: ✓ merged, pushed, not merged yet, running, planned, not started, unknown ticket (another workspace's as `<workspace>/<ticket>`). Start now still starts it. |
| **Plan check** | (the Task check) | "Ready: …", "Not ready: N blockers, M majors." with the findings (their kind in words: needs a decision, contradicts itself, something is missing, does more than asked, unclear), what the checker understood and the files it expects to change; "Not checked yet.", "Checking…", "The plan changed after this check: check it again."; the date, the model and the cost. It only advises. |
| **Planning conversation** | | The link, the first message and its Copy. |
| **Images** | | The ticket's images (SF-064, section Ticket images): each opens whole in a new tab, with **Copy image** and ×; "Paste an image here (Ctrl+V) or drop one." |
| **History** | | What happened to the plan (below). |

The check is read again (`GET api/tickets/<ws>/<ticket>/check`) on every tickets refresh of the
stream, so a check that ends while the page is open shows at once. **Start now** asks with Start's
confirmation of the Queue card (the check's note too) and adds the dependencies not merged yet
("Waits for SF-071 (running), SF-072 (planned, not started): they are not merged yet."); it still
starts once confirmed, and the page moves to the new job's Stream.

**Save** posts `{"content": string, "sha256": string}` to `POST api/tickets/<ws>/<ticket>/task`:
the whole file and the sha256 of the version the edit started from. It goes through the Task file
writer of `write_task` (`Setup.saveTask`, under the Execution's lock): the same validation
(front matter with `ticket`, `title` and `base`, at most 256 KB of UTF-8, `400 invalid_content`),
its refusal while a job of the ticket runs (`409 job_active`), and, inside the writer's one queue,
a check that the file on disk is still that version: another one (the Context owner's `write_task`
meanwhile, or a Fix section) is refused with `409 task_changed` and never overwritten; the page
keeps your text and offers **Reload**, which loads the file as it is (copy your changes first to
keep them). The route takes a body up to `2 × 256 KB + 1 KB` (above the 128 KB of the other
actions); a file of mostly non-ASCII or control characters can need more as JSON and is written
with `write_task` instead. A save makes the last plan check stale.

**History.** The factory records each write of a Task file in
`<state dir>/tickets/<workspace>/<ticket>/history.jsonl`, append-only, one line `{ts, kind, by,
sha256}` (the sha256 of the text written; a Fix section adds its number `fix`): `created` by `you`
(New ticket), `written` by `context_owner` (`write_task`), `edited` by `you` (Save on the page),
`fix_added` by `factory` (each `## Fix N`). The page's History merges them, newest first, with what
the state directory already has: every Task check (`<state dir>/checks/…`) and every job of the
ticket, current and archived (`<state dir>/jobs/<ws>/<ticket>/job.json` and
`<ticket>.<stamp>/job.json`): "Created by you", "Plan written by the Context owner (ChatGPT)",
"Edited by you", "Fix N added by the factory", "Checked: ready · $0.45", "Checked: not ready (2
blockers, 1 major) · $0.48", "Check failed · $0.12", "Started as a job (ended: pushed)". When the
Task file is not the version the last recorded write left, it says "Changed outside the factory"
with the file's modification time. A ticket that may be older than the recording says once
"Recorded since SF-081; earlier steps are known only from checks and jobs.": nothing recorded, a
first record that is not `created` (a Task file written before SF-081 and first rewritten, saved or
fixed since; a ticket the Context owner creates with `write_task` alone is marked too, as its line
cannot tell them apart), or checks and jobs before the first record. Deleting a ticket keeps its history file, as the state directory keeps its
jobs.

**Messages.** The board's messages (a start, a check, an archive, a restore or a delete, and their
refusals), and a short word for an action of the job's page that succeeded, show in one toast at
the top: an ok message goes after 6 s (not while the pointer is on
it), an error stays until closed; × and Escape close it; a new message replaces the old one. The
messages of a form in the drawer stay under the form.

**The drawer.** The drawer on the right is left for **Workspaces**, **New ticket**, **Archived**
and an archived ticket's Task (the whole width on a phone); ✕, a click beside it or Escape closes it.
**Workspaces** lists the registry (name, path, live jobs, a
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
conversation. Images pasted or dropped into the form are uploaded after the ticket is created
(SF-064, section Ticket images). An existing Task file is never replaced from the page (`409 ticket_exists`). Once
the ticket is created the dialog closes and the board scrolls to the new Queue card and highlights
it (a click on it opens its page); a refusal keeps the dialog open with the error and the input.
Nothing opens the ChatGPT tab by itself. **Archived** (with the count) lists the archived tickets
with Task (the archived text), Restore and Delete…; Archive, Restore and Delete… are described
under SF-027 (a finished job of the ticket leaves the board with them). The archived Task drawer
shows the file (`GET api/tickets/<ws>/<ticket>/task?archived=1`) as text: one line per line,
Markdown headings bold by a line rule, never HTML from the file. With no workspace, or no ticket
and no job, a line above the board says where to begin.

The ticket's **conversation** on its page: *Open the ChatGPT conversation ↗*, a link
(`target=_blank`, opened only by the user's click) to `https://chatgpt.com/?q=` plus the message of
`ticketConversation` URL-encoded, and the first message with Copy. The message names the connector, `guide`, the
ticket and the workspace, carries the user's words, and tells the Context owner to investigate
(`read_file`, `search`), discuss, write the Task file over the skeleton with `write_task` with a
`## Review brief`, and then tell the user it is ready: it only plans and never starts, reviews or
approves a job; the user reads the Task file and presses Start. A ticket with images gets the
sentence of section Ticket images before the last one. A message too long for a link
(over 7500 characters of URL) has no link: the page offers it to copy.
Whether ChatGPT sends a prefilled message by itself is up to ChatGPT, so the page says to press
Enter if it is not. Only the server's ChatGPT URL becomes a link. A change made with `sf workspace
add|remove` or `write_task` shows at the next refresh of the stream (a state change, an action
from a page, or a reload). The ChatGPT reviewer of SF-031 to SF-035 is gone with its back end
(SF-040): there is no Reviewer line, no "Set up the reviewer in ChatGPT", no Nudge, no Send test
event and no Subscriptions.

**The job's page (SF-078).** A job opens as a full page, the prototype's (`docs/design/dashboard-v3/`):
a header, then the Stream with the composer pinned at the bottom.

- **Header**: *← Board* (Escape), the key, the title and, while the job waits on a stop, its code
  as a tag; the switch **Stream** (`s`), **Changes (N)** (`c`; N is the `files` of `api/jobs`, left
  out when it is not a number) and **Merge request** (`m`; off with "No MR text yet: written at
  Clean" until the MR text is written); then the sentence with the state's dot, "Iteration N" (with
  "(running)" while the Implementer works on it; numbered as on the card), "$X so far (Claude,
  est.)" ("$X (Claude, est.)" once it stopped running), "N min elapsed" (since the job's start: to
  now while it runs, to its last update otherwise) and the branch, a button that copies `git
  checkout <branch>` (or shows it selected for Ctrl+C when the browser refuses). The sentence: for
  a stop, the stop table's; else "The Implementer is working on iteration N", "Claude and Codex are
  reviewing iteration N", "Writing the MR text", "Reviews are clean and the MR text is written.
  Push when you are happy", "Pushed at 14:05", "Aborted by you. The branch stays"; for a paused job
  "Paused by you during iteration N" and what Resume and Restart do.
- **Stream**: one chronological list of the job, from SF-082's entries: the page reads
  `api/jobs/<ws>/<ticket>/stream?from=0`, then each `next` until `end`, and then follows the
  stream's `entries` events from the last `next`; a reconnect resumes at the next line to read, and
  an entry already shown is never shown twice. A separator comes before each prompt ("Iteration N",
  with the *Fix N* tag, or "MR preparation"). Each entry has its local time, who (Implementer,
  Claude review, Codex gate, MR writer, Factory, You, State; left out when the same author goes on)
  and its body: the Implementer's text (clamped at 8 lines with *Show all N lines*); each tool call
  as one line, its result after it (`Bash npm test → 12 lines`, red when it failed; a click or
  Enter shows its Input and Output; a result joins its call by id, across pages and live, and one
  whose call the page has not seen is dropped); the end of a turn; the user's messages; the
  prompts (*prompt* shows the text; the implement prompt's *Task* shows the Task file and its last
  Task check; the turn limit's continuation as "Continue where you stopped."; "with the Task file's
  change" when the prompt carried one); each Fix section with its items as findings and *Show the
  full prompt*; the Claude review's and the Codex gate's verdicts (clean or asks for fixes, the
  count, the summary clamped with *Show the whole summary*, the findings with their ledger id or
  `#n`, severity, path, problem and what is expected); the state changes (`from → to`); the end of
  an iteration with its files, *Open these changes* (`c`) and its *Report*; the simplification
  pass's suggestions; the factory's notes. Every path is a link to Changes at that file and
  iteration. New entries are added at the end; the view follows them only when it was at the
  bottom.
- **The stop block**: the last `needs_human` state change, while the job waits on it: "Your
  decision" (a decision) or "Stopped" (an error, in red), the reason and the code, the sentence,
  and what the code needs (the second stop table above). An earlier stop stays in the Stream as a
  plain block with its message.
- **Composer**, at the bottom: the sentence in bold, the message box (with a hint per state; Enter
  adds a line, Ctrl+Enter or Send sends) and the actions that apply now, the primary first; one that
  is off says why in its title. `starting`, `working`, `awaiting_review`: Send, Pause, Abort…;
  `preparing_mr`: Abort… only (no message is taken while the MR text is written); `paused`: Resume
  (with the box's text when the Implementer's turn was paused), Restart…, Abort…;
  `ready_for_human_review`: *Review the MR and push* (primary, SF-080: it opens the Merge request
  screen), Approve…, *Hand over to my checkout* (SF-073; the composer
  says why the automatic hand-over did not happen, when it was refused), Create merge request (when
  it can be created), Send, Abort…; `handed_over` (SF-073): Approve… (primary), *Ask for changes*
  (the message, with the edits in the user's checkout), *I opened the MR myself*, *Take it back*,
  Create merge request, Abort…; `needs_human`: the stop table; `pushed`: no message box, the merge request (`#N`, its
  state and link) and its status last read, Create merge request (no merge request yet, or a closed
  one), Merge… (an open one), Refresh MR status (any) and Archive; `aborted`, `failed`: no message
  box, Restart… and Archive. A confirmation opens inline in the composer, before anything is sent;
  under it the outcome line and the warning of an unknown outcome, with *Refresh state* when the
  read after it failed.
- **Changes** (SF-079): the file tree on the left and the diff of the selected file on the right,
  as IntelliJ shows them; see Changes below.
- **Merge request** (SF-080): the branch, the base, the MR title and text, editable before the
  push, with the commit message, what the change carries and the checks; see Merge request screen
  below. Before Clean it says "No MR text yet: written at Clean, when both reviews pass." and the
  switch's tab is disabled (`m` says why).

The old job detail of SF-047 is gone: its pipeline, next-action panel, facts, state history and
Task, Reviews and Live log tabs are covered by the Stream (the state changes, the verdicts, the
prompts and the implement prompt's Task) and the composer.

The job's actions take the user's commands with the same meaning as in the terminal: approve (`sf
approve`, the push of the branch prepared at Clean, with an explicit "as it is" choice for a tip
edited by hand: `sf approve --as-is`), abort (`sf abort`, with an explicit discard choice that is
unchecked every time a confirmation opens: `sf abort --discard`), say (`sf say`: a multiline
message; Enter adds a line, Send or Ctrl+Enter sends; *Tell it to go on* sends the box's text, or
"Go on." when it is empty), Retry review (`sf review`, SF-044, sent at once without a
confirmation), Simplify and settle (SF-055, SF-052), Pause, Resume and Restart (SF-067) and Accept
and prepare MR (`sf accept`, SF-047: its confirmation
names the job and lists the Codex items that will not be applied, path and problem, or the gate's
error, so the user accepts them knowingly). The merge request (SF-048) has Create merge request
(`sf mr create`; its confirmation shows the title, the host and the target branch, and from
`ready_for_human_review` says the branch is pushed first), Merge (`sf mr merge`; its confirmation
names the number and the target branch) and Refresh MR status (`sf mr status`) in the composer,
with the merge request's link; the Your turn cards offer Create merge request… next to
their primary button, the Done cards of pushed jobs Create merge request… or Merge… and the link
(each opens the job's page with its confirmation). Without the
token for the workspace's host the buttons stay off and the reason names the missing variable.
Approve stays for users who open merge requests themselves. Each is one deliberate click;
approve (and Push again), abort, restart, accept (and Skip), Simplify, Create merge request and
Merge ask first, inline in the composer, with a confirmation that names the job, explains what
follows (the push; the session ends and the worktree stays, or the worktree and the branch go with
discard; MR preparation without the Codex items or the suggestions) and sends nothing when
cancelled; Send, Tell it to go on, Pause, Resume, Retry review, settle, Refresh MR status and
Archive go at once. The page enables
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
page says to check the state and the Stream, in a line of its own that a definite answer
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
were opened for: opening another job or leaving the job's page closes the confirmation and never
retargets a request, and an answer that arrives for another job changes nothing on the shown one
(it shows on that job's card and when it is opened again).

The page is plain HTML, CSS and JavaScript from `static/`, with no external resources, under
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self' blob:` (`blob:` for New ticket's thumbnails before upload, SF-064) and `Cache-Control: no-store`; every value is rendered as text.

Endpoints under `/d/<token>/`. The read endpoints are GET only (anything else `405` with
`Allow: GET`); the action endpoints are POST only (anything else `405` with `Allow: POST`; GET,
HEAD and OPTIONS never act); `api/workspaces` and `api/tickets` list on GET and act on POST
(anything else `405` with `Allow: GET, POST`):

| Path | Answer |
|---|---|
| `api/jobs` | `{jobs: [...]}`: workspace, ticket, branch, base, state, iteration, mr_attempts, fixes, gate_fixes, gate_tokens, updated_at, created_at, error, and for the board (SF-046) `title` (of the Task file, or `null`), `cost_usd` (the estimate of the iterations and their Claude reviews, or `null`), `review` and `gate` (the last iteration's verdicts: `clean`, `fix`, `failed` or `null`) and `review_ended_at` (the end of that clean or fix Claude review, or `null`); `mr` (the merge request on the Git host or `null`) and `mr_host` (`{host, reason}`: `github`, `gitlab` or `null`, and why the merge request actions are off or `null`); for the v3 card (SF-077) `now` (`{who, what, ts}` of a running job: the Implementer's last tool call or the first line of its last text, read from at most the last 256 KB of `events.jsonl`; the Claude review or the Codex gate reviewing iteration N; the MR writer; else `null`), `tool_calls` (the Implementer's tool calls in the job, counted incrementally: only the bytes added since the last count are read) and `stop` (for `needs_human`, `{items, saves_lines}`: the suggestions of the last simplification pass and the lines they save, the ledger entries to settle (`escalated`, `review_disputed`), the open ones (`review_churn`) or the last gate's items (`gate_rounds`, `gate_budget`), none for other codes; `null` otherwise) |
| `api/jobs/<ws>/<ticket>` | `{job, iterations: [{number, started_at, ended_at, cost_usd, changed_files, patch_truncated, denials, files, review, gate, gate_override, simplify}], mr, gate, history: [{ts, from, to, error?} or {ts, event: "gate_overridden", code, unapplied} or {ts, event: "merge_request", action, number, url, state}], mr_title, ledger}`; `mr_title` is the MR text's first line or `null`; `ledger` is `ledger.json` as written (`[]` before the first Fix section, SF-052); `gate` is whether the Codex gate is on, `gate_override` the iteration's `gate-override.json` or `null`, `simplify` its `simplify.json` (SF-055) or `null` |
| `api/workspaces` | `{workspaces: [{name, path, liveJobs, problem, handoff, color}]}`: the registry, the checkout's path, its non-terminal jobs, why the checkout cannot be used now or `null`, its own hand-over setting or `null`, and its colour on the board (SF-084: its `color`, else the one its name picks) |
| `api/tickets` | `{tickets: [{workspace, ticket, title, base, draft, request, job, lands_after, attachments, conversation: {message, url}, queue_position, queue_error}], archived: [{workspace, ticket, title}], job_lands_after: [{workspace, ticket, lands_after}], queue: {max_running, running, held, hold_reason, next}}`: the Task files without a live job; `queue_position` its 1-based place in the run queue or `null`, `queue_error` the queue's failed start `{code, message}` or `null`, `queue` the run queue (`next`: `{workspace, ticket}` of the first entry that waits for nothing, or `null`; the whole `queue` is `null` without a run queue) (SF-071, section Run queue); `lands_after` the tickets its Task file waits for, `[{workspace, ticket, state}]` with `state` `merged`, `pushed`, `running`, `planned` or `missing` (SF-084, section Dashboard), and `job_lands_after` the same for the Task files with a live job; `attachments` its images `[{name, bytes, type}]` (SF-064, section Ticket images); `draft` is true for a skeleton; `request` the user's words of New ticket or `null`; `job` is the last job's state or `null`; `url` is `https://chatgpt.com/?q=<message URL-encoded>`, or `null` when too long |
| `api/jobs/<ws>/<ticket>/iterations/<n>/report` | the Report, `text/markdown` |
| `api/jobs/<ws>/<ticket>/iterations/<n>/patch` | the Patch, `text/x-diff` |
| `api/jobs/<ws>/<ticket>/mr` | the MR text, `text/markdown`; 404 until there is one |
| `api/jobs/<ws>/<ticket>/mr-view` | the Merge request screen (SF-080), `Execution.mergeRequestView`: `{title, body, factory: {title, body}, edited, edited_at, factory_new_at, branch, base, branch_editable, branch_reason, base_editable, base_reason, problems: [{field, message}], pushed, pushed_at, editable, readonly_reason, target: {host, repository}, rules: {commit_types, max_header_chars, required_headings, manual_claim: {source, flags}}, commit: {title, body} \| null, commit_differs}`; `branch_editable` and `base_editable` come from the job only (not pushed, not handed over, no merge request), `editable` is the screen's state, and the page disables the fields while either says no; an empty 404 without MR text or with a query. No network call (section Merge request screen) |
| `api/jobs/<ws>/<ticket>/changes` | the Changes screen's iterations (SF-079): `{base: {ref, commit}, iterations: [{n, ended_at, truncated, base_commit}]}`; `base.ref` is the job's base branch, `base.commit` the last published iteration's base; an iteration's `base_commit` is `null` when it is not known (section Changes) |
| `api/jobs/<ws>/<ticket>/changes?from=base\|<N>&to=<N>` | the files of a view: `{files: [{path, status, additions, deletions, binary, unavailable}], more}`, `status` `added`, `modified` or `deleted`, sorted by path, at most 3000 files (`more: true` beyond). Only two pairs: `from=base` with a published `to` (the base of iteration `to` against `to`) and `from=<to − 1>` with `to` ≥ 2; any other pair, a half pair or another parameter is an empty 404 |
| `api/jobs/<ws>/<ticket>/file?at=base\|<N>&path=<path>` | one side of one file (SF-079): `{kind: "text", text}`, `{kind: "absent"}`, `{kind: "binary", bytes}` (the blob's size, `null` at an iteration whose Patch holds no content), `{kind: "too_large", bytes}` above 1 MiB, or `{kind: "unavailable", reason}`; `at=base` takes `&of=<N>`, the iteration whose base is meant (the last one when left out). Only a path of a `changes` list of a view that shows that side is served (for `at=base&of=N` the list of `from=base&to=N`; for `at=N` those of `from=base&to=N`, `from=N−1&to=N` and `from=N&to=N+1`); any other path, `..`, `.software-factory/`, an iteration not published or another parameter is an empty 404 |
| `api/jobs/<ws>/<ticket>/stream?from=<line>` | the job's Stream (SF-082) for the v3 job page: `{entries, next, end}`, the entries of at most 2000 lines of `events.jsonl` from the 0-based `from` (default 0, at most 9 digits, else 404), in line order; `next` is the first line not read, `end` whether the file has no more lines (a `from` past the last line: `{entries: [], next: from, end: true}`; a job without `events.jsonl`: `{entries: [], next: 0, end: true}`). Each entry has `t`, `k` (`"<line>"`, or `"<line>.<n>"` when the line gives several), `ts`, `it` (the record's iteration, at least 1) and `who` (`implementer`, `claude`, `codex`, `you`, `factory` or `mr`). Types: `prompt` (`kind` `implement`, `fix` with `fix_n` and the `## Fix N` section of `task.md` as `fix`, `mr`, `conflict` or `continue`; `text` without the factory's rules block, `first`, `task_changed` when the Task-change note was cut from `text`), `user` (the user's message, `text`, `task_changed`), `text`, `tool` (`id`, `line`, `detail`: the input as JSON, at most 16384 characters), `tool_result` (`id`, `out`, `result` at most 16384 characters, `err`; never merged into its `tool`: the client joins them by `id`), `result` (`turns`, `ms`, `cost`), `state` (`from`, `to`, `code`, `msg`), `verdict` (`verdict`, `effective`, and `summary` and `items` with their ledger `id` only when the iteration's `review.json` or `gate.json` matches the record's verdict and item count), `changes` (after a published iteration: `files`, `paths` from `meta.json`), `simplify` (`suggestions`, `saves_lines`) and `note` (every other record, as one `sf watch` line without its time and prefix). An entry depends only on its line and the job's files when it is built (`src/job-stream.ts`); a live `verdict` can lack the ledger ids a later page load has |
| `api/tickets/<ws>/<ticket>/task` | the ticket's Task file, `text/markdown`, read through the Task file reader (a regular file of valid Task content); `?archived=1` reads `.software-factory/archive/<ticket>.md` instead (any other `archived` value is 404); an unknown workspace or a missing file is an empty 404, a file the reader refuses its refusal (`400 invalid_content`) |
| `api/tickets/<ws>/<ticket>/attachments/<name>` | one image of the ticket (SF-064), with the content type its bytes tell and `x-content-type-options: nosniff`; a missing workspace, Task file or image (or any query) is an empty 404, a bad name `400 invalid_name`, a file that is not the image its name says `400 attachment_type` |
| `api/stream?job=<ws>/<ticket>&from=<line>` | server-sent events: `jobs` (on connect and on every state change), `workspaces` and `tickets` (as the two endpoints, at the same times and after every setup action from a page), `job` (the job's detail, on connect and when it changes state), `event` (`{line, ts, iteration, type, text}` for every visible line of `events.jsonl` from the 0-based `from`, as `sf watch` formats it; the page reads `entries` since SF-078), `entries` (`{line, entries}`, the line's entries as `api/jobs/<ws>/<ticket>/stream` gives them, for every line from `from` that has entries, strictly in line order; a line whose build fails is logged and skipped); a comment every 15 s; at most 8 streams, then 503 |

| Method and path | JSON body | Calls |
|---|---|---|
| `POST api/jobs/<ws>/<ticket>/approve` | `{"as_is"?: boolean}` | `Execution.approve(ws, ticket, as_is)`: the push of the prepared branch; `as_is` pushes a tip edited by hand; it waits up to 10 s for the job's runner to end and is refused with `409 runner_active` while the runner runs or a request (`sf say`, a fix) waits for it (SF-042) |
| `POST api/jobs/<ws>/<ticket>/abort` | `{"discard": false}`; `discard` optional, default false | `Execution.abort(ws, ticket, discard)` |
| `POST api/jobs/<ws>/<ticket>/say` | `{"message": "<text>"}` | `Execution.say(ws, ticket, message)`; the text goes as it is (nothing trimmed or split); answered by the job's runner (SF-042), so `500 runner_failed` or `500 runner_timeout` can come back |
| `POST api/jobs/<ws>/<ticket>/review` | `{}` | `Execution.retryReview(ws, ticket)` (`sf review`): the failed review of the last iteration runs again; result `{state, iteration}`; `409 invalid_state` unless the job is `needs_human` with `review_failed`, `409 review_off` with `SF_REVIEW=off`; answered by the job's runner, so `500 runner_failed` or `500 runner_timeout` can come back |
| `POST api/jobs/<ws>/<ticket>/settle` | `{"id": string, "decision": "accept" \| "fix", "note"?: string}` | `Execution.settle(ws, ticket, id, decision, note)` (`sf settle`, SF-052): the settlement of an escalated or contested ledger entry; result `{state, id, status, waiting}`; `409 invalid_state` unless the job is `needs_human` and the entry escalated or contested; `400 invalid_content` for a bad id, decision or note; `500 ledger_invalid` when `ledger.json` cannot be read; answered by the job's runner |
| `POST api/jobs/<ws>/<ticket>/simplify` | `{}` | `Execution.simplify(ws, ticket)` (`sf simplify`, SF-055): the Fix section "Simplify" with the suggestions of the simplification pass and their ledger entries, then the next iteration; result `{state, iteration, check_after_minutes}`; `409 invalid_state` unless the job is `needs_human` with `simplify_offered` (and never a second time); `409 worktree_missing`; answered by the job's runner, so `500 runner_failed` or `500 runner_timeout` can come back |
| `POST api/jobs/<ws>/<ticket>/accept` | `{}` | `Execution.acceptGate(ws, ticket)` (`sf accept`, SF-047): the override of the stopped gate, then MR preparation; result `{state, iteration, branch}`; `409 invalid_state` with the reason unless the job is `needs_human` with `gate_rounds`, `gate_budget`, `gate_failed`, `review_churn`, `review_disputed` or `simplify_offered` (Skip, SF-055) and a clean Claude review of the last iteration; the MR preparation's refusals (`409 worktree_missing`, `409 turn_running`); answered by the job's runner, so `500 runner_failed` or `500 runner_timeout` can come back |
| `POST api/jobs/<ws>/<ticket>/mr-create` | `{}` | `Execution.createMergeRequest(ws, ticket)` (`sf mr create`, SF-048): result `{state, branch, title?, link?, mr?: {host, number, url, state, reused}, error?}`; from `ready_for_human_review` it waits for the job's runner like approve; `409` for `invalid_state`, `runner_active`, `mr_token_missing`, `mr_host_unsupported`, `mr_text_missing`; `502` for `mr_auth_failed`, `mr_host_error`, `mr_host_unreachable` |
| `POST api/jobs/<ws>/<ticket>/mr-save` | `{"title": string, "body": string, "branch"?: string, "base"?: string}` | `Execution.saveMr(ws, ticket, input)` (SF-080): the MR text saved, the prepared commit's message rewritten, the branch renamed and the base changed when given and different; result `{state, branch, base, edited, prepared_commit}`; `400 mr_text_invalid`, `409` for `invalid_state`, `runner_active`, `branch_changed`, `branch_locked`, `base_unrelated`, `mr_text_missing`; its body may be up to 6 × 64 KiB + 1 KiB (an MR text of 64 KiB, escaped); the pages that show the job get its detail |
| `POST api/jobs/<ws>/<ticket>/mr-reset` | `{}` | `Execution.resetMr(ws, ticket)` (SF-080): the factory's text back and the commit message with it; result as `mr-save`; `409 invalid_state` "The MR text is already the factory's." |
| `POST api/jobs/<ws>/<ticket>/handover`, `.../takeback`, `.../handed-done` | `{}` | `Execution.handover`, `takeback`, `handedDone` (`sf handover`, `sf takeback`, `sf handed-done`, SF-073); `409` for `invalid_state`, `runner_active` and the hand-over's codes (section Hand-over to your checkout). `GET api/jobs/<ws>/<ticket>` of a `handed_over` job also starts `Execution.checkHandedOver` (at most once a minute), whose push reaches the page through the job's events |
| `POST api/jobs/<ws>/<ticket>/mr-merge` | `{}` | `Execution.mergeMergeRequest(ws, ticket)` (`sf mr merge`): result `{state, branch, mr}`; `409 mr_not_mergeable` with the host's reason, `409 mr_not_open`, and the codes above |
| `POST api/jobs/<ws>/<ticket>/mr-status` | `{}` | `Execution.mergeRequestStatus(ws, ticket)` (`sf mr status`): result `{state, branch, mr, status: {number, url, state, draft, mergeable, reason?, checks?, merge_commit?}}`; every page gets the jobs again, and the pages that show the job its detail (a merge request merged or closed on the host shows so at once) |
| `POST api/workspaces` | `{"name": string, "path": string, "handoff"?: "checkout" \| "off", "color"?: <palette name>}` | `Setup.addWorkspace`: the rules of `sf workspace add`; `color` one of `blue`, `teal`, `green`, `olive`, `orange`, `red`, `purple`, `grey` (SF-084), anything else `400 invalid_body`; result the workspace row |
| `POST api/workspaces/<name>/remove` | `{}` | `Setup.removeWorkspace`; `409 workspace_busy` while the workspace has a live job; result `{removed}` |
| `POST api/tickets` | `{"workspace", "ticket", "title", "request"}` | `Setup.createTicket`: the ticket skeleton through the Task file writer, the request kept for the conversation; result `{workspace, ticket, path, base}` |
| `POST api/tickets/<ws>/<ticket>/start` | `{}` | `Execution.start(ws, ticket)` (`sf start`, SF-040, SF-046): the job's record, branch and worktree, then iteration 1; result `{branch, state, check_after_minutes, worktree}`; refusals as they come (`409 task_draft` for a skeleton, `409 job_exists`, `409 branch_exists`, `404 task_not_found`, ...; a start by hand is never held by the run limit); every page gets the jobs, the workspaces and the tickets again |
| `POST api/tickets/<ws>/<ticket>/archive`, `.../restore`, `.../delete` | `{}` | `Setup.archiveTicket`, `restoreTicket`, `deleteTicket` (SF-027); the ticket's images folder with them (SF-064) |
| `POST api/tickets/<ws>/<ticket>/attachments?name=<name>` | the image's raw bytes, `Content-Type: application/octet-stream` (not JSON), at most 5 MB | `Setup.addAttachment` (SF-064, section Ticket images): `name` optional (the next number when left out; another query key or a second `name` is an empty 404); result `{name, bytes, type}`; `400 attachment_type`, `400 invalid_name`, `413 attachment_too_large` (also a body over 5 MB, checked against `Content-Length` and while reading), `409 attachment_limit`, `409 job_active`, `404 task_not_found`; every page gets the tickets again |
| `POST api/tickets/<ws>/<ticket>/attachments/<name>/remove` | `{}` | `Setup.removeAttachment` (SF-064): result `{name}`; `400 attachment_missing`, `400 invalid_name`, `409 job_active`; there is no DELETE method |
| `POST api/queue/add` | `{"workspace": string, "ticket": string, "at"?: integer >= 1}` | `RunQueue.add` (`sf queue add`, SF-071): result `{position}`; `404 task_not_found`, `409 task_draft`, `409 job_exists`, `409 already_queued` |
| `POST api/queue/remove` | `{"workspace": string, "ticket": string}` | `RunQueue.remove` (`sf queue remove`); `409 not_queued` |
| `POST api/queue/move` | `{"workspace": string, "ticket": string, "to": integer >= 1}` | `RunQueue.move` (`sf queue move`): result `{position}`; `409 not_queued` |
| `POST api/queue/limit` | `{"max_running": number}` | `RunQueue.limit` (`sf queue limit`): result `{max_running}`; `400 invalid_limit` outside 1-20 or not whole |
| `POST api/queue/hold`, `.../release` | `{"reason"?: string}`, `{}` | `RunQueue.hold`, `release` (`sf queue hold`, `release`) |

The actions go to the same `Execution` as the socket commands, under its lock and guards; there
is no second state machine and no other mutation endpoint. The setup
actions go to `src/setup.ts`, which writes the same registry file as `sf workspace add|remove`
and the same Task files as `write_task`, under the Execution's lock, so a registry change and a
start never interleave. An action request must carry the
token, an `Origin` equal to the page's exact origin (`http://127.0.0.1:<port>` with the actual
port; a missing Origin, another loopback address or port and the MCP origin are refused with
`403 invalid_origin`; a `null` or foreign Origin is already refused, `403`, by the loopback
Origin check every request passes), `Content-Type: application/json` (a `charset=utf-8`
parameter is accepted; anything else `415 unsupported_media_type`; an image upload takes
`application/octet-stream` instead, SF-064) and a body of at most 128 KiB
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
`job_limit` (the run queue's own start, SF-071), `task_draft`, `checkout_dirty`, `branch_exists`, `branch_changed`, `branch_missing`,
`worktree_exists`, `worktree_missing`, `sensitive_unacknowledged`, `ticket_exists`,
`workspace_exists`, `workspace_busy`, `branch_locked` and `base_unrelated` (SF-080),
`already_queued` and `not_queued` (SF-071), `attachment_limit` (SF-064),
`413` for `attachment_too_large` (SF-064),
`404` for `job_not_found`, `workspace_not_found` and `task_not_found`, `400` for `invalid_content`, `invalid_ticket`, `invalid_name`,
`workspace_invalid`, `mr_text_invalid` (SF-080), `invalid_limit` and `invalid_position` (SF-071), `attachment_type` and `attachment_missing` (SF-064), and `500` for any other code (a Git failure before the preparation, for
example; `runner_failed` and `runner_timeout` of a request the job's runner answers: say,
review, accept). Any other failure is `500`
with `internal_error` and a fixed message; the cause is logged, never the body or the token.

When the page's approve request is cut, the push goes on and its outcome is recorded in the job;
a second approve of a pushed job is refused (`invalid_state`).

### Changes

The job page's Changes screen (SF-079, the prototype's `renderChanges`) shows a job's files the way
IntelliJ does: the file tree on the left, the diff of the selected file on the right, read-only.

- **Tree.** The filter (`/`), *Group by directory* or *Flat list*, the summary "N files: a modified,
  b added, c deleted · +x −y" (with "· k match" while filtering), and one row per file: M, A or D,
  the name (in the flat list its folder after it), `+a −d`; modified blue, added green, deleted grey
  and struck through; a `binary` or `unavailable` tag. A folder that holds one folder only is shown
  as one row (`a/b/c`), with ▾/▸ and its file count. The divider between tree and diff is dragged
  with the pointer, or moved with Arrow Left and Right when focused; the width stays while the page
  is open.
- **Diff.** The toolbar: ◀ Shift+F7 and F7 ▶, the path, "i/n · status", the view, *Side-by-side* or
  *Unified* (kept in the browser's localStorage), *Collapse unchanged* (on: unchanged runs fold to
  "⋯ N unchanged lines" with 3 lines of context around each change, none at the file's edges; a
  click unfolds). Changed words are highlighted. A new file says "New file: all added", a deleted
  one "Deleted file: the old content, all removed", a modified one side by side "Before (<base>)" or
  "Before (iteration N−1)" and "After (iteration N)". A binary file, a file above 1 MiB and an
  unavailable file say so instead of a diff. The line diff is computed in the page (the prototype's
  Myers with the common prefix and suffix trimmed first; beyond 2500 steps a file shows all lines
  removed and added).
- **Views.** *All changes (final, after iteration N)* is the last iteration against its base;
  *Iteration N (Fix N−1)* is iteration N − 1 against N (iteration 1 against its base). After a
  conflict-resolved rebase between two iterations, Iteration N also shows the upstream changes and
  says "The base moved from <old> to <new> before iteration N". A running iteration is not shown;
  before the first one ends the screen says when the changes come.
- **Keys.** `/` the filter (Arrow Down or Enter in it goes to the tree); in the tree Arrow Up and
  Down move, Left closes a folder or goes to its parent, Right opens it, Enter opens a folder or
  shows the file's diff; F7 / Shift+F7 and `n` / `p` the next and previous file; `s`, `m` the other
  screens; Escape the Stream. A path link of the Stream opens Changes at that file and iteration
  (All changes when the file did not change in it); *Open these changes* at that iteration.

The header's *Changes (N)* is the `files` count of `api/jobs` (the last iteration's file list,
SF-024); the sensitive and out-of-scope marks of each file are in the Stream's changes entry and
its Report, not on this screen.

How the factory gets the file versions (`src/changes.ts`). Each iteration's `meta.json` records
`base_commit`, the commit its Patch is against (an iteration published before has none: it uses
the job's `base_commit` while MR preparation never started, else its files are unavailable, the job
may have been rebased since). The tree after iteration N is the tree of N's base with N's Patch
applied, built by Git in a temporary index (`read-tree`, `apply --cached`, `write-tree`) in the
workspace's checkout, with the new objects in the job's own object directory
(`<job dir>/objects`, the checkout's objects as alternates): nothing is written into the
checkout's repository, its index, its refs or the job's worktree. The tree id is kept in
`iterations/NNN/tree` and rebuilt when missing or when its objects are gone. A section of the Patch
that holds no exact text is left out of the tree and its file marked: "Binary files … differ"
(`binary`), a submodule, a section that is not UTF-8 (the Patch holds U+FFFD for those bytes), and
the section a truncated Patch was cut in; after a cut at 2 MB every file of `meta.json` with no
section is unavailable too (every file, when the iteration has no file list). A Patch that does not
apply makes every file of that iteration unavailable with Git's message; so does a checkout that is
missing or not a Git work tree. The lists drop every path a Patch never contains
(`.software-factory/` and credential-like paths), also among the upstream changes between two
bases. The results are cached in memory, 16 per job.

### Merge request screen

The job page's Merge request screen (SF-080, the prototype's `renderMr`, `renderMrChecks` and
`mrAction`) shows the job's MR text once Clean wrote it (`mr.md`), read from
`api/jobs/<ws>/<ticket>/mr-view`.

- **Form.** *Branch* ("Editable until the first push." or why it is fixed), *Base branch*, *MR
  title* (the commit header too: `<type>(<ticket>): <summary>`, at most 72 characters) and
  *Description* with Edit | Preview. Preview renders the Markdown as nodes (headings, paragraphs,
  lists, task lists with disabled boxes, code fences, tables, inline code, bold, italics, and
  links only to `http:` and `https:`, opened in a new tab); raw HTML shows as text. A "Not
  checked:" line is marked, so is a manual check claimed as run (SF-058). "edited by you" when the
  saved text is not the factory's, with *Show changes against the factory's text* (a line diff).
  After a new Clean that kept the user's text: "The factory wrote a new text (time). Compare ·
  Reset to factory text".
- **Side panel.** *Commit message* (read-only: the title, a blank line and the whole body; the
  prepared commit's own message with "differs from the MR text: save or reset" while it is not the
  MR text), *Carries* (files with *Open Changes*, the last Claude and Codex verdicts with their
  iteration, the Codex tokens, the fix rounds, the target host and repository and `base ← branch`),
  *Not checked* (the `## Testing` lines starting with "Not checked:" and each line SF-058 flags),
  *Checks* (✓/✕: the title rule, branch and base set, the required headings, no manual check
  claimed as run) and, after an override of the gate, *Codex items not applied*.
- **Checks.** The page checks the draft as it is typed with the values of the rules `mr-view`
  sends from `src/rules.ts` (the commit types, the header length, the required headings and the
  manual-claim pattern; the page builds the header pattern from them), each problem on its field; without unsaved changes the
  server's list of the saved text is shown. The factory checks again at Save, and its answer wins:
  a refusal shows in the bar and the view is read again.
- **Bar.** "Unsaved changes", "Saved, edited by you" or "The factory's text", the problem count,
  *Save* (Ctrl+S), *Reset to factory text*, *Push branch only* (approve; `branch_changed` offers
  *Push it as it is*) and *Push and open MR ↗* (one `mr-create`: the push, then the merge request;
  never one after a failed push; hidden with its reason next to Push branch only while the
  workspace's merge request actions are off). The push buttons are off while there are problems; with
  unsaved changes a push saves first and pushes only when the save succeeded. Switching screens
  keeps the draft; leaving the page with it unsaved asks first.

**When it can be edited.** In `ready_for_human_review`, and in `needs_human` after a failed or
refused push (`mr_push_failed`, `mr_push_protected`). Read-only otherwise, with a line saying why:
pushed ("Pushed at HH:MM. The MR text is read-only now." and *Back to the stream*), handed over
("The branch is in your checkout. Take it back to edit the MR text."; the push buttons stay), any
other state ("The MR text can be edited when the job waits for your review.").

**Save** (`POST mr-save`) and **Reset** (`POST mr-reset`) run as approve does: under the
Execution's lock, after the job's runner has ended (`runner_active` while a request such as a fix
runs), the state checked before and after. Every check comes first; a refusal changes nothing.

- The text is composed as the commit message is written (the title, a blank line, the body and a
  final newline) and must pass the factory's own rules (`mrTextProblem`: the title rule, the
  required headings, SF-058, at most 64 KiB), else `400 mr_text_invalid`. The first save keeps the
  factory's text as `mr-factory.md` next to `mr.md`; `edited` means the two differ.
- **Commit message.** When the saved text differs from the prepared commit's message, the factory
  rewrites it before any push, in the job's worktree under the workspace's Git lock: `git commit
  --amend --only --cleanup=verbatim -F <file in the Git dir>`, hooks off. The tree, the author and
  the author date stay; the user's `commit.gpgSign` applies as at Clean; `prepared_commit` becomes
  the new tip. A branch tip that is not `prepared_commit` (edited by hand) is `409 branch_changed`;
  a worktree that is gone `409 invalid_state`. Approve never amends: after the push the text is
  read-only.
- **Branch rename**, only before the first push: the job not pushed, not handed over, without a
  merge request; the branch not on origin (`git ls-remote`, 15 s; an origin that cannot be asked
  refuses with "Could not check origin for <branch>: …") and checked out in no worktree but the
  job's own (the user's checkout included). The new name passes `git check-ref-format --branch`,
  exists neither locally nor on origin, is not `main`, `master` or the base. `git branch -m` in the
  checkout; the job's worktree follows. Otherwise `409 branch_locked` with the reason.
- **Base change**, only before the push: the branch is not on origin (`git ls-remote`, 15 s: a
  push that failed may still have reached it; such a branch refuses with `base_unrelated`, an origin
  that cannot be asked with `branch_locked`), and the new base exists on origin and contains the commit
  the change was rebased onto at Clean (`target_commit`; `git fetch origin refs/heads/<new>` and
  `git merge-base --is-ancestor`), else `409 base_unrelated` ("The change was prepared on <base>;
  restart the job with base <new> instead."). The commit is not rebased.
- **Reset** restores the title and text only (`mr-factory.md` back as `mr.md`, the commit message
  with it); branch and base stay as saved. Refused (`409 invalid_state`) when the text already is
  the factory's.
- Each save and reset appends `{ts, iteration, type: "mr_edited", action: "saved" | "reset",
  branch?, base?}` ("You edited the MR text", "You reset the MR text to the factory's"), shown in
  the Stream as the user's note; `factory_new` (section MR preparation) as the factory's.
- **Before a push**, approve and `sf mr create` refuse with `mr_text_invalid` while `mr.md` fails
  the rules or is not the message of the commit the push would carry (`prepared_commit`; in
  `handed_over` the saved one); a handed-over push of the user's own commits is not checked.

### Checking the page by hand

The automated checks run the page's script against a stand-in document
(`test/support/fake-dom.ts`), not a browser: layout, scrolling, focus, Enter in the textarea and
the look in light and dark are only checked by hand. With `sf serve` running on a throwaway repository and
`SF_CLAUDE` pointing at `dist/test/support/fake-claude.js` (or a real job you are willing to
end), in a browser:

1. Board: open the URL of `sf dashboard --open` next to `docs/design/dashboard-v3/prototype-full.html`
   of the branch `prototype-dashboard-v3`: the same top bar, columns and cards, in light and dark
   (the OS scheme) and at phone width (below 760 px the columns stack with Your turn first). Five
   columns with their counts; each job is in the column of its state; a running card has the Now
   line and the tool calls, and its time moves every 15 s; a stopped one its reason, its code and
   one button. The workspace filter keeps one workspace's cards, its chips with the workspaces'
   colour dots; two workspaces' cards differ at a glance by their stripes, and each card names its
   workspace. Dependencies: a Queue card whose Task file has `lands_after:` an open ticket shows
   Waits for with its chip; hovering it outlines that ticket's card and dims the rest; its chip
   scrolls to that card. Narrow the window: no Queue card overlaps the next column, keys do not
   wrap. With more than eight finished
   jobs Done shows eight and *Show all N*, which expands the column in place. The run queue's
   controls are shown ("Run up to N jobs at once" and its status); the Rules menu is not.
2. Start: on a Queue card with a written Task file click Start: the dialog names the workspace,
   the ticket and the base branch; Cancel sends nothing (`sf status` unchanged). Confirm: the toast
   at the top says the job started and goes after 6 s, and the card appears under Implementing,
   then moves to Reviewing and Your turn as the job goes on, without a reload. A skeleton shows
   "waiting for the plan" and no Start; a refused Start (a branch that exists: `branch_exists`)
   shows the code and message in the toast, which stays until × or Escape. Run queue (SF-071):
   set the limit to 1 with −; *Add to queue* on two written tickets: the first starts by itself, the
   second waits ("1 running · 0 slots free"); drag the second above another queued card, or Alt+Up
   on it: its position changes after the server's answer; once the first job is ready for review the
   second starts by itself.
3. Planned ticket page: click a Queue card: the page opens full width, the URL ends in `/ticket`;
   compare it with the prototype's planned ticket (`prototype-full.html`; its queue part is not
   here, and its Images card has no "choose a file", SF-064), in light and dark. Preview shows the Task body as Markdown without the
   front matter; a line `<script>alert(1)</script>` shows as that text, nothing runs; a link
   `[x](javascript:alert(1))` is not a link. The right cards read in plain words (Starts from,
   Files it will change with 🔒 on `may_touch` entries, Waits for, Plan check, Planning
   conversation, History). Edit, change a line: "Unsaved changes", Ctrl+S saves, "edited by you"
   and "Edited by you" in History. Edit again, then rewrite the file with `write_task` (or by
   hand) and Save: "Not saved: the Task file changed…", Reload shows the new file; History says
   "Changed outside the factory" for a change by hand. Escape goes back to the board, the focus on
   the card. Archived → Task shows an archived file in the drawer.
   Images (SF-064): take a screenshot and press Ctrl+V on the page (not in a text field): it
   uploads, the toast says "Attached 1.png.", and the Images card shows it; a click opens it whole
   in a new tab. Drop a JPEG and a text file renamed `.png` on the area: the JPEG is attached, the
   text file refused with `attachment_type`. Paste text into the Task file editor: it goes in as
   text. Copy image, then paste into a ChatGPT conversation: the image arrives (a JPEG as PNG). ×
   removes one. In New ticket paste two screenshots into "What you want": two thumbnails `1.png`,
   `2.png` with ×; Create: `.software-factory/<ticket>/1.png` and `2.png` exist, and the ticket's
   first message names them.
   Check: on the page click Check the plan (or Check in a card's ⋯ menu): "Checking…", then the
   verdict a few minutes later without a reload. Save a change: the check says "The plan changed
   after this check", and Start now's dialog says "Task check: stale" (and what the ticket waits
   for) and starts once confirmed; the page moves to the job's Stream.
4. Job page: click a job card: the job opens as a full page next to the prototype's job page
   (`prototype-full.html`, SF-053, SF-054 and SF-040 there), in light and dark: the header (*←
   Board*, the key, the title, the switch, the sentence with its dot, the iteration, the cost, the
   elapsed time and the branch), the Stream and the composer at the bottom. The URL ends in
   `#<workspace>/<ticket>`; reload: the same page opens, the Stream read again. `c`, `m` and `s`
   switch the screens (`m` says "No MR text yet" before MR preparation); add `/changes` or `/mr` to
   the URL: that screen opens. Escape on Changes goes to the Stream, Escape again to the board with
   the focus on the card; the browser's Back and Forward move between them. A click on the branch
   puts `git checkout <branch>` on the clipboard. Escape in an open confirmation closes only it.
   List each difference from the prototype with its reason.
5. Keys: on the board `j` and `k` move the focus between the cards, Enter opens the focused one.
6. Say: on the page of a job in `awaiting_review` type two lines (Enter adds a line and submits
   nothing), click Send: "Sent" and an empty box, and the message appears in the Stream; while
   that turn runs, send another with Ctrl+Enter: "Queued"; `sf watch` shows both prompts as typed.
7. Abort: click Abort…; the confirmation opens inside the composer, names the job and the branch
   and says the files stay; Cancel: `sf status` is unchanged. Open it again: the discard box is
   unchecked; tick it: the button reads "Abort and discard the branch"; Cancel and reopen:
   unchecked again. Confirm a plain abort on a job you can lose: "Aborted; the branch … stays";
   the card moves to Done.
8. Approve: on a Your turn card in `ready_for_human_review` click *Review the MR and push*: the
   job's Merge request screen opens (no dialog); *Push branch only*: "Pushed …" with the title and
   the merge request link (or the note to open it by hand); the card moves to Done. In the
   composer *Approve…* still opens the approve dialog; on a `handed_over` card *Review the MR and
   push* opens the job's page with it.
9. Retry review (a fake review scripted to fail): the job is under Your turn with "Claude review
   could not run" in red and *Retry review* on its card; click it: the card moves to Reviewing.
   A decision stop (`gate_rounds`, below) is never red.
10. Switching: start a say or an approve and open another job before the answer: that job's
   controls, status and draft are untouched; open the first again: the outcome is there.
11. Unknown outcome: with DevTools offline (or `sf serve` stopped) send a message: "outcome is
   unknown", the draft stays and Send, Approve… and Abort… stay off with a reason; the read fails
   and Refresh state appears; back online, click it: the state is current and nothing was
   re-sent. The same for Start: offline, confirm a Start: its outcome is unknown and Start stays
   off for that ticket until the board is read again; nothing is re-sent.
12. Reconnect: stop `sf serve` with the page open: the top bar shows "reconnecting" and no request
   is re-sent; start it again and reopen the page with the new URL (the old token is 404).
13. Setup: with an empty registry (`SF_CONFIG_DIR` pointing at an empty directory) the board says
   to add a workspace; Workspaces opens the drawer with the Add form; add a throwaway repository by
   its path (a wrong path shows the refusal in place). New ticket with a key, a title and two lines
   of request writes `.software-factory/<key>.md` as a skeleton (`## Status: waiting for the
   Context owner`, no request text): the dialog closes and the board scrolls to the new Queue card,
   highlighted, with "waiting for the plan". Its page has *Open the ChatGPT conversation ↗*: a new
   tab on chatgpt.com with your words in the first message (press Enter if it stays there); Copy
   puts the first message on the clipboard; History says "Created by you". Once ChatGPT wrote the Task file, Start
   appears on the card. Remove on a workspace with a live job is off with the reason. Nowhere on
   the page is there a Reviewer line, a reviewer setup, Nudge, Send test event or Subscriptions.
14. Stream: a running job's entries arrive live at the bottom and the view follows them while it is
   at the bottom (scroll up: it stays where you are). Each tool call is one line with its result;
   `j`, `k`, `G` and Enter select and open entries; long texts say *Show all N lines*; the implement
   prompt's *Task* shows the Task file with its Fix sections and its Task check. A path in a
   verdict opens Changes at that iteration with its file selected (All changes when the file did
   not change in that iteration). Stop `sf serve` and start it again
   (open the new URL): the Stream reads again and shows no entry twice. Merge request says there
   is no text until MR preparation wrote it, then shows it, and Copy MR text puts the title, a
   blank line and the body on the clipboard.
15. Changes: open Changes of a real finished job next to `prototype-full.html` (branch
   `prototype-dashboard-v3`) and compare, in light and dark: the tree (folders compacted, M/A/D in
   blue, green and grey struck through, the counts, the filter, the flat list), both diff layouts
   (side by side with Before/After, unified, the changed words, *Collapse unchanged* and a click on
   "⋯ N unchanged lines"), the view selector (All changes, each iteration with its Fix) and the keys
   (`/`, the arrows and Enter in the tree, F7 / Shift+F7, `n` / `p`, Escape). Drag the divider and
   move it with Arrow Left and Right; switch to the Stream and back: the width stays. Reload: the
   layout chosen stays. A binary file, a file above 1 MiB and, on a job whose Patch was cut, a
   file after the cut say so instead of a diff. List each difference from the prototype with its
   reason.
15a. Merge request: open the Merge request screen of a real job ready for review next to
   `prototype-full.html` (branch `prototype-dashboard-v3`, SF-053 there) and compare, in light and
   dark: the form, the side panel and the bar. Edit the title (a period at the end: its line and
   the count show, the push buttons go off), the text (Preview: the Markdown, a "Not checked:"
   line marked; `<script>` and a `javascript:` link stay text), press Ctrl+S: "Saved, edited by
   you", "edited by you", `git log -1 --format=%B <branch>` shows the new message, the tree and
   the author unchanged; *Show changes against the factory's text*; *Reset to factory text*.
   Change the branch before the push (and to `main`: refused with the reason); switch to the
   Stream and back: the draft stays; reload with unsaved changes: the browser asks. List each
   difference from the prototype with its reason.
16. Layout: Tab reaches each card, its buttons, the job page's *← Board*, the switch, the Stream's
   toggles and path links, the composer's message box and buttons and a confirmation's buttons.
   On a phone the header wraps and the composer's buttons go under the message box.
17. Accept and prepare MR (a fake Codex scripted to ask for fixes past `SF_GATE_MAX_ROUNDS=1`): the
   job is under Your turn with "Codex round limit reached", `gate_rounds` and *Decide N findings*;
   its page's stop block says "Your decision" (never red) with the last gate's findings, and the
   composer offers *Accept and prepare MR* first; its confirmation lists the Codex items; Cancel
   sends nothing; confirm: the job goes to MR preparation and Your turn, the Stream shows the state
   changes, and Merge request lists the Codex items not applied.
18. Simplification (a fake simplification pass scripted to suggest something): the stop block says
   "Your decision" with each suggestion (its path, what, why and the lines it saves) and no error
   marker anywhere; the composer offers Simplify and Skip, each with its confirmation listing the
   suggestions. An escalated finding (a fake Implementer that escalates) shows its question, a
   note field and *Accept risk* / *Must fix*: a click settles it at once and the entry then shows
   the decision.

## Workspace registry

`<config dir>/workspaces.json`, written by `sf workspace add|remove` and by the dashboard's start
screen (`POST api/workspaces`):

```json
{
  "workspaces": {
    "my-app": { "read_checkout": "/abs/path" },
    "software-factory": { "read_checkout": "/abs/path2", "handoff": "off", "color": "teal", "rules_skip": ["docs/runbooks/coordinator.md"] }
  }
}
```

Names are 1-64 characters of `a-z`, `0-9` and `-`, starting and ending with a letter or digit. The
path must be absolute and, whenever a tool uses it, the root of a non-bare Git work tree. An invalid
file is an error, never ignored. `read_file` and `search` read the checkout; `write_task` writes
`.software-factory/<ticket>.md` in it and adds `.software-factory/` to its `.git/info/exclude`;
every job's worktree is created from it (SF-019). A `work_checkout` field of an older registry is
read and ignored, with one warning when `sf serve` starts; `sf workspace add --work` is refused. The
optional `handoff` (`"checkout"` or `"off"`, any other value makes the file invalid) is the
workspace's own hand-over setting and wins over `SF_HANDOFF` (SF-083, section Hand-over to your
checkout); `sf workspace add --handoff checkout|off` and the dashboard's workspace form set it.
`sf workspace list` and `sf info` show the setting that applies (the workspace's, or `SF_HANDOFF`
with the shell's value); the form's list shows the workspace's own or "as SF_HANDOFF". To change it
for a registered workspace, edit the file (it is read at each use) or run `sf workspace add` again
with the same name and path and `--handoff` (the other fields stay). The optional `color` (SF-084:
`blue`, `teal`, `green`, `olive`, `orange`, `red`, `purple` or `grey`; any other value makes the file
invalid) is the workspace's colour on the board; without it the dashboard picks one by the name.
`sf workspace add --color <name>` (an invalid name is refused with the list) and the dashboard's
workspace form set it; `sf workspace add` again with the same name and path and `--color` changes
it; `sf workspace list` shows it. The optional `rules_skip` (SF-059: a list of globs) names the
repository rule files not given to the agents (section Coding rules); edit the file to set it.

## History

`factory/` replaced the bridge of SF-001 to SF-010: one process with a Workspace registry instead of
a single fixed repository root, Task files instead of instructions under `factory-data/` and
dispatch to a separate gateway, and an Agent SDK session instead of a file-based execution loop.
The file reader is a copy of the bridge's. SF-011-e removed the bridge; the factory took over its
port 8787 behind the tunnel (see `docs/design/SF-011-factory.md`).
