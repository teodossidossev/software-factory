# Configuration

This page lists every setting you can change: the environment file, the workspace registry, the
rules files, the queue and the Task file's front matter, each with its meaning, default, allowed
values and an example, as the code of this version reads them.

## Where the settings live

| What | Where | Read |
| --- | --- | --- |
| Environment settings (`SF_*`, tokens) | `~/.config/software-factory/auth.env`, or the environment | by every `sf` command at its start |
| Workspaces | `~/.config/software-factory/workspaces.json` | at every use (an edit applies at once) |
| Your own coding rules | `~/.config/software-factory/rules/<workspace>.md`, `rules/global.md` | at each job's Start |
| The queue (order, limit, hold, limit rule) | `~/.local/state/software-factory/queue.json` | by `sf serve`; changed with `sf queue` or the board |
| A ticket's plan | `.software-factory/<ticket>.md` in the workspace's checkout | at Start, by the Task check and the queue |

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
| `SF_TURN_LIMIT_CONTINUES` | `1` | `0` to `10` | How many times the factory says "continue" by itself, per chain of turns, after a turn used all its steps while still changing files. `0` stops at the first limit (`max_turns`). |
| `SF_MAX_ITERATIONS` | `5` | positive integer | Fix sections a job may get from the reviewers. The next one stops the job (`iteration_limit`). Your own messages do not count. |
| `SF_CHECK_AFTER_START_MIN` | `15` | positive integer | `check_after_minutes` the job status reports during the first iteration (a hint for a polling client; the dashboard does not need it). |
| `SF_CHECK_AFTER_FIX_MIN` | `5` | positive integer | The same hint for later iterations. |

### Reviewers and the Task check

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_REVIEW` | on | `off` | `off` runs no Claude review and no gate: an iteration waits in `awaiting_review` until you send a message or abort. |
| `SF_REVIEW_MAX_TURNS` | `60` | positive integer | Steps of a Claude review; the simplification pass uses it too. |
| `SF_SIMPLIFY` | on | `off` | The simplification pass after a clean verdict of a job that had fix rounds. `off` goes straight to MR preparation. |
| `SF_TASK_CHECK_AUTO` | `on` | `on`, `off`, empty | `on`: `sf serve` checks a written Task file 60 s after its last change. `off`: only Check on the board and `sf check-task`. |
| `SF_TASK_CHECK_PARALLEL` | `1` | `1` to `4` | Automatic Task checks that run at once over all workspaces. |
| `SF_TASK_CHECK_MAX_TURNS` | `30` | positive integer | Steps of a Task check. |

### The Codex gate

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_GATE` | `codex` | `codex`, `off`, empty | `codex` runs the Codex CLI after a clean Claude review; `off` lets the Claude verdict decide. With `codex` and no Codex found, the gate is off and `sf serve` prints `gate: off (…); the Claude review decides`. |
| `SF_CODEX` | `codex` on `PATH` | absolute path | The Codex executable. A relative path is refused (`invalid_config`); a path that is not an executable file turns the gate off (`PATH` is then not searched). |
| `SF_GATE_MAX_ROUNDS` | `5` | positive integer | Fix verdicts of the gate per job; the next one stops the job (`gate_rounds`). |
| `SF_GATE_MAX_TOKENS` | `5000000` | 1 to 1000000000 | Input plus output tokens of all gate runs of a job; at the ceiling the job stops (`gate_budget`). |
| `SF_GATE_TIMEOUT_MS` | `900000` (15 min) | 1 to 86400000 | How long one gate run may take; then it is killed (`gate_failed`). |
| `SF_GATE_LEVEL` | `auto` | `auto`, `full`, empty | `auto` picks `full`, `light` (one round) or `none` (documentation only) from the risk of the change; `full` runs the gate on every clean Claude verdict. |
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
| `SF_PORT` | `8787` | `0` to `65535` (`0`: any free port) | Port of the MCP server, `http://127.0.0.1:<port>/mcp`. The tunnel expects `8787`. An invalid value is `invalid_port`. |
| `SF_DASHBOARD_PORT` | `8788` | `0` to `65535` | Port of the dashboard, `http://127.0.0.1:<port>/d/<token>/`. |
| `SF_DASHBOARD` | on | `off` | `off` starts no dashboard and removes the saved token. |
| `SF_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/software-factory` | path | Jobs, the queue, the socket `sf.sock`, the dashboard token. The socket path must fit 107 bytes (`socket_path_too_long`). |
| `SF_WORKTREE_ROOT` | `<state dir>/worktrees` | absolute path | Where each job's worktree is created: `<root>/<workspace>/<ticket>`. |
| `SF_CONFIG_DIR` | `${XDG_CONFIG_HOME:-~/.config}/software-factory` | path | `workspaces.json`, `auth.env` and `rules/`. |
| `SF_ENV_FILE` | `<config dir>/auth.env` | path, or empty for none | The environment file (above). |
| `SF_HANDBOOK` | `factory/HANDBOOK.md` | path | The Handbook served to the Context owner. |
| `SF_TUNNEL_SCRIPT` | `scripts/sf-tunnel.sh` of the clone | path | The tunnel script `sf up` starts. |
| `SF_TUNNEL_HEALTH` | `127.0.0.1:8790` | `host:port` | Where `sf info` asks the tunnel client whether it is ready (`/readyz`). |

