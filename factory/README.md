# software-factory

The local factory process. It serves MCP tools to the Context owner (ChatGPT or any MCP client)
and provides the `sf` command. How to work with it is in [HANDBOOK.md](HANDBOOK.md); the
vocabulary is in [../CONTEXT.md](../CONTEXT.md).

It provides the planning tools (`guide`, `read_file`, `search`, `write_task`) and the execution
tools (`start`, `check`, `request_fix`, `mark_clean`). The Implementer runs as a headless Claude
Agent SDK session (`@anthropic-ai/claude-agent-sdk`, pinned in `package.json`) in the work checkout.
Approve, abort, reset, MR preparation and notifications follow.

## Commands

```sh
npm install && npm run build      # once, inside factory/
bin/sf workspace add <name> --read <path> [--work <path>]   # --work defaults to --read
bin/sf workspace list
bin/sf workspace remove <name>
bin/sf serve                      # foreground; Ctrl+C stops it
bin/sf start <workspace> <ticket> # start the job (same as the start tool); needs sf serve
bin/sf say <workspace> <ticket> <message...>   # a user message into the session; needs sf serve
bin/sf status [<workspace> <ticket>]           # one job or all jobs; works without sf serve
bin/sf watch <workspace> <ticket> [--once]     # the session live; works without sf serve
npm run typecheck && npm test
```

Exit codes: 0 ok, 1 error, 2 usage.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SF_PORT` | `8788` | Port of `http://127.0.0.1:<port>/mcp` (loopback only, Host and Origin checked). |
| `SF_CONFIG_DIR` | `${XDG_CONFIG_HOME:-~/.config}/software-factory` | Directory of the workspace registry. |
| `SF_HANDBOOK` | `factory/HANDBOOK.md` | Handbook served as instructions (its `## Quick start` section) and by `guide`. |
| `SF_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/software-factory` | Job state and the `sf.sock` socket. |
| `SF_CHECK_AFTER_START_MIN` | `15` | `check_after_minutes` returned by `start` and by `check` during the first iteration. |
| `SF_CHECK_AFTER_FIX_MIN` | `5` | `check_after_minutes` returned by `request_fix` and by `check` during later iterations. |
| `SF_MAX_TURNS` | `150` | `maxTurns` of every Implementer turn. |
| `SF_MAX_ITERATIONS` | `5` | Published iterations after which `request_fix` is refused (`iteration_limit`, job `needs_human`). |
| `SF_CLAUDE` | bundled binary | Absolute path of the Claude Code executable (`pathToClaudeCodeExecutable`). |

The socket path `${SF_STATE_DIR}/sf.sock` must fit a Unix socket address (107 bytes on Linux);
a longer one is refused at start with `socket_path_too_long`.

The execution variables are read once when `sf serve` starts. `sf status` and `sf watch` read
`SF_STATE_DIR` themselves; `sf start` and `sf say` use it to find the socket.

## Jobs

One job per ticket, one active job (`starting`, `working`, `awaiting_review`) per machine.

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
  (`permission_mode_mismatch`) or the iteration limit put the job in `needs_human`. When `sf serve`
  starts, jobs found `working` become `needs_human` (`serve_restarted`) and keep their session for
  `sf say`. Nothing is retried automatically.

Every turn runs with `cwd` = work checkout, `permissionMode: "auto"`, `settingSources: ["user",
"project"]`, the deny list of `src/session.ts` (mutating Git commands, `sudo`, `EnterWorktree`,
`.git/**` edits, `.env` files) and a filtered environment (no `SF_*`, no inherited Claude Code
session markers).

State layout under `${SF_STATE_DIR}`:

```
sf.sock                                  # 0600, while sf serve runs; one JSON request/response per connection
jobs/<workspace>/<ticket>/job.json       # workspace, ticket, branch, base, base_commit, state, iteration, session_id, created_at, updated_at, error
jobs/<workspace>/<ticket>/events.jsonl   # {ts, iteration, message | prompt | state}; what sf watch reads
jobs/<workspace>/<ticket>/iterations/NNN/{report.md,patch.diff,meta.json}
jobs/<workspace>/<ticket>.<timestamp>/   # an archived earlier job
```

`iteration` in `job.json` counts published iterations; `updated_at` is the time of the last state
change (`since` in `check`).

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

## Replacing `bridge/`

`factory/` replaces the SF-001 to SF-010 bridge: one process with a Workspace registry instead of a
single fixed repository root, Task files instead of `factory-data/` instructions and dispatch to
OpenClaw, and an Agent SDK session instead of the file-based supervisor. It shares no code
with `bridge/` (the file reader is a copy). Until the switch both run side by side: the bridge on
port 8787 behind the tunnel, the factory on 8788; the switch moves the tunnel to the factory and
`bridge/` is deleted afterwards (see `docs/design/SF-011-factory.md`).
