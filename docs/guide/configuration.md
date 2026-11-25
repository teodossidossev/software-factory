# Configuration

This page lists every setting you can change: the environment file, the workspace registry, the
norms, the rules files, the queue and the Task file's front matter, each with its meaning, default, allowed
values and an example, as the code of this version reads them.

## Where the settings live

| What | Where | Read |
| --- | --- | --- |
| Environment settings (`SF_*`, tokens) | `~/.config/software-factory/auth.env`, or the environment | by every `sf` command at its start |
| The MCP token | `~/.local/state/software-factory/mcp-token` | by `sf serve` on every MCP request; printed with `sf mcp-url` |
| Workspaces | `~/.config/software-factory/workspaces.json` | at every use (an edit applies at once) |
| The norms (slice size, lead-time targets, decision documents) | `~/.config/software-factory/norms.json` | at every use; shown with `sf norms` ([Norms](#norms-normsjson)) |
| Your own coding rules | `~/.config/software-factory/rules/<workspace>.md`, `rules/global.md` | at each job's Start |
| The guard's private list | `~/.config/software-factory/guard-terms.txt` | at every check of the guard ([The guard](#the-guard)) |
| The queue (order, limit, hold, limit rule) | `~/.local/state/software-factory/queue.json` | by `sf serve`; changed with `sf queue` or the board |
| A ticket's plan | `.software-factory/<ticket>.md` in the workspace's checkout | at Start, by the Task check and the queue |
| The agents' skills by role | `~/.local/state/software-factory/skill-roles.json` | at each job's Start, each Task check's start, and by `sf serve` for planning; changed with `sf skills set` ([The agents' skills](#the-agents-skills)) |

`~/.config/software-factory` is the **config directory**: `SF_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/software-factory`, else `~/.config/software-factory`.
`~/.local/state/software-factory` is the **state directory**: `SF_STATE_DIR`, else
`$XDG_STATE_HOME/software-factory`, else `~/.local/state/software-factory`.

## The environment file (auth.env)

Every `sf` command first reads an environment file (the name `auth.env` is historical: it holds all
settings, not only credentials).

- **Path**: `SF_ENV_FILE` when set (an empty value means no file at all), else
  `<config directory>/auth.env`. The path is worked out before the file is read, so `SF_ENV_FILE`,
  `SF_CONFIG_DIR` and `XDG_CONFIG_HOME` written inside the file cannot move the file itself (an
  `SF_CONFIG_DIR` in it still moves the registry and the rules folder).
- **Syntax**: one `KEY=VALUE` per line; blank lines and lines starting with `#` are skipped; an
  optional `export ` in front; spaces around `=` are allowed; one pair of matching `"…"` or `'…'`
  quotes around the value is removed. There are no escapes and no comments after a value
  (`A=b # c` is the value `b # c`). Any other line (for example one without `=`) stops every `sf`
  command with `invalid_env_file`. A missing file is fine.
- **Priority**: a variable already set in the environment wins over the file, even when it is set
  to the empty string.
- **When it applies**: `sf serve` reads its settings once at start, and each job's runner keeps the
  settings it started with. Change a value, then restart `sf serve` (see
  [Operations: updating](operations.md#updating-the-factory)). `sf check-task`, `sf rules`,
  `sf info`, `sf notify-test` and `sf smoke` read the file in their own process.
- **Who sees the values**: the Implementer, the Claude review and the Task check get no `SF_*`
  variable; the Codex gate gets the environment without any `SF_*` variable; the Git host tokens
  never reach any child process and are never logged.
- **Invalid values**: a number out of range or an unknown value of a choice stops `sf serve` (and
  `sf run`, `sf check-task`) with `sf: <message>` (`invalid_config`); `sf info` shows `invalid: …`.
  The on/off switches are not checked: only exactly `off` turns off `SF_REVIEW`, `SF_SIMPLIFY`,
  `SF_SANDBOX`, `SF_DASHBOARD` and `SF_DESKTOP_NOTIFY` (so `Off` means on), and only exactly `on`
  turns on `SF_NOTIFY_ITERATIONS`.
- **Numbers**: a "positive integer" is digits only (`5`, not `+5` or `5.0`), at least 1 and at most
  100000 unless the row says otherwise.

An example file:

```sh
# ~/.config/software-factory/auth.env
SF_MAX_TURNS=300
SF_REVIEW_MODEL=sonnet
SF_GATE_MAX_ROUNDS=3
SF_NTFY_URL=https://ntfy.sh/my-long-unguessable-topic
SF_GITHUB_TOKEN=<your fine-grained token>
```

Keep it private: `chmod 600 ~/.config/software-factory/auth.env`. `sf info` prints the settings in
effect and says only whether each token is set.

### Limits

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_MAX_TURNS` | `150` | positive integer | Steps (tool calls and answers) of one Implementer turn. A big ticket may need more, for example `SF_MAX_TURNS=300`. |
| `SF_FIX_SESSION` | `resume` | `resume`, `fresh`, `alternate`, empty | The Implementer session of a job's fix rounds. `resume`: the job's one session goes on. `fresh`: each fix round (a reviewer's or the gate's Fix, yours, Must fix, Tests, Guard, Simplify) starts a new session, given the fix command, the job's rules, the previous iteration's Report and its changed files; your messages, Resume and MR preparation go on in the current session. `alternate`: `fresh` or `resume` per ticket, the same ticket always the same. A Task file's `fix_session: fresh` or `fix_session: resume` wins over the setting; any other value is ignored. Decided once, at Start. |
| `SF_TURN_LIMIT_CONTINUES` | `1` | `0` to `10` | How many times the factory says "continue" by itself, per chain of turns, after a turn used all its steps while still changing files. `0` stops at the first limit (`max_turns`). |
| `SF_TOOL_STALL_MIN` | `10` | `0` to `60` | Minutes a Bash command of the Implementer may stay open with no process of it running (looked at once a minute) before the factory ends the turn and sends the turn's instruction again, with a note naming the hung command. A command that still runs is never cut before 65 minutes. A second hang in the same chain stops the job (`tool_stalled`). `0` turns the watch off. |
| `SF_MAX_ITERATIONS` | `3` | positive integer | Rounds without progress a job may have: review rounds that ask for a Fix while no fewer blocker and major findings are open than after any earlier round that asked for one, or that reopen a fixed or left finding. The first round with a Fix sets the low and does not count. The round that reaches the limit stops the job (`iteration_limit`) instead of its Fix; a round that lowers the open findings does not count, so a job that converges goes on. At the stop you may Accept the iteration as it is, whatever the last verdict, with its open findings listed on the Merge request screen, or Tell it to go on: your message starts the count again. Your messages do not count, nor the Tests Fix sections of the workspace's test command (at most two per job, then `tests_failed`). A ticket with `important: true` is never stopped by it. |
| `SF_QUICK_FIX_MAX_LINES` | `30` | positive integer | The added plus deleted lines a quick fix (`sf quickfix`) may change since the hand-over, your checkout's edits included, and still go to MR preparation without a review round; over it, the job goes through the full loop and says so. |
| `SF_QUICK_FIX_MAX_FILES` | `2` | positive integer | The files a quick fix may change since the hand-over and still skip the review round; over it, the full loop. |
| `SF_TEST_TIMEOUT_MS` | `1800000` (30 min) | 1 to 14400000 (4 h) | How long one run of a workspace's `test_command` may take; then it is killed, and the run counts as a failure (a Tests Fix that says it timed out). |
| `SF_CHECK_AFTER_START_MIN` | `15` | positive integer | `check_after_minutes` the job status reports during the first iteration (a hint for a polling client; the dashboard does not need it). |
| `SF_CHECK_AFTER_FIX_MIN` | `5` | positive integer | The same hint for later iterations. |

### Reviewers and the Task check

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_REVIEW` | on | `off` | `off` runs no Claude review and no gate: an iteration waits in `awaiting_review` until you send a message or abort. |
| `SF_CLAUDE_REVIEW` | `ticket` | `ticket`, `always`, empty | `ticket`: the Claude review runs only on tickets whose Task file says `review: claude`; the Codex gate alone reviews the others. `always`: every ticket but those that say `review: codex`. Decided when a job starts. With the gate off, Claude reviews every job. |
| `SF_REVIEW_MAX_TURNS` | `60` | positive integer | Steps of a Claude review; the simplification pass uses it too. |
| `SF_SIMPLIFY` | on | `off` | The simplification pass after a clean verdict of a job that had fix rounds. `off` goes straight to MR preparation. |
| `SF_FINDINGS_CHECKLIST` | `on` | `on`, `off`, empty | `on`: once a day `sf serve` distils each workspace's findings checklist (`~/.local/state/software-factory/findings/<workspace>.md`) again when it is missing or older than 7 days and at least 10 real findings are newer: generic checks from the Claude review's and the Codex gate's blocker and major findings of the last 30 days that were fixed, each backed by at least 3 findings from 2 jobs, made with `SF_REVIEW_MODEL`; a failure keeps the old file. `off`: no refresh. `sf findings distill <workspace>` distils it now (fewer than 10 findings, or no check kept, writes nothing and keeps the old file); `sf findings show <workspace>` prints it and its age. |
| `SF_TASK_CHECK_AUTO` | `on` | `on`, `off`, empty | `on`: `sf serve` checks a written Task file 60 s after its last change. `off`: only Check on the board and `sf check-task`. |
| `SF_TASK_CHECK_PARALLEL` | `1` | `1` to `4` | Automatic Task checks that run at once over all workspaces. |
| `SF_TASK_CHECK_CODEX` | `off` | `auto`, `off`, empty | `auto`: a Task not written by ChatGPT's `write_task` (the Claude Code planner's, one you wrote, a file written by hand) is checked by Codex too, at the same time; the plan is ready only when both checks are; a Codex failure holds nothing. `off`: the Claude check alone. |
| `SF_TASK_CHECK_FOLLOW_UP` | `on` | `on`, `off`, empty | `on`: an automatic re-check of a Task file revised after a not-ready Claude check, at the same commit (or after base commits outside its scope), with an unchanged builds_on chain and at most 40% of its lines changed, starts from that check's findings and the Task file's diff; it verifies each earlier finding and the changes, and an earlier finding it does not resolve stays. After two such re-checks in a row the next is full. Check on the board and `sf check-task` are always full. `off`: every check is full. |
| `SF_TASK_CHECK_MAX_TURNS` | `30` | positive integer | Steps of a Task check. |

### The Codex gate

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_GATE` | `codex` | `codex`, `off`, empty | `codex` runs the Codex CLI in the same round as the Claude review, at the same time, or alone on a job without the Claude review (`SF_CLAUDE_REVIEW`); `off` lets the Claude verdict decide, on every job. With `codex` and no Codex found, the gate is off and `sf serve` prints `gate: off (…); the Claude review decides`. |
| `SF_CODEX` | `codex` on `PATH` | absolute path | The Codex executable. A relative path is refused (`invalid_config`); a path that is not an executable file turns the gate off (`PATH` is then not searched). |
| `SF_GATE_MAX_ROUNDS` | `5` | positive integer | Rounds without progress (as for `SF_MAX_ITERATIONS`) whose Fix the gate asked for, its first fix never counted, per job on a job with the Claude review; the gate fix of the round that reaches the limit is not applied (`gate_rounds`), unless the Claude review of the same round gives a fix, which then applies alone. Your message at the stop starts the count again. On a job without the Claude review, `SF_MAX_ITERATIONS` limits the rounds instead. A ticket with `important: true` is never stopped by it. |
| `SF_GATE_MAX_TOKENS` | `5000000` | 1 to 1000000000 | The gate's token budget for every started 2,000 changed lines of the job's change (input plus output tokens of all its gate runs): a change of up to 2,000 lines gets this, one of 2,500 lines twice this. At the budget no gate starts (the Claude review runs alone) and a clean round stops the job (`gate_budget`); your message at the stop gives a new budget from the tokens used so far. A ticket with `important: true` is never stopped by it. |
| `SF_GATE_TIMEOUT_MS` | `900000` (15 min) | 1 to 86400000 | How long one gate run may take; then it is killed (`gate_failed`). |
| `SF_GATE_LEVEL` | `auto` | `auto`, `full`, empty | On a job with the Claude review, `auto` picks `full`, `light` (one round) or `none` (documentation only) from the risk of the change, and `full` runs the gate in every round. A job without the Claude review gets `full` on every iteration, whatever this says: the gate is its only reviewer. |
| `SF_GATE_FULL_PATHS` | empty | comma-separated globs | Changed paths that always make the gate level `full`, for example `src/billing/**,migrations/**`. |

### Models

| Key | Default | Meaning |
| --- | --- | --- |
| `SF_MODEL` | Claude Code's default | Model of every Implementer turn, passed as is (`opus`, `sonnet`, a full model id). |
| `SF_REVIEW_MODEL` | Claude Code's default | Model of the Claude review, the simplification pass and the Task check. |
| `SF_CODEX_MODEL` | Codex's default (your `~/.codex/config.toml`) | Model of the gate, passed as `--model`. |
| `SF_SMOKE_MODEL` | `haiku` | The Claude model of `sf smoke` (Implementer, review, Task check). |
| `SF_SMOKE_CODEX_MODEL` | Codex's default | The gate's model in `sf smoke`. |
| `SF_CLAUDE` | the Claude Code binary bundled with the Agent SDK | Absolute path of another Claude Code executable. A relative path is refused. |

### Sandbox and marked paths

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_SANDBOX` | on | `off` | `off` runs the Implementer, the reviews, the simplification pass and the Task check without Claude Code's sandbox: the path denials then hold for the tools only, not for commands ([the trust model](trust-model.md)). Leave it on. |
| `SF_SANDBOX_DOMAINS` | empty | comma-separated host names, `*.` allowed in front | Extra hosts sandboxed commands may reach besides `registry.npmjs.org`, for example a private registry your tests need: `npm.example.com,*.pkg.example.com`. |
| `SF_SANDBOX_ALLOW_READ` | empty | comma-separated paths relative to the home directory, no `..`, no `~`, not absolute | Toolchain folders of your home directory a job's sandboxed commands may read besides the kept ones (the Node toolchains, Git's configuration), for example `.m2/repository,.gradle/caches`. An entry that is, holds or lies in a denied path (`.ssh`, `.config`), or that is or holds the home directory itself (`.`, a link to it), stops the session with `invalid_config` ([the trust model](trust-model.md#the-home-directory)). |
| `SF_SENSITIVE_PATHS` | empty | comma-separated globs | Paths added to the built-in sensitive paths (manifests, lockfiles, CI, IDE and agent files, root dotfiles). A sensitive path the Task's `may_touch` does not name must be accepted by a reviewer. |

### Hand-over

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_HANDOFF` | `checkout` | `checkout`, `off`, empty | `checkout`: a ready job is handed over to the workspace's checkout by itself; `off`: it waits in `ready_for_human_review`. A workspace's own `handoff` wins ([below](#the-workspace-registry-workspacesjson)). |

### Rules budget

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_RULES_MAX_BYTES` | `49152` (48 KiB) | positive integer up to 16 MiB | The most bytes of rules-file content the agents are given ([Coding rules](#coding-rules)). |

### Dashboard, ports and paths

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_PORT` | `8787` | `0` to `65535` (`0`: any free port) | Port of the MCP server, `http://127.0.0.1:<port>/mcp/<token>` ([The MCP token](#the-mcp-token-mcp-token)). The tunnel script uses the same port (it asks `sf mcp-url --port`). With `0`, `sf mcp-url` and the tunnel script ask the running `sf serve` for the port it bound; without one they stop with `mcp_port_unknown`. An invalid value is `invalid_port`. |
| `SF_DASHBOARD_PORT` | `8788` | `0` to `65535` | Port of the dashboard, `http://127.0.0.1:<port>/d/<token>/`. Opening that URL sets the cookie `sf_dashboard_<port>` (`HttpOnly`, `SameSite=Strict`), so `http://127.0.0.1:<port>/` works without the token until the token changes. `sf serve` prints the URL with `<token>`; `sf dashboard` prints it in full. |
| `SF_DASHBOARD_REMOTE_ORIGINS` | none | comma-separated `https://<machine>.<tailnet>.ts.net` origins | The addresses of your `tailscale serve` ([The dashboard on your phone](operations.md#the-dashboard-on-your-phone-tailscale)). With them a second listener opens on `SF_DASHBOARD_REMOTE_PORT`, the only one that accepts them; the token (or its cookie) stays required. Anything else (http, another domain, a port or a path) is refused at `sf serve`'s start with `invalid_config`. Read at start. |
| `SF_DASHBOARD_REMOTE_PORT` | `8789` | `0` to `65535`, not `SF_DASHBOARD_PORT`'s value (unless both are `0`) | The remote listener's port on `127.0.0.1`, where `tailscale serve --bg 8789` points. Its token visit sets the cookie `__Host-sf_dashboard` (`HttpOnly`, `Secure`, `SameSite=Strict`), so the phone can bookmark `https://<machine>.<tailnet>.ts.net/`. Approve, Retry, Create merge request, Merge, Merged — archive and Archive from it need the job's ticket typed again (`confirm_required` without). Read only with `SF_DASHBOARD_REMOTE_ORIGINS`; the same port as the dashboard's is `invalid_config`, a taken one `port_in_use`. |
| `SF_DASHBOARD_REMOTE_LOGINS` | none (required with `SF_DASHBOARD_REMOTE_ORIGINS`) | comma-separated Tailscale logins, compared ignoring case | Who may use the remote port: its every request needs Tailscale's `Tailscale-User-Login` header with a listed login; anything else (a tagged device, Funnel) is an empty 403 and one log line naming the login or `none`. Missing or empty with remote origins is `invalid_config` at start. |
| `SF_DASHBOARD` | on | `off` | `off` starts no dashboard and removes the saved token. |
| `SF_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/software-factory` | path | Jobs, the queue, the socket `sf.sock`, the dashboard token, the MCP token. The socket path must fit 107 bytes (`socket_path_too_long`). |
| `SF_WORKTREE_ROOT` | `<state dir>/worktrees` | absolute path | Where each job's worktree is created: `<root>/<workspace>/<ticket>`. |
| `SF_PLANNING_DIR` | `~/planning` | absolute path | Where `sf planner setup` keeps each workspace's planning copy, `<dir>/<workspace>`, and the planners' prototypes, `<dir>/prototypes/<workspace>/<ticket>/`; a workspace named `prototypes` gets no planning copy. Under your home directory the factory's job sandboxes cannot read it. `sf serve` reads it too, for the prototypes it serves: set it in `auth.env`, since the service copies none from your shell. |
| `SF_PLANNER_TRUST` | `ask` | `ask`, `auto`, empty | Who accepts Claude Code's trust dialog for a planning copy. `ask`: you do, once per copy, with `sf planner trust <workspace>`; `sf planner start` refuses a copy Claude Code does not trust yet. `auto` is your consent, given once: `sf planner setup`, and `sf planner start` for a copy not trusted yet, open Claude Code in the factory's own planning copy in a terminal of their own and accept the dialog as you would, so Claude Code saves the answer itself; only for the folder `sf planner setup` made, and only while it holds none of the repository's Claude Code configuration. Read by those two commands; anything else stops them (`invalid_config`). |
| `SF_CONFIG_DIR` | `${XDG_CONFIG_HOME:-~/.config}/software-factory` | path | `workspaces.json`, `auth.env` and `rules/`. |
| `SF_COORDINATOR_WORKSPACE` | `software-factory` | a workspace name | The workspace whose checkout holds your coordinating Claude Code session: the Skills page's Coordinator column and `sf skills set coordinator` switch its skills in `<checkout>/.claude/settings.local.json` ([The Skills page](#the-skills-page)). Not registered: the column has no boxes (`no_coordinator_workspace`). |
| `SF_ENV_FILE` | `<config dir>/auth.env` | path, or empty for none | The environment file (above). |
| `SF_HANDBOOK` | `factory/HANDBOOK.md` | path | The Handbook served to the Context owner. |
| `SF_TUNNEL_SCRIPT` | `scripts/sf-tunnel.sh` of the clone | path | The tunnel script `sf up` starts. |
| `SF_TUNNEL_HEALTH` | `127.0.0.1:8790` | `host:port` | Where `sf info` asks the tunnel client whether it is ready (`/readyz`). |

### The ChatGPT tunnel (scripts/sf-tunnel.sh)

The tunnel wrapper `scripts/sf-tunnel.sh` reads three settings of its own (and `XDG_CONFIG_HOME`
for their defaults). It is a shell script, not an `sf` command: it reads them from its environment
only. The steps that need the MCP token it leaves to the `sf` CLI (`sf mcp-url`), which reads
`auth.env` itself, so `SF_PORT` and `SF_STATE_DIR` set only there count. Started by `npm start` (`sf up`) it inherits the environment of `sf`, which includes the
values from `auth.env`; started by `npm run tunnel` or by hand it does not read `auth.env`, so
export them in that shell. Give `init`, `set-key`, `check` and `run` the same values: `check` (and
so `run`) refuses a profile whose key reference is not the current key file.

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_TUNNEL_KEY_FILE` | `${XDG_CONFIG_HOME:-~/.config}/software-factory/tunnel-runtime.key` | a file path | The file that holds the tunnel's runtime key. `set-key` writes it (mode 0600, its directory 0700), `init` writes a `file:<path>` reference to it into the profile, and `check` requires it to exist, be non-empty, have mode 600 and not hold a `tunnel_id`. Example: `SF_TUNNEL_KEY_FILE=/home/you/.secrets/sf-tunnel.key`. |
| `SF_CLI` | `factory/bin/sf` of the script's own repository | a path to an `sf` executable | The CLI the wrapper calls for `sf mcp-url`. Without it the factory must be built (`factory/dist/src/cli.js`); else the wrapper says to run `npm run setup`. |
| `TUNNEL_CLIENT_PROFILE_DIR` | `${XDG_CONFIG_HOME:-~/.config}/tunnel-client` | a directory path | The directory of tunnel-client profiles; the wrapper's profile is `<dir>/software-factory.yaml`, created by `init` and read by `check`, `doctor` and `run` (passed to `tunnel-client` as `--profile-dir`). Example: `TUNNEL_CLIENT_PROFILE_DIR=/home/you/.config/tunnel-client-work`. |

For example, to keep both in another place:

```sh
export SF_TUNNEL_KEY_FILE=/home/you/.secrets/sf-tunnel.key
export TUNNEL_CLIENT_PROFILE_DIR=/home/you/.config/tunnel-client-work
scripts/sf-tunnel.sh init tunnel_<your id>
scripts/sf-tunnel.sh set-key
scripts/sf-tunnel.sh check
```

The MCP URL follows `SF_PORT`: `init` gives tunnel-client `http://127.0.0.1:<port>/mcp`, and
`init`, `run` and `doctor` set the profile's MCP `url` line to `http://127.0.0.1:<port>/mcp/<token>`
(`sf mcp-url --write-profile`). The health address `127.0.0.1:8790` is fixed in the script (`sf
info` reads it through `SF_TUNNEL_HEALTH`). See the [connection runbook](../runbooks/chatgpt-connection.md).

### The MCP token (mcp-token)

The MCP endpoint answers only a request with the factory's MCP token (SF-099): as the path
`http://127.0.0.1:<port>/mcp/<token>`, or as `Authorization: Bearer <token>` on `/mcp`. Anything
else is `401`.

- **The file**: `mcp-token` in the state directory, mode 0600: 64 lower-case hex digits, the
  dashboard token's format, a value of its own. The first `sf serve` creates it; later starts keep
  it. A file that is not a valid token stops `sf serve` with `invalid_mcp_token` (it is not
  replaced silently: the tunnel would hold the old one). A valid file with a wider mode (`0644`)
  is narrowed to 0600 at the start, with a warning to rotate it (others may have read it); a link,
  a directory or a file of another user in its place stops `sf serve` with `unsafe_mcp_token`.
  While serving, the file is read on every
  request: a file that cannot be read or is invalid refuses every request (`401`, one log line a
  minute at most, naming the error, never a value).
- **`sf mcp-url`** prints the URL with the token, for an MCP client such as Claude Code;
  `--header` prints `http://127.0.0.1:<port>/mcp` and the `Authorization: Bearer` header instead;
  `--port` the port only. Without a token file it fails with `no_mcp_token`: start `sf serve` once.
  The port is `SF_PORT`; with `SF_PORT=0` (any free port) it is the one the running `sf serve`
  bound, asked on its socket, and without a running `sf serve` the command stops with
  `mcp_port_unknown` (`--probe` exits 2: nothing answers). `sf info` then shows `any free port`.
- **Rotating**: `sf mcp-url --rotate` writes a new token over the existing file (an invalid one too),
  with or without a running `sf serve`; without a file it fails with `no_mcp_token` (the first token
  is `sf serve`'s to make). A running `sf serve` answers only the new one from its next request. Restart the tunnel (`npm run tunnel` again, or `sf up`) and give other
  clients the new URL.
- Every other output (`sf serve`'s start lines, `sf info`, logs, the tunnel's lines) shows the URL
  as `/mcp/<token>`, never the value.

### Queue

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_MAX_JOBS` | `3` | positive integer, used as 1 to 20 | The queue's limit `max_running` only while `queue.json` does not exist yet; a value above 20 is taken as 20. After that the limit is changed with `sf queue limit` or the board ([Queue settings](#queue-settings)). |

### Notifications

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_DESKTOP_NOTIFY` | on | `off` | The desktop notification through `notify-send` (when it is on `PATH`). |
| `SF_NOTIFY_ITERATIONS` | off | `on` | Also notify every published iteration (`awaiting_review`). |
| `SF_NTFY_URL` | unset | URL | An ntfy topic for phone notifications, for example `https://ntfy.sh/<a long unguessable topic>`. Unset: no ntfy. |
| `SF_NTFY_TOKEN` | unset | token | Sent as `Authorization: Bearer <token>` to an ntfy server that needs it. |

The factory notifies `ready_for_human_review`, `handed_over`, `needs_human`, `paused`,
`waiting_limit`, `pushed` and `failed`, and an automatic Task check that is not ready.
`sf notify-test` sends one test notification on every channel.

### Push and merge request providers

Pushing needs no factory setting: the factory runs `git push origin <branch>` with your own Git
configuration and credentials (SSH key or credential helper). The tokens below are only for the
merge request actions (`sf mr create`, `sf mr merge`, `sf mr status`, the Merge request screen's
*Push and open MR*).

| Key | Default | Meaning |
| --- | --- | --- |
| `SF_GITHUB_TOKEN` | unset | For workspaces whose `origin` is on `github.com`: a fine-grained token on the repository with Pull requests read and write, Contents read and write (write for merging), Checks read. Sent only to `https://api.github.com`. Unset: the actions are off, `mr_token_missing`. |
| `SF_GITLAB_TOKEN` | unset | For workspaces whose `origin` is on `gitlab.com`, or on the host of `SF_GITLAB_URL`: a token with scope `api`, sent only to that GitLab's API. Any other host gets no token (`mr_host_unsupported`). |
| `SF_GITLAB_URL` | unset (`https://gitlab.com/api/v4` for `gitlab.com`) | Required for a self-hosted GitLab: its API base, such as `https://git.example.com/api/v4`. `https` (or `http` on loopback only); no credentials, query or fragment. Set, the token goes only to this host, and workspaces on other hosts, `gitlab.com` included, are refused (`mr_host_unsupported`). |

`GITHUB_TOKEN`, `GITLAB_TOKEN` and `OPENAI_API_KEY` are not read by the factory. The Codex gate
uses your Codex login (`codex login`), not an API key. `CODEX_HOME` (Codex's own setting, default
`~/.codex`) is read by the factory only to recognise and withhold Codex's home in the logged gate
output; the factory never moves it.

### For tests only

These keys exist for the factory's own tests. Never set them in real use: they point the factory
at fake hosts or open test-only paths. The test suites set them themselves.

| Key | Default | Allowed | Meaning | Example |
| --- | --- | --- | --- | --- |
| `SF_GITHUB_API` | `https://api.github.com` | an `http` or `https` URL without credentials, query or fragment, on loopback only (host `127.0.0.1`, `localhost` or `[::1]`); anything else is refused at start (`invalid_config`); empty means the default | The GitHub API base of the merge request actions, so the tests can use a fake GitHub on loopback; `SF_GITHUB_TOKEN` is then sent there. A trailing `/` is dropped. Read by `sf serve`, the job runners and `sf info`. | `SF_GITHUB_API=http://127.0.0.1:9123` |
| `SF_TEST_HOOKS` | off | exactly `on` turns it on; any other value is off | `sf serve` also answers the socket commands `check` (a job's last Report and Patch), `fix` and `clean` (a reviewer's verdict without a review session), so the end-to-end tests drive the cycle step by step. No `sf` command sends them. It also allows `SF_TEST_TASK_CHECK_DELAY_MS`. | `SF_TEST_HOOKS=on` |
| `SF_TEST_TASK_CHECK_DELAY_MS` | unset: the automatic Task check runs 60000 ms (60 s) after its last trigger | digits only (`0` and up), in milliseconds; read only when `SF_TEST_HOOKS=on` and the automatic checks are on; any other value is ignored | A shorter wait from the last trigger to the automatic Task check, for the tests. | `SF_TEST_HOOKS=on SF_TEST_TASK_CHECK_DELAY_MS=200` |
| `SF_BROWSER_HEADED` | unset: headless | exactly `1` shows the window; any other value stays headless | Read by the browser tests (`factory/test/browser/support.ts`), not by the factory: Chromium opens with a visible window during `npm run test:browser`. | `SF_BROWSER_HEADED=1 npm run test:browser` |

### For running the tests

Read by `factory/scripts/run-tests.mjs` (`npm test`, `npm run test:browser`), not by the factory. Set
them in the shell that runs the tests, not in `auth.env`.

| Key | Default | Allowed | Meaning | Example |
| --- | --- | --- | --- | --- |
| `SF_TEST_CONCURRENCY` | unset or empty: half the cores (`os.availableParallelism()`), rounded down, at least 1 | a positive integer (digits, no sign, no leading zero); anything else stops the run with exit code 2 before a test runs | The number of test files `node --test` runs at once (`--test-concurrency`). | `SF_TEST_CONCURRENCY=4 npm test` |
| `SF_TEST_BUSY_LOAD` | unset or empty: 0.75 times the machine's cores (`os.cpus()`, not a CPU quota's), unrounded (15 on 20 cores) | a positive number, digits with an optional fraction (`12`, `12.5`, `0.5`); anything else (`0`, `.5`, `12.`, `1e3`, `-1`) stops the run with exit code 2 before a test runs | The busy limit of the 1-minute load average. At or above it a run gives way: no further file starts while another file of the run is running, until the load drops below it, so the run starts fewer files at once and always has one running. A file killed at its limit while the load is at or above it gets the retry of a failed file. | `SF_TEST_BUSY_LOAD=10 npm test` |
| `SF_TEST_NICE` | unset or empty: nice 10 | exactly `0`; anything else stops the run with exit code 2 before a test runs | `0` leaves the priority of the tests alone; otherwise `node --test` and every test process it starts run at nice 10. A priority that cannot be set prints one warning and the tests still run. | `SF_TEST_NICE=0 npm test` |

The full table with every detail is in the reference,
[Environment](../../factory/README.md#environment).

## The workspace registry (workspaces.json)

`<config dir>/workspaces.json` lists your repositories. `sf workspace add` and the dashboard's
**Workspaces** drawer write it; you may edit it by hand (it is read at every use). The parser is
strict: an unknown key, at the top or in an entry, makes the whole file invalid, and `sf serve`
refuses to start (`registry_invalid`).

The top level is `{"workspaces": {<name>: <entry>}}` and, optionally, the morning digest's
`"digest"` settings (below). A **name** is 1 to 64 characters of
`a-z`, `0-9` and `-`, starting and ending with a letter or digit.

| Field | Required | Allowed | Meaning |
| --- | --- | --- | --- |
| `read_checkout` | yes | an absolute path (`~` is not expanded in the file) | Your local checkout: the root of a non-bare Git work tree. Task files live in its `.software-factory/` (added to its `.git/info/exclude`); every job's worktree is created from it; the hand-over checks the branch out in it. |
| `work_checkout` | no | an absolute path | Retired. Still accepted and checked as an absolute path, then ignored: every job uses a worktree of `read_checkout`. When it differs from `read_checkout`, `sf serve` prints one warning. `sf workspace add --work` is refused. |
| `handoff` | no | `"checkout"` or `"off"` | The workspace's own hand-over setting; wins over `SF_HANDOFF`. Use `off` for a checkout that must not be switched to every job's branch. |
| `color` | no | `blue`, `teal`, `green`, `olive`, `orange`, `red`, `purple`, `grey` | The colour of the workspace's stripe and chip on its cards. Without it, one is picked from the name. |
| `label` | no | text, 1 to 24 characters, one line | What the workspace's chip on the dashboard's cards says instead of its name, for names that start alike: `second` for `app-frontend-second`. Without it the chip shows the whole name. Set it with `sf workspace add --label <text>` (`""` removes it) or the drawer's Edit. |
| `notify` | no | `"full"`, `"brief"` or `"off"` | How much the notifications of the workspace's jobs and Task checks tell. `full` (absent): all of it. `brief`: ntfy gets the title, priority and tags and one line, the workspace's name (and an error's code when the job has one; a "plan not ready" Task check keeps its counts); no branch, path, error message, MR title or link. The desktop notification stays full, since it does not leave the machine. `off`: none on either channel. Health, usage limit reset and digest notifications ignore it. Read for each notification, so a change applies to the next one. Set it with `sf workspace notify <name> full\|brief\|off`; the dashboard's Edit keeps it. |
| `rules_skip` | no | a list of paths or globs | Repository rule files not given to the agents ([Coding rules](#coding-rules)). Only by editing the file. |
| `description` | no | text, at most 2,000 characters | What the repository is, for the morning digest. Without it the digest reads the first paragraph of the repository's `README.md` (else its `package.json`'s `description`). When it and the Git data disagree, the data wins. |
| `app` | no | text, 1 to 64 characters | Workspaces with the same app share one daily and are compared in "One ticket across the app" (a backend and its frontend). Without it the workspace is its own app. |
| `digest` | no | `{"track": true/false, "my_work": true/false}` | `track`: follow the repository in the morning digest. `my_work`: your commits and the factory's finished jobs here go into the daily of its app. Absent: both off. |
| `guard` | no | `true` or `false` | `true`: the workspace is public; its pushes and MR texts are checked for the names of your other workspaces and your private list ([The guard](#the-guard)). Absent: `false` (secrets are still checked). Turn it on for `software-factory`. Only by editing the file. |
| `auto_queue` | no | `true` or `false` | `true`: a ticket joins the run queue by itself when a Task check of it ends ready (automatic, or the dashboard's Check) or `write_task` finds it needs no check. The parts of one ticket (`part_of`, `slice`) stand in the order of their numbers. Not when it is already queued, has a live job, is a skeleton, or you removed it from the queue since its Task file last changed. Its history says "Queued by itself after a ready check"; no notification. Absent: `false`, nothing joins by itself. Only by editing the file; the Edit keeps it. |
| `auto_planner` | no | `true` or `false` | `true`: on the dashboard, *Create the ticket* with the Context owner Claude Code does what *Create & plan* does: once the ticket and its images are stored, its planner session starts, so your phone tells you when the planner waits for you; the planning copy must be set up and trusted first. A refused start leaves the ticket created and says why in the dashboard's message; nothing retries; a page closed before the images are up starts nothing. ChatGPT tickets are not affected. Absent: `false`. Set it with `sf workspace auto-planner <name> on\|off`; the dashboard's Edit keeps it. |
| `issue_import` | no | `{"on": true/false, "prefixes": [...], "site": "...", "hook": "..."}` | The factory may read this workspace's Jira issues through Claude Code's Atlassian MCP server (`atlassian`, `https://mcp.atlassian.com/v2/mcp`, which you add and sign in to in Claude Code: the factory stores no Jira token). `prefixes`: 1 to 20 issue key prefixes (`ABC` for `ABC-123`); a key with any other prefix is refused before anything runs. `site`: the Jira site's host (`example.atlassian.net`). `hook`: the absolute path of your PreToolUse allowlist hook for the Atlassian tools, which the factory runs on every call of the read and whose refusal, failure or rewrite refuses the read. The issue's images are listed by name with their links, not attached. Absent or `"on": false`: no import. Only by editing the file; the Edit keeps it. |
| `test_command` | no | a shell command, 1 to 2,000 characters, no NUL | The factory runs it itself (`sh -c` in the job's worktree) before a job is ready: after the clean review, before the MR text. It runs in a sandbox without network, with only the worktree and a private `/tmp` writable and your credentials and the factory's files hidden ([Trust model](trust-model.md)), so the dependencies must already be installed in the worktree. Exit 0 passes; another exit or `SF_TEST_TIMEOUT_MS` sends a `Tests` Fix to the Implementer (twice at most, then `tests_failed`); exit 126 or 127, or no `bwrap` on the machine, is `tests_unavailable`. The result goes into the MR text under `### Checks`. Absent: no run. Only by editing the file; the Edit keeps it. Needs `bwrap` (bubblewrap) installed. |
| `last_review_skill` | no | an absolute path to a folder that holds a `SKILL.md` | A last, advisory review after every clean round follows this skill (your team's way of reading a change): a read-only Claude session on `SF_REVIEW_MODEL` reads the Task file, the job's whole change and the repository and leaves comments; MR preparation commits only once it ended (at most 10 minutes). It never stops the job; a failure is recorded. The folder is copied at the job's first last review, and the job keeps that copy. Absent: no last review. Only by editing the file; the Edit keeps it. |

The top-level `digest` sets the morning digest; every key is optional:

| Field | Default | Meaning |
| --- | --- | --- |
| `times` | `["08:00"]` | 1 to 4 local times (`HH:MM`, 00:00 to 23:59, no time twice, any order) after each of which `sf serve` makes a digest that refreshes the brief. A file with the older `"at": "HH:MM"` still works as one time; a save from the dashboard replaces it with `times`. |
| `weekdays_only` | `true` | No digest on Saturday and Sunday; Monday's covers the weekend. |
| `model` | `"sonnet"` | The model of the digest's session. Only by editing the file. |
| `language` | `"English"` | The language of the digest's text (1 to 40 characters). |

`sf serve` rereads the file at every check (once a minute), so a change applies without a restart.

A full example for two workspaces that the parser accepts (write your real home directory instead
of `/home/you`):

```json
{
  "workspaces": {
    "my-app": {
      "read_checkout": "/home/you/work/my-app",
      "handoff": "checkout",
      "color": "blue",
      "rules_skip": ["docs/internal/**", "CONTRIBUTING.md"]
    },
    "my-api": {
      "read_checkout": "/home/you/work/my-api",
      "handoff": "off",
      "color": "teal",
      "app": "my-shop",
      "description": "The shop's backend: orders and payments.",
      "digest": { "track": true, "my_work": true }
    }
  },
  "digest": { "times": ["07:30", "12:00"], "weekdays_only": true, "model": "sonnet", "language": "English" }
}
```

The same from the command line:

```sh
sf workspace add my-app --read ~/work/my-app --handoff checkout --color blue
sf workspace add my-api --read ~/work/my-api --handoff off --color teal
sf workspace add app-frontend-second --read ~/work/app-frontend-second --label second
sf workspace notify my-api brief
sf workspace list
```

`sf workspace add` resolves the path (so `~` and relative paths work there). Run it again with the
same name and path and `--handoff`, `--color` or `--label` to change those fields; without them it
says `workspace_exists`. `sf workspace remove my-api` removes the registration only (nothing on disk
changes). On the dashboard, the Workspaces drawer adds a workspace (an absolute path), edits one
(**Edit** on its card: the path, the description, the app, the hand-over, the colour, the label and
the two digest switches; the name stays, and the path cannot change while the workspace has a live
job), and removes one that has no live job. Its **Morning digest** section sets `times` (a "Times" field, up
to 4 comma-separated), `weekdays_only` and `language`; the Digest page's schedule line (**Edit**)
sets `times` too. The CLI has no flags for the digest's fields: use the drawer, the Digest page or
edit the file.

## Norms (norms.json)

`<config dir>/norms.json` holds the numbers and lists you tune by hand, for every workspace at once
and per workspace. You edit it; no command writes it. Every key is optional:

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `slice.change_max_lines` | 400 | an integer from 1 to 100000 | the added plus removed lines, tests included, a slice that changes behaviour aims at; up to one and a half times it needs no reason, beyond that the slice is cut again |
| `slice.change_max_files` | 10 | an integer from 1 to 100000 | the most changed files of such a slice |
| `slice.min_lines` | 50 | an integer from 1 to 100000 | the size under which such a slice should join its neighbour |
| `lead_time_hours.small` / `.medium` / `.complex` | 2 / 4 / 8 | a number above 0, at most 1000 | the target from a job's start to its merge request, by the Task's size |
| `decision_docs` | `GLOSSARY.md`, `docs/adr/**/*.md`, `docs/decisions/**/*.md`, `docs/terminology.md`, `docs/architecture.md` | at most 50 globs relative to the checkout (no leading `/` or `./`, no `..`, no backslash, no braces, parentheses or square brackets: one entry per alternative; `*`, `**` and `?` are fine); `[]` means none | the documents that hold the product's decisions |

```json
{
  "version": 1,
  "slice": { "change_max_lines": 500 },
  "workspaces": { "web": { "slice": { "change_max_lines": 300 }, "decision_docs": ["docs/adr/*.md"] } }
}
```

A value comes from the workspace's entry under `workspaces`, else the top level, else the default;
`slice` and `lead_time_hours` merge key by key, `decision_docs` replaces the whole list.
`sf norms [workspace]` (needs `sf serve`) prints each value in force with its source (`default`,
`file` or `workspace`) and the problems of the whole file, every workspace's entry included.
The Task check uses `slice.change_max_files` for a Task of kind `change` (or none) or `switch`
([Planning](planning.md#the-task-check)), a job's lead-time target is `lead_time_hours` of its
Task's `size`, and the Task check and the reviewers get the documents `decision_docs` matches;
nothing uses `slice.change_max_lines` or `slice.min_lines` yet.

How it differs from the environment file:

- **Read at each use**: an edit applies at the next use, without restarting `sf serve`.
- **Per workspace**: a workspace's entry overrides the top level key by key.
- **A bad value falls back** to the next source (the top level, then the default) and is listed as
  a problem by `sf norms`; a file that is missing or not JSON is the defaults. Nothing stops, where a
  bad environment setting stops `sf serve`.

The reference: [Norms](../../factory/README.md#norms).

## The guard

The guard keeps the names of your other workspaces, your employer, your colleagues and your
secrets out of what the factory publishes. It has two parts:

- **Secrets, in every workspace.** The values of the secret settings of `auth.env` (every key ending
  in `TOKEN`, `SECRET`, `PASSWORD` or `API_KEY`, and `SF_NTFY_URL`), the dashboard and MCP tokens,
  and well-known key formats (private key blocks, GitHub, GitLab, OpenAI, Slack and AWS keys). You
  set nothing for this.
- **Names, in a guarded workspace.** For a repository that is or may become public, set
  `"guard": true` on its entry in `workspaces.json`; turn it on for `software-factory`:

  ```json
  "software-factory": { "read_checkout": "/home/you/IdeaProjects/software-factory", "guard": true }
  ```

  Its pushes and MR texts are then also checked for the names, Git hosts, ticket keys (`ABC` of
  `ABC-123`) and work email domains of your other workspaces, built from the registry and the jobs
  at each check, and for the terms of your private list.

What is checked in a commit: its message, its added lines and the paths of its new files; also the
branch name and the MR text. The author and committer of a commit (your name and email) are never
checked, so your own Git identity needs no change, even when its email domain is that of another
workspace or on your private list.

**The private list** is `~/.config/software-factory/guard-terms.txt`. It never lives in a
repository and the factory never writes it. One entry per line:

```text
# my employer and colleagues
ACME
Jane Doe
# a regular expression (JavaScript, case-insensitive)
re:jane\s*doe
# a false positive among the automatic terms: drop it
!acme-tools
```

A plain line matches as a whole word, in any case (`ACME` matches `Acme's` and `acme-web`, not
`acmeville`). `re:` starts a regular expression. `!` drops an automatic term (a workspace name, a
host, a key prefix or a domain) that gives false positives; it never drops a line of the list. A
line that is not valid (a broken expression, one that matches the empty text, an empty `re:` or `!`)
stops every check with `guard_terms_invalid` naming its line number.

**The hook.** `sf guard install-hook software-factory` writes a Git `pre-push` hook into your
checkout, so your own pushes are checked too (it refuses to overwrite a hook it did not write).

**See the hits.** `sf guard software-factory` lists what your next push would publish that the guard
refuses, with the matched text: `sf guard software-factory --history` checks every commit, `--branch
<name>` a branch name, `--mr <ticket>` a job's MR text, `--worktree <ticket>` a job's uncommitted
change. It exits 0 without hits and 1 with hits. Only `sf guard` and the hook show the matched text
(never a secret's); every other message names the place only.

**When the guard stops a job** (`guard_hit`):

- **At Clean** (the change): the factory first writes a Fix section `Guard` naming the places, and
  the job goes through a normal fix round. After two such rounds it stops. Remove the text with
  `sf say` (or by hand in the worktree, then `sf say`), or, for a false positive, add a `!` line to
  `guard-terms.txt` and run `sf retry`. `sf guard <workspace> --worktree <ticket>` shows the matches.
- **In the MR text**: the Implementer gets up to two more MR text turns; then the job stops. Tell it
  how to word the text with `sf say`, or run `sf retry` for new turns.
- **At the push** (`sf approve`, Push, `sf mr create`): nothing is pushed and the job is not
  changed. The message names `sf guard <workspace> <commit> --mr <ticket>`; fix the commit, the
  branch name or the MR text (on the Merge request screen), or add a `!` line, and push again.

## The agents' skills

The factory's agents use your installed skills, the ones the `skills` tool keeps in
`~/.agents/skills` (`SF_SKILLS_DIR`) with its `.skill-lock.json`. You choose which of them each
agent role uses; the choice is one, shared by all workspaces (no workspace has its own). The factory installs nothing for you: run `npx skills add
<source>` in a terminal, then switch the skill on for a role. It copies skills in one place:
`sf planner setup` puts the `planner` role's skills into the workspace's planning copy (below).

| Role | What it is | Its skills by default | How it gets them |
| --- | --- | --- | --- |
| `implementer` | The Implementer's session | `implement`, `tdd`, `code-review`, `grilling` | Mounted read-only where Claude Code looks for your skills; it sees no other. Without `implement`, its prompts name the Task file without `/implement`. |
| `claude_review` | The Claude review | `code-review` | `code-review` is its review method; each other skill is a `<skill>` block in its prompt. |
| `codex_gate` | The Codex gate | `code-review` | As the Claude review. |
| `task_check` | The Task check | none | Each skill is a `<skill>` block in its prompt. |
| `planner` | The planner, ChatGPT or Claude Code | `grilling`, `prototype` | ChatGPT (the MCP server's instructions): each skill's `SKILL.md` body, in order, after the Quick start. Claude Code: `sf planner setup` copies each skill from the snapshot into the planning copy's `.claude/skills/`, beside the factory's `planning-tasks`, and switches your other skills off there (`skillOverrides`; your claude.ai skills with `syncClaudeAiSkills`). |

A role can have no skill at all, `implement` and `code-review` included: it then works without a
method (the planner with the Quick start alone). The `<skill>` blocks of one prompt take at most
64 KiB; a skill past that is named in the record (`skills_omitted`), not sent.

```sh
sf skills                                  # the installed skills: source, updated, description, on/- per role and the coordinator; then the chosen ones not installed
sf skills set codex_gate grilling on       # add a skill to a role
sf skills set implementer implement off    # take one out
```

`sf skills set` refuses an unknown role or a skill that is not installed, with the list. The
choice is `skill-roles.json` in the state directory (`{ "version": 1, "roles": { <role>: [...] }
}`; a role missing from it has its default). Every change, through `sf skills set` or the Skills
page, writes every role's list, so a file saved before a default changed keeps the old list for
that role: switch the new skill on yourself (`sf skills set planner prototype on`, or its box in
the Planner column). A job keeps the choice it started with; a change
applies to the jobs started after it, to the next Task check and, in `sf serve`, to the next
planning request, and to a planning copy at its next `sf planner setup`. `SF_REVIEW_SKILL` and `SF_PLAN_SKILL`, when set, win over the choice. The
dashboard reads and changes the same choice through `GET api/skills`, `GET api/skills/<name>`
and `PUT api/skills/roles/<role>` (factory/README.md, section The agents' skills).

### The Skills page

The dashboard's **Skills** tab (after Workspaces; `#skills`) shows the same choice and changes it
by clicks, on the local and the remote dashboard alike. Each installed skill is a row (its name,
the first line of its description, its source and updated date) with one checkbox per role:
Implementer, Claude review, Codex gate, Task check and Planner (ChatGPT or Claude Code), each head with its
count. A click saves the role's new list at once, with no Save button; the boxes stay disabled
until the factory answers, and a refusal or a lost connection puts it back with the message next
to the table. A filter above the table finds a skill by name or description. A skill a role chose
that is not installed is listed below the table ("Chosen but not installed"), with its boxes to
switch it off. A click on a skill's name shows its `SKILL.md` as plain text in a side panel (Close
or Esc). As with `sf skills set`, a change applies to the jobs started after it (running jobs keep
their skills) and, for the Planner column, to ChatGPT's next planning request and to a planning
copy at its next `sf planner setup`. The page installs
nothing: `npx skills add <source>` in a terminal does.

The last column, **Coordinator (Claude Code)**, is your own Claude Code session in the factory's
checkout: the checkout of the workspace `SF_COORDINATOR_WORKSPACE` (`software-factory` by
default). It is not a role and not in `skill-roles.json`: its boxes are Claude Code's own
per-project switch, `skillOverrides` in that checkout's `.claude/settings.local.json` (personal,
not committed), the same key Claude Code's `/skills` menu writes, read again on every Refresh. A
click switches one skill on (its entry removed) or off (`"off"`); a skill set to `name-only` or
`user-invocable-only` shows as an indeterminate box with the value in its title, and a click sets
it on. Every other key of the file, and the entries of other names (plugin skills), are kept as
they are. A file that is not JSON (or whose `skillOverrides` is not an object), or a `.claude` or
settings file that is a symlink, is refused and never overwritten. A change applies to the next
Claude Code session there, or after `/skills`. Without that workspace the column has no boxes and
says why. From a terminal:

```sh
sf skills set coordinator grilling off     # the coordinator's Claude Code session hides grilling
sf skills set coordinator grilling on      # and shows it again
```

## Coding rules

The factory gives the Implementer, both reviewers and the Task check your coding rules as they are:
no rule format of its own. They are collected in this order:

1. **The repository**: the first of `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md` at
   the repository's root that is a regular file, and, for `AGENTS.md` only, every Markdown file it
   links to (one hop, in link order, each once; links outside code blocks; `.md` files inside the
   repository only). They are read from Git at the job's base commit, never from your working tree,
   so uncommitted rules do not count.
2. **The workspace's rules**: `<config dir>/rules/my-app.md`, if it exists.
3. **Your global rules**: `<config dir>/rules/global.md`, if it exists.

**Priority**: the block the agents get says that the repository's rules win over yours where they
disagree. Neither changes the factory's own rules (Git, the Task file, the Report, the Fix
sections, the tools).

**Budget** (`SF_RULES_MAX_BYTES`, default 48 KiB of file content): your files come first, so the
repository's never push them out. The workspace file is given whole if it fits, else cut to the
budget; then the global file whole if it fits what is left, else cut, else left out. Then the
repository's files in link order, each whole if it fits what is left, else left out (never cut). A
cut file ends with `[cut at the budget: N of M bytes given]`; the files left out are named in a
closing line, `Not included, read them if relevant: …`, so the agents can read them.

**`rules_skip`** (in `workspaces.json`) leaves repository files out: exact paths or globs (`*` and
`?` within one path segment, `**` across, `{a,b}`). It never affects your own rules files.
Skipping `AGENTS.md` does not fall back to `CLAUDE.md`.

**When**: the rules are collected once at Start (and Restart) and stored with the job, so a job is
judged by the rules it started with, even after an `sf serve` restart. If they cannot be collected
(an unreadable rules file), the job fails with `rules_failed`; fix the cause and `sf restart`.

**`sf rules my-app [APP-12]`** lists what would be given, never the text:

```
$ sf rules my-app
Rules for my-app at 3f2a1c9 (budget 49152 bytes):
workspace  rules/my-app.md  1840 bytes
global  rules/global.md  920 bytes
repository  AGENTS.md  2210 bytes
repository  docs/coding-standards.md  6120 bytes
```

With a ticket whose job has started it prints the job's stored list; with a ticket not started, it
reads the rules at the Task file's `base` (fetched from `origin` first); without a ticket, at the
checkout's `HEAD`. Sections `Left out (over the budget):` and `Skipped by rules_skip:` follow when
they apply. The details: [Coding rules](../../factory/README.md#coding-rules).

## Queue settings

The queue lives in `<state dir>/queue.json`; you change it with `sf queue` (which needs `sf serve`)
or on the board, not by editing the file.

| Setting | Default | Change it with | Meaning |
| --- | --- | --- | --- |
| The limit `max_running` | `SF_MAX_JOBS` (3) | `sf queue limit <N>` (1 to 20), the board's "Run up to [− N +] jobs at once" | How many jobs may run at once, over every workspace. Only the queue's own starts wait for it: a start by hand always goes and counts. Lowering it stops no job. |
| The order | the order tickets were added | `sf queue add <ws> <ticket> [--at N]`, `sf queue move <ws> <ticket> <N>`, `sf queue remove`, drag and drop or Alt+↑/↓ on the board | The queue starts the first entry whose plan check is `ready` (or not needed: a small, scoped Task with no check of its current version, see `check` below) and whose `lands_after` tickets are all merged. |
| The hold | not held | `sf queue hold [reason…]`, `sf queue release` | A held queue starts nothing. |
| The rule at a usage limit's reset | `resume-then-queue` | `sf queue on-limit resume-then-queue\|resume-only\|wait`, the board's *Rules ▾* menu | What happens when a usage limit resets (below). |
| Start anyway | off per entry | `sf queue force <ws> <ticket>`, *Start anyway* on the card | The entry starts whatever its Task check says, until it leaves the queue. |

**Running** means `starting`, `working`, `awaiting_review`, `preparing_mr` or `waiting_limit`. A
paused job and a job that waits for you do not count.

**The usage-limit rule.** When a Claude or Codex session hits your plan's usage limit, the job is
parked in `waiting_limit` (it keeps its slot), and while any job is parked the queue starts nothing
(this hold is computed; `sf queue release` does not end it). At the reset time the factory read from
the message (or 30 minutes later when it could not read one), the rule applies:

- `resume-then-queue` (default): resume the parked jobs, then go on starting queued tickets;
- `resume-only`: resume the parked jobs and hold the queue until you release it;
- `wait`: resume nothing, hold the queue, and show "Limit reset: resume?" on the card.

You may resume a parked job at any time with `sf resume` or *Resume now*. More:
[Usage limit](../../factory/README.md#usage-limit-waiting_limit) and
[Run queue](../../factory/README.md#run-queue).

## The Task file's front matter

A Task file starts with a front matter block between two `---` lines, one `key: value` per line.
Lists are written on one line, as `[a, b]` or `a, b`; a trailing ` # comment` is dropped. The file
must be 1 byte to 256 KiB of UTF-8.

```markdown
---
ticket: APP-12
title: Export the report as CSV
base: main
scope: [src/export/**, test/export.test.ts, README.md]
may_touch: [package.json, package-lock.json]
lands_after: [APP-11, my-api/API-7]
check: required
---
```

| Key | Required | Dashboard label (planned ticket page) | Meaning |
| --- | --- | --- | --- |
| `ticket` | yes | the key in the header | Must equal the file's name (`APP-12` for `APP-12.md`): 1 to 64 characters of letters, digits, `.`, `_` and `-`, starting with a letter or digit. |
| `title` | yes | the title in the header and on the card | A short title; the branch name is `<ticket>-<slug of the title>`. |
| `base` | yes | **Starts from** | The branch the job starts from and the MR targets. A feature branch when the ticket needs work that is not merged yet. |
| `continues` | no | (not shown) | The source branch of a merge request already open on `origin` that this ticket adds to; `base` stays that merge request's target. The job starts from `origin/<continues>`, is rebased onto its latest tip at Clean, and Approve pushes the commit onto it (never forced; the job's own branch is not pushed), so the open merge request is reused. Refused when it equals `base`, is `main` or `master`, or is not a valid branch name (letters, digits, `.`, `_`, `/`, `-`; not starting with `-` or `/`, not ending with `/`, `.` or `.lock`, no `..` or `//`). See [Planning](planning.md#a-follow-up-to-an-open-merge-request). |
| `builds_on` | no | (not shown; "Waits for" on the Queue card) | The ticket of this workspace, not merged yet, whose change this part builds on: the job starts from the commit that ticket's job prepared, Approve is refused until that ticket is merged and this part is on `base`, and the queue waits until that ticket's job has a prepared commit. Once that ticket is merged, the factory moves a prepared part onto `base` by itself and tells you it is ready to submit, and a job started then starts from `base` as any job. Refused when it names the ticket itself, is not a ticket key, or comes with `continues`. See the [Handbook's Task file format](../../factory/HANDBOOK.md#task-file-format). |
| `scope` | no | **Files it will change** | Every file the ticket is expected to create, change or delete, tests and docs included (paths or globs). A changed path outside it (and outside `may_touch`) must be justified to a reviewer, or it is a fix item. Without it nothing is checked ("No list: the job may change any file, and nothing is checked."). |
| `may_touch` | no | **Files it will change**, marked 🔒 | Sensitive paths (manifests, lockfiles, CI, configuration) the ticket may change on purpose. A sensitive path not named here needs a reviewer's acceptance. Also counts as in scope. |
| `lands_after` | no | **Waits for** (and "Waits for" on the Queue card) | The tickets this one waits for: `APP-11` in the same workspace, `my-api/API-7` in another. The queue starts it only when all are merged; Start by hand does not wait. |
| `check` | no | **Plan check** (`not needed` with the reason, or the check's result) | Whether the Task needs a plan check. `check: skip`: never. `check: required` (or any other value): always. Without it a Task needs one when it has no `scope`, more than 10 scope entries, a glob in `scope`, a `lands_after` ticket of another workspace or more than 1,200 words (the whitespace-separated words of the whole file, front matter included); otherwise it is small and starts from the queue without a check (`write_task` answers `not_needed`). A Check pressed by hand always runs, and its verdict counts as before. |
| `review` | no | (not shown) | Who reviews the ticket's iterations: `claude` adds the Claude review, in the same round as the Codex gate when the gate level runs it; `codex` has the gate alone even with `SF_CLAUDE_REVIEW=always`. Without it, or with any other value, `SF_CLAUDE_REVIEW` decides (by default the gate alone). With the gate off the Claude review reviews every ticket. Read once, at Start. |
| `size` | no | (not shown) | The planner's estimate of the Task: `small`, `medium` or `complex`. It picks the job's lead-time target, `lead_time_hours.<size>` of the [norms](#norms-normsjson). Without it, or with any other value, the Task is `medium`. |
| `part_of` | no | (not shown) | The task this Task is a slice of, as a ticket name (`APP-10`). With `slice` set too, the merge request's *Special things to note* begins "Slice N of M of APP-10." Any other value is ignored, and the plan check lists it as a nit. With `slice` set too, the board's cards of the parts and of APP-10 say how far the parts are: `APP-10: 2/4 merged, 3rd ready to submit`. |
| `slice` | no | (not shown) | Which slice this is and how many there are: `N/M` in digits, 1 <= N <= M <= 20. Any other value is ignored, and the plan check lists it as a nit. |
| `kind` | no | (not shown) | The slice's kind (the Handbook's *Slicing a solution*): `mechanical`, `preparation`, `change`, `switch` or `cleanup`. Without it, or with any other value (a nit in the plan check), the Task is `change`. A `change` or `switch` Task whose plan check expects more files than `slice.change_max_files` of the [norms](#norms-normsjson) gets an `overreach` major, a nit when it says under `## Why whole` why it is only safe whole. |
| `important` | no | (not shown) | `true` marks a ticket the user called important: none of the three loop limits (`SF_MAX_ITERATIONS`, `SF_GATE_MAX_ROUNDS`, the gate's token budget) stops its job; churn, disputes, escalations, the turn limit, failed tests, failures, usage limits and you still do. Read once at Start. Any other value is not important. |

Other keys are kept but ignored. The body's sections (the task, `## Files`, `## Review brief`)
are described in [Planning](planning.md#what-makes-a-good-task-file) and in the
[Handbook's Task file format](../../factory/HANDBOOK.md#task-file-format).

Next: [Planning a ticket](planning.md).
