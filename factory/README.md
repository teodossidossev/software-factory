# software-factory

The local factory process. It serves MCP tools to the Context owner (ChatGPT or any MCP client)
and provides the `sf` command. How to work with it is in [HANDBOOK.md](HANDBOOK.md); the
vocabulary is in [../CONTEXT.md](../CONTEXT.md).

It provides the planning tools (`guide`, `read_file`, `search`, `write_task`) and the execution
tools (`start`, `check`, `request_fix`, `mark_clean`). The Implementer runs as a headless Claude
Agent SDK session (`@anthropic-ai/claude-agent-sdk`, pinned in `package.json`) in the work checkout,
inside Claude Code's sandbox. After Clean the user finishes the ticket from the terminal with
`sf approve` (MR preparation and push), `sf abort` or `sf reset`, and is told about the states that
need them through a desktop notification and ntfy.

## Commands

```sh
npm install && npm run build      # once, inside factory/
bin/sf workspace add <name> --read <path> [--work <path>]   # --work defaults to --read
bin/sf workspace list
bin/sf workspace remove <name>
bin/sf serve                      # foreground; Ctrl+C stops it; prints the dashboard URL
bin/sf dashboard                  # the dashboard URL of the last sf serve start; works without sf serve
bin/sf start <workspace> <ticket> # start the job (same as the start tool); needs sf serve
bin/sf say <workspace> <ticket> <message...>   # a user message into the session; needs sf serve
bin/sf status [<workspace> <ticket>]           # one job or all jobs; works without sf serve
bin/sf watch <workspace> <ticket> [--once]     # the session live; works without sf serve
bin/sf approve <workspace> <ticket>            # MR preparation and push; waits for the outcome; needs sf serve
bin/sf abort <workspace> <ticket> [--discard]  # end the job; --discard removes the branch and its changes; needs sf serve
bin/sf reset <workspace> <ticket>              # end the session and archive the job, Git untouched; needs sf serve
bin/sf notify-test                             # one test notification on every channel; works without sf serve
npm run typecheck && npm test
```

Exit codes: 0 ok, 1 error, 2 usage. `sf approve` exits 1 unless the branch was pushed.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SF_PORT` | `8787` | Port of `http://127.0.0.1:<port>/mcp` (loopback only, Host and Origin checked). |
| `SF_DASHBOARD` | on | `off` starts no dashboard listener (and removes an old `dashboard-token`). |
| `SF_DASHBOARD_PORT` | `8788` | Port of the dashboard, `http://127.0.0.1:<port>/d/<token>/` (loopback only, Host and Origin checked). |
| `SF_CONFIG_DIR` | `${XDG_CONFIG_HOME:-~/.config}/software-factory` | Directory of the workspace registry. |
| `SF_HANDBOOK` | `factory/HANDBOOK.md` | Handbook served as instructions (its `## Quick start` section) and by `guide`. |
| `SF_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/software-factory` | Job state and the `sf.sock` socket. |
| `SF_CHECK_AFTER_START_MIN` | `15` | `check_after_minutes` returned by `start` and by `check` during the first iteration. |
| `SF_CHECK_AFTER_FIX_MIN` | `5` | `check_after_minutes` returned by `request_fix` and by `check` during later iterations. |
| `SF_MAX_TURNS` | `150` | `maxTurns` of every Implementer turn. |
| `SF_MAX_ITERATIONS` | `5` | Published iterations after which `request_fix` is refused (`iteration_limit`, job `needs_human`). |
| `SF_CLAUDE` | bundled binary | Absolute path of the Claude Code executable (`pathToClaudeCodeExecutable`). |
| `SF_SANDBOX` | on | `off` runs the Implementer without Claude Code's sandbox. |
| `SF_SANDBOX_DOMAINS` | empty | Comma-separated extra hosts sandboxed commands may reach, besides `registry.npmjs.org`. |
| `SF_DESKTOP_NOTIFY` | on | `off` disables the desktop notification. |
| `SF_NTFY_URL` | unset | Full ntfy topic URL, e.g. `https://ntfy.sh/<topic>`; unset disables ntfy. |
| `SF_NTFY_TOKEN` | unset | Sent as `Authorization: Bearer <token>` to a server that needs it. |