### The ChatGPT tunnel (scripts/sf-tunnel.sh)

The tunnel wrapper `scripts/sf-tunnel.sh` reads two settings of its own (and `XDG_CONFIG_HOME`
for their defaults). It is a shell script, not an `sf` command: it reads them from its environment
only. Started by `npm start` (`sf up`) it inherits the environment of `sf`, which includes the
values from `auth.env`; started by `npm run tunnel` or by hand it does not read `auth.env`, so
export them in that shell. Give `init`, `set-key`, `check` and `run` the same values: `check` (and
so `run`) refuses a profile whose key reference is not the current key file.

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `SF_TUNNEL_KEY_FILE` | `${XDG_CONFIG_HOME:-~/.config}/software-factory/tunnel-runtime.key` | a file path | The file that holds the tunnel's runtime key. `set-key` writes it (mode 0600, its directory 0700), `init` writes a `file:<path>` reference to it into the profile, and `check` requires it to exist, be non-empty, have mode 600 and not hold a `tunnel_id`. Example: `SF_TUNNEL_KEY_FILE=/home/you/.secrets/sf-tunnel.key`. |
| `TUNNEL_CLIENT_PROFILE_DIR` | `${XDG_CONFIG_HOME:-~/.config}/tunnel-client` | a directory path | The directory of tunnel-client profiles; the wrapper's profile is `<dir>/software-factory.yaml`, created by `init` and read by `check`, `doctor` and `run` (passed to `tunnel-client` as `--profile-dir`). Example: `TUNNEL_CLIENT_PROFILE_DIR=/home/you/.config/tunnel-client-work`. |

For example, to keep both in another place:

```sh
export SF_TUNNEL_KEY_FILE=/home/you/.secrets/sf-tunnel.key
export TUNNEL_CLIENT_PROFILE_DIR=/home/you/.config/tunnel-client-work
scripts/sf-tunnel.sh init tunnel_<your id>
scripts/sf-tunnel.sh set-key
scripts/sf-tunnel.sh check
```

The wrapper's other values are fixed in the script: the MCP URL `http://127.0.0.1:8787/mcp` (it
does not follow `SF_PORT`) and the health address `127.0.0.1:8790` (which `sf info` reads through
`SF_TUNNEL_HEALTH`). See the [connection runbook](../runbooks/chatgpt-connection.md).

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
| `SF_GITLAB_TOKEN` | unset | For every other host (taken as GitLab): a token with scope `api`, sent only to the GitLab API of the `origin` host. |
| `SF_GITLAB_URL` | `https://<origin host>/api/v4` | The GitLab API base when it differs (another port or path). `https` (or `http` on loopback only); no credentials, query or fragment. Set, the token goes only to this host, and workspaces on other hosts are refused (`mr_host_unsupported`). |

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