The socket path `${SF_STATE_DIR}/sf.sock` must fit a Unix socket address (107 bytes on Linux);
a longer one is refused at start with `socket_path_too_long`.

The execution variables are read once when `sf serve` starts. `sf status` and `sf watch` read
`SF_STATE_DIR` themselves; `sf start`, `sf say`, `sf approve`, `sf abort` and `sf reset` use it to find the socket; `sf notify-test` reads the notification variables itself.

## Jobs

One job per ticket, one active job per machine: every state in which the session may still be
alive (`starting`, `working`, `awaiting_review`, `needs_human`, `ready_for_human_review`,
`preparing_mr`) holds the slot; `pushed`, `aborted` and `failed` free it.

- `start` reads `.software-factory/<ticket>.md` (its `base` and `title`), refuses a dirty work
  checkout (`checkout_dirty`; `.software-factory/` does not count), fetches `origin <base>` when
  `origin` exists (60 s) and runs `git checkout --no-track -b <ticket>-<slug> <origin/base or base>` (no upstream is set). Then the
  first turn `/implement .software-factory/<ticket>.md` runs. A previous job of the ticket in
  `failed`, `aborted` or `pushed` is archived first; any other state refuses (`job_exists`).
- When the session is idle (its last queued turn ended), the factory publishes an iteration: the
  Report (the last assistant text, plus `## Changed files` and `## Denied actions`) and the Patch
  (`git diff <base commit>` plus untracked files, without ignored, credential-like and
  `.software-factory/` paths, at most 2 MiB). The job goes to `awaiting_review`.
- `request_fix` appends `## Fix N` to the Task file and runs `/implement .software-factory/<ticket>.md Fix N`
  in the same session (`resume`). `mark_clean` moves the job to `ready_for_human_review`.
- Every prompt the factory sends (the `/implement` line of `start` and `request_fix`, or the user's
  message of `sf say`) is followed by a blank line and `FACTORY_PROMPT_RULES` (`src/prompts.ts`):
  the factory's rules and the Report template, with the ticket and iteration filled in.
- `check` returns the last published Report and Patch in every state except `working` and
  `starting`. `meta.json` records `cost_usd` (this iteration's cost) and `cost_usd_total` (the
  SDK's cumulative total for the session).
- `sf say` queues a message as the next turn (in `working`, `awaiting_review` or `needs_human`);
  outside `working` the job goes back to `working` and publishes a new iteration at the end.
- A failed turn, a session that does not report permission mode `auto`
  (`permission_mode_mismatch`), an unavailable sandbox (`sandbox_unavailable`, with the SDK's
  message) or the iteration limit put the job in `needs_human`. When `sf serve` starts, jobs found
  `working` become `needs_human` (`serve_restarted`) and keep their session for `sf say`; jobs found
  `preparing_mr` become `needs_human` (`mr_serve_restarted`) for another `sf approve`. Nothing is
  retried automatically.
- `check` also returns `mr`, the MR text, once MR preparation produced one (`pushed`, or after a
  diff-check iteration), and `check_after_minutes` during `preparing_mr`.
- `sf abort` works in every non-terminal state: it aborts the running turn (queued prompts are
  dropped) and sets `aborted` without `error`; the branch and the files stay. `--discard` then runs
  `git reset --hard <base_commit>`, `git clean -fd` (no `-x`: `.software-factory/` and ignored
  files survive), `git checkout <base>` and `git branch -D <branch>`; a failing step leaves
  `aborted` with `error.code` `discard_failed`. `--discard` is refused (`rebase_in_progress`) while
  a rebase or a Git lock is in progress in the work checkout.
- `sf reset` works in every state: it ends a live session and archives the job directory as `start`
  archives a terminal job. Git is not touched.

Every turn runs with `cwd` = work checkout, `permissionMode: "auto"`, `settingSources: ["user",
"project"]`, a per-turn deny list from `src/rules.ts` (iterations: mutating Git commands, `sudo`,
`EnterWorktree`, `.git/**` edits, `.env` files; MR preparation: the same with `add`, `commit`,
`rebase`, `restore`, `checkout`, `switch`, `rm` and `mv` allowed), a filtered environment (no
`SF_*`, no inherited Claude Code session markers) and, unless `SF_SANDBOX=off`, the sandbox
`{enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, network: {allowedDomains:
["registry.npmjs.org", ...SF_SANDBOX_DOMAINS]}}`. The factory's own `fetch` and `push` run outside
the Implementer, so the Git host is not needed there; a repository whose checks need other hosts
(another package registry, a test service) lists them in `SF_SANDBOX_DOMAINS`. Nothing is written
under `~/.claude`.

The sandbox (bubblewrap) needs a mount point for every path it masks. When such a path does not
exist in the work checkout it creates it as a zero-byte file with mode 0444 and leaves it there:
`.bashrc`, `.gitconfig`, `.gitmodules`, `.mcp.json`, `.claude/settings.json`, `.claude/skills` and
others, plus the empty directory `.claude/.cc-writes/` (Claude Code's own). The factory removes them
(`src/placeholders.ts`) after every turn, before the Patch is built and before the MR verification,
in `start` before the dirty check, and in `abort --discard` before the Git steps, and logs what it
removed as `placeholders removed: a, b, c` in `sf watch` and the dashboard. The exact rule: in the
root of the work checkout an entry whose name starts with `.`, and in `.claude/` any entry, is
removed when it is a regular file (not a symbolic link) of size 0 with mode exactly 0444; then
`.claude/.cc-writes` and `.claude` are removed when they are empty directories. Nothing else is
touched: a file with content, a writable file, a symbolic link, a non-empty directory and anything
deeper or elsewhere stay. The Patch and the `mr_dirty` check also skip an untracked file that matches
the rule, in case the sandbox recreates one after the cleanup. A file the factory left in place
does not match the rule, so it is a change of the Implementer's or the user's.

## MR preparation

`sf approve` is allowed in `ready_for_human_review`, in `awaiting_review` (the user's word is final
even before Clean) and in `needs_human` once an MR preparation has run (`mr_attempts > 0`), which
makes it a retry after any failed preparation: a failed check (`mr_*`) or a failed turn
(`turn_failed`, `sandbox_unavailable`, ...); never while a turn runs. It waits for the outcome and prints it; with `pushed` it prints the branch, the MR title
and a link to open the merge request (GitHub's compare page for `github.com`, GitLab's new merge
request form otherwise; only the branch when the `origin` URL cannot be parsed).

1. Target: `git fetch origin <base>` (60 s) when `origin` exists, target `origin/<base>`, else the
   local `<base>`.
2. Snapshot of the reviewed change: the working tree blob hash of every Patch path against
   `base_commit` (`absent` for a deleted file), in `mr-snapshot.json`. A retry (the same
   `needs_human` with `mr_attempts > 0` condition) keeps the snapshot.
3. State `preparing_mr`, `mr_attempts + 1`, one turn in the same session with the MR deny list and
   `mrPrompt` (`src/prompts.ts`): target, previous error on a retry, the instructions, and the
   Handbook's `## Git rules` and `## MR template` verbatim. The instructions:
   - stage the files of the reviewed change by path, never `git add -A`, `git add .` or
     `git add -u` (inside the sandbox `git status` shows placeholder files such as `.bashrc`,
     `.gitconfig`, `.idea` and `.mcp.json` as untracked; they are not part of the change);
   - commit by the rules; when the branch already has a commit on top of the target (a second
     approve after a diff-check review), amend it with `git commit --amend` instead of adding one;
   - `git rebase <target>`, resolve conflicts, run the checks;
   - write `.software-factory/<ticket>.mr.md`, its title exactly the commit subject;
   - use `git rev-parse --abbrev-ref HEAD` for the current branch (`git branch` is denied).
4. Verification, the first failure wins, each ending in `needs_human`:

   | Code | Meaning |
   |---|---|
   | `mr_branch_mismatch` | `HEAD` is not on the branch |
   | `mr_rebase_in_progress` | a rebase (or a Git lock) is still in progress |
   | `mr_dirty` | uncommitted changes outside `.software-factory/` |
   | `mr_not_rebased` | the target commit is not an ancestor of the branch |
   | `mr_commit_count` | not exactly one commit on top of the target |
   | `mr_commit_header` | the subject breaks `commitHeader(ticket)` in `src/rules.ts`: `<type>(<ticket>): <summary>`, type one of `feat fix chore refactor docs test perf build ci style revert`, at most 72 characters, no trailing period |
   | `mr_text_missing` | `.software-factory/<ticket>.mr.md` absent or empty |
   | `mr_text_invalid` | over 64 KiB, a first line that breaks the header rule or differs from the commit subject, or a missing `## What`, `## Why`, `## How`, `## Why the change`, `## Special things to note`, `## Change outline`, `## Testing` or `## Checklist` heading |
   | `mr_push_protected` | the branch is `main`, `master` or the job's base: nothing is pushed there directly, every change goes through a merge request |
   | `mr_push_failed` | `git push origin <branch>:<branch>` failed (120 s; stderr in the message) |
   | `mr_failed`, `mr_serve_restarted` | the factory failed, or `sf serve` restarted, during preparation |

   A failed turn keeps its own code (for example `turn_failed` or `sandbox_unavailable`). Fix with
   `sf say` or by hand and run `sf approve` again.
5. Diff check: `git diff --name-only <target> <branch>` must list exactly the snapshot's paths with
   the snapshot's hashes. Otherwise `base_commit` and `target_commit` become the target commit, a
   new iteration is published (the Implementer's report plus `## MR preparation` naming the paths
   that differ; the Patch against the target) and the job goes back to `awaiting_review`. After
   Clean, the next `sf approve` has nothing to commit or rebase and pushes.
6. Push: `git push origin <branch>:<branch>`; the MR text is copied to `mr.md`, `target_commit` is
   set and the job is `pushed`.

## Notifications

On `ready_for_human_review`, `needs_human`, `pushed` and `failed` (iterations are silent) the
factory sends a desktop notification (`notify-send --app-name="Software Factory" "<ticket>:
<state>" <body>`, 5 s, when `notify-send` is on `PATH`) and, with `SF_NTFY_URL` set, one ntfy POST
(10 s; headers `Title`, `Priority` high for `needs_human` and `failed`, `Tags`). The body has at most
three lines: the branch, the error, or the MR title and link when pushed. A failure never changes
the job; it is appended to `events.jsonl` as `{type: "notify_failed", channel, message}` and shown
by `sf watch`. `sf notify-test` sends one test notification on both channels and prints what each
did.

ntfy is a push notification service: install the ntfy app on the phone and subscribe to a topic
name of your choice, then set `SF_NTFY_URL` to that topic's URL (for example
`https://ntfy.sh/<topic>`). On the free public server the topic name is the only secret, so make it
long and unguessable.

State layout under `${SF_STATE_DIR}`:

```
sf.sock                                  # 0600, while sf serve runs; one JSON request/response per connection
dashboard-token                          # 0600, the dashboard token of the last sf serve start
jobs/<workspace>/<ticket>/job.json       # workspace, ticket, branch, base, base_commit, target_commit, mr_attempts, state, iteration, session_id, created_at, updated_at, error
jobs/<workspace>/<ticket>/events.jsonl   # {ts, iteration, message | prompt | state | type: "notify_failed"}; what sf watch reads
jobs/<workspace>/<ticket>/iterations/NNN/{report.md,patch.diff,meta.json}
jobs/<workspace>/<ticket>/mr-snapshot.json   # the reviewed change at approve: target and blob hash per path
jobs/<workspace>/<ticket>/mr.md              # the MR text, once pushed or after a diff-check iteration
jobs/<workspace>/<ticket>.<timestamp>/   # an archived earlier job
```

`iteration` in `job.json` counts published iterations; `updated_at` is the time of the last state
change (`since` in `check`).

## Dashboard

A read-only page served by `sf serve` on a second loopback listener,
`http://127.0.0.1:${SF_DASHBOARD_PORT:-8788}/d/<token>/`, separate from the MCP port so the
tunnel never reaches it. At every start `sf serve` writes a new random token (32 bytes, hex) to
`${SF_STATE_DIR}/dashboard-token` (0600) and prints the URL; `sf dashboard` prints it again from
that file and `SF_DASHBOARD_PORT`. The token changes on every `sf serve` start, so an open page
stops working after a restart until it is reopened with the new URL. Any path without the right
token answers 404 with an empty body.

Version 1 shows, live: every job with its state; for the selected job (the most recently updated
one, or `#<workspace>/<ticket>` in the URL) the branch, base, state, iteration, cost and error,
the state history, each iteration's Report and Patch, the MR text once there is one, and the
Implementer's event stream as `sf watch` prints it, following new lines (scrolling up switches
follow off). It changes nothing: there is no write endpoint; approve, abort and say stay in the
terminal (version 2 adds them). The page is plain HTML, CSS and JavaScript from `static/`, with no
external resources, under `Content-Security-Policy: default-src 'none'; script-src 'self';
style-src 'self'; connect-src 'self'; img-src 'self'` and `Cache-Control: no-store`.