The full table with every detail is in the reference,
[Environment](../../factory/README.md#environment).

## The workspace registry (workspaces.json)

`<config dir>/workspaces.json` lists your repositories. `sf workspace add` and the dashboard's
**Workspaces** drawer write it; you may edit it by hand (it is read at every use). The parser is
strict: an unknown key, at the top or in an entry, makes the whole file invalid, and `sf serve`
refuses to start (`registry_invalid`).

The top level is exactly `{"workspaces": {<name>: <entry>}}`. A **name** is 1 to 64 characters of
`a-z`, `0-9` and `-`, starting and ending with a letter or digit.

| Field | Required | Allowed | Meaning |
| --- | --- | --- | --- |
| `read_checkout` | yes | an absolute path (`~` is not expanded in the file) | Your local checkout: the root of a non-bare Git work tree. Task files live in its `.software-factory/` (added to its `.git/info/exclude`); every job's worktree is created from it; the hand-over checks the branch out in it. |
| `work_checkout` | no | an absolute path | Retired. Still accepted and checked as an absolute path, then ignored: every job uses a worktree of `read_checkout`. When it differs from `read_checkout`, `sf serve` prints one warning. `sf workspace add --work` is refused. |
| `handoff` | no | `"checkout"` or `"off"` | The workspace's own hand-over setting; wins over `SF_HANDOFF`. Use `off` for a checkout that must not be switched to every job's branch. |
| `color` | no | `blue`, `teal`, `green`, `olive`, `orange`, `red`, `purple`, `grey` | The workspace's colour on the board. Without it, one is picked from the name. |
| `rules_skip` | no | a list of paths or globs | Repository rule files not given to the agents ([Coding rules](#coding-rules)). Only by editing the file. |

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
      "color": "teal"
    }
  }
}
```

The same from the command line:

```sh
sf workspace add my-app --read ~/work/my-app --handoff checkout --color blue
sf workspace add my-api --read ~/work/my-api --handoff off --color teal
sf workspace list
```

`sf workspace add` resolves the path (so `~` and relative paths work there). Run it again with the
same name and path and `--handoff` or `--color` to change those fields; without them it says
`workspace_exists`. `sf workspace remove my-api` removes the registration only (nothing on disk
changes). On the dashboard, the Workspaces drawer adds a workspace (an absolute path; it cannot
change an existing one) and removes one that has no live job.

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
| The order | the order tickets were added | `sf queue add <ws> <ticket> [--at N]`, `sf queue move <ws> <ticket> <N>`, `sf queue remove`, drag and drop or Alt+↑/↓ on the board | The queue starts the first entry whose plan check is `ready` and whose `lands_after` tickets are all merged. |
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
---
```

| Key | Required | Dashboard label (planned ticket page) | Meaning |
| --- | --- | --- | --- |
| `ticket` | yes | the key in the header | Must equal the file's name (`APP-12` for `APP-12.md`): 1 to 64 characters of letters, digits, `.`, `_` and `-`, starting with a letter or digit. |
| `title` | yes | the title in the header and on the card | A short title; the branch name is `<ticket>-<slug of the title>`. |
| `base` | yes | **Starts from** | The branch the job starts from and the MR targets. A feature branch when the ticket needs work that is not merged yet. |
| `scope` | no | **Files it will change** | Every file the ticket is expected to create, change or delete, tests and docs included (paths or globs). A changed path outside it (and outside `may_touch`) must be justified to a reviewer, or it is a fix item. Without it nothing is checked ("No list: the job may change any file, and nothing is checked."). |
| `may_touch` | no | **Files it will change**, marked 🔒 | Sensitive paths (manifests, lockfiles, CI, configuration) the ticket may change on purpose. A sensitive path not named here needs a reviewer's acceptance. Also counts as in scope. |
| `lands_after` | no | **Waits for** (and "Waits for" on the Queue card) | The tickets this one waits for: `APP-11` in the same workspace, `my-api/API-7` in another. The queue starts it only when all are merged; Start by hand does not wait. |

Other keys are kept but ignored. The body's sections (the task, `## Files`, `## Review brief`)
are described in [Planning](planning.md#what-makes-a-good-task-file) and in the
[Handbook's Task file format](../../factory/HANDBOOK.md#task-file-format).

Next: [Planning a ticket](planning.md).