Endpoints under `/d/<token>/`, GET only (anything else 405):

| Path | Answer |
|---|---|
| `api/jobs` | `{jobs: [...]}`: workspace, ticket, branch, base, state, iteration, mr_attempts, updated_at, created_at, error |
| `api/jobs/<ws>/<ticket>` | `{job, iterations: [{number, started_at, ended_at, cost_usd, changed_files, patch_truncated, denials}], mr, history: [{ts, from, to, error?}]}` |
| `api/jobs/<ws>/<ticket>/iterations/<n>/report` | the Report, `text/markdown` |
| `api/jobs/<ws>/<ticket>/iterations/<n>/patch` | the Patch, `text/x-diff` |
| `api/jobs/<ws>/<ticket>/mr` | the MR text, `text/markdown`; 404 until there is one |
| `api/stream?job=<ws>/<ticket>&from=<line>` | server-sent events: `jobs` (on connect and on every state change), `job` (the job's detail, on connect and when it changes state), `event` (`{line, ts, iteration, type, text}` for every visible line of `events.jsonl` from the 0-based `from`, as `sf watch` formats it); a comment every 15 s; at most 8 streams, then 503 |

Invalid workspace or ticket names and unknown jobs are 404.

## Workspace registry

`<config dir>/workspaces.json`, written by `sf workspace add|remove`:

```json
{ "workspaces": { "my-app": { "read_checkout": "/abs/path", "work_checkout": "/abs/path" } } }
```

Names are 1-64 characters of `a-z`, `0-9` and `-`, starting and ending with a letter or digit.
Both paths must be absolute and, whenever a tool uses them, the root of a non-bare Git work tree.
An invalid file is an error, never ignored. `read_file` and `search` use the read checkout;
`write_task` writes `.software-factory/<ticket>.md` in the work checkout and adds
`.software-factory/` to its `.git/info/exclude`.

## History

`factory/` replaced the bridge of SF-001 to SF-010: one process with a Workspace registry instead of
a single fixed repository root, Task files instead of instructions under `factory-data/` and
dispatch to a separate gateway, and an Agent SDK session instead of a file-based execution loop.
The file reader is a copy of the bridge's. SF-011-e removed the bridge; the factory took over its
port 8787 behind the tunnel (see `docs/design/SF-011-factory.md`).
