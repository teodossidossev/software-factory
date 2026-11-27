# Security

The factory runs coding agents on the user's machine, as the user, on the user's repositories.
This page is the threat model and the map of the mechanisms behind it, each with the file that
implements it. Two documents hold the details and are kept current by the factory's own process:
[docs/SECURITY.md](../SECURITY.md) (what is protected, what is open, when it was last checked)
and [the trust model](../guide/trust-model.md) (every path, every rule). What leaves the machine is
on its own page: [Data flows](data-flows.md).

The short version: **a session gets what its job needs and nothing else, in several independent
layers; whatever a model writes is treated as untrusted until the factory or the user has checked
it; and only the user's command publishes anything.**

## Threat model

**What is protected**

- The user's credentials: SSH keys and agent, the Git host tokens, cloud credentials, the Claude
  and Codex logins.
- The factory's own controls: `auth.env` (with the Git host tokens), the CLI socket `sf.sock` and
  the dashboard token, with which one can approve, push and merge; the MCP token, with which one
  can write and queue Task files.
- The user's other repositories, and the other jobs' work in progress.
- The machine outside the job: code that would run as the user later, such as Git hooks and
  filters, the IDE's build files, agent configuration with hooks or MCP servers.
- What gets published: commits, branch names and merge request texts on the Git host.

**What it defends against**

- **A model that errs or is steered.** The Implementer runs commands; its input includes text
  other people wrote (the repository, the Task file, images, review comments). There is no
  detector of injected instructions: a session can do little beyond its job, and what it produces
  is checked before it counts.
- **Code the agent wrote that runs later**, outside the sandbox: a test, a build file, a Git hook
  or filter, a `.claude/settings.json` hook, an `.mcp.json` server.
- **Other clients on the machine and pages in the browser** against the two HTTP listeners: a
  forged request, DNS rebinding, a frame that tricks a click.
- **Remote access**: the tailnet, a lost phone.

**What it does not defend against**

- The user's own processes outside any sandbox: they can read the token files
  ([runbook](../runbooks/chatgpt-connection.md#how-a-request-travels)). The coordinator is one of
  them: it is the user's own Claude Code session, bound by the user's Claude Code settings and the
  [coordinator runbook](../runbooks/coordinator.md), not by the factory.
- What a model provider does with what it receives ([Data flows](data-flows.md)).
- What any local user may read outside the home directory (`/etc`, `/opt`).

## Trust boundaries

```mermaid
flowchart TB
    subgraph asuser["Runs as the user, no sandbox"]
        factory["sf serve and the runners<br/>fetch, commit, rebase, push, merge request API, hand-over"]
        coordinator["The coordinator<br/>the user's own session"]
    end
    subgraph wrapper["bwrap wrapper: src/session-wrapper.ts"]
        claude["Implementer's Claude Code<br/>tool allow list, deny rules, file-tool guard"]
        subgraph bash["Claude Code's Bash sandbox: bwrap"]
            commands["Bash commands<br/>path denials, npm registry only"]
        end
    end
    subgraph readonly["Read-only Claude sessions"]
        review["Claude review, simplification pass<br/>Read, Grep, Glob, file-tool guard"]
        check["Task check<br/>its own checkout, path guard"]
    end
    subgraph gatebox["bwrap and seccomp: gateWrapper"]
        codex["codex exec<br/>Codex's read-only sandbox"]
    end
    subgraph testbox["bwrap, no network: src/test-command.ts"]
        tests["the workspace's test command"]
    end
    factory -->|"starts"| wrapper
    factory -->|"starts"| readonly
    factory -->|"starts"| gatebox
    factory -->|"starts"| testbox
    claude --> commands
```

The factory itself is trusted and runs as the user. Every agent session it starts is confined:
the Implementer by the layers below, the read-only sessions by their tools and the path denials,
the gate and the test command by sandboxes of their own. The coordinator and the planners sit
outside this picture: the planners reach the factory only through its planning tools, which only
plan.

## The Implementer, layer by layer

The Implementer is the one session that runs commands and writes files, so it gets every layer.

| Layer | What it holds | Where |
| --- | --- | --- |
| The tool set | An allow list of built-in tools (`IMPLEMENTER_TOOLS`); denied on top: every mutating Git command, `sudo`, `WebFetch`, `WebSearch`, `mcp__*`, the scheduling, messaging and background-task tools, edits of `.git` and any use of `.env` files (`DENIED_TOOLS`) | `src/rules.ts` |
| No configuration from outside | No MCP server loads (`strictMcpConfig`, no `mcpServers`); no hook from a settings file runs (`disableAllHooks`); background tasks are off; the user's own settings are read first, and a session whose settings would weaken the sandbox does not start (`user_settings_weaken_sandbox`) | `src/session.ts`, `src/sandbox-denials.ts` |
| Path denials as permission rules | The denied paths below, as deny rules for `Read`, `Edit` and `Write` | `pathDenials`, `src/sandbox-denials.ts` |
| The file-tool guard | A `PreToolUse` hook that runs in every permission mode and checks each file tool call by its real path: writes only inside the worktree, never in its `.git` or agent configuration (`.claude/`, `.mcp.json`, `.codex/`); reads refused in the home directory outside the kept paths; searches walked for links before they run | `guardHooksOf`, `src/sandbox-denials.ts` |
| Claude Code's Bash sandbox | bubblewrap with the same paths in `denyRead` and `denyWrite`, the home directory hidden but the kept paths (the toolchains, Git's config), the host's `/tmp` hidden but the session's own paths, network only to `registry.npmjs.org` and `SF_SANDBOX_DOMAINS`, the credential variables unset, and no command outside the sandbox (`allowUnsandboxedCommands: false`) | `sandboxSettings`, `src/config.ts`; `src/session.ts`; `src/host-tmp.ts` |
| A wrapper around Claude Code itself | The whole system read-only but the worktree (not its `.git`), the session's temporary folder and Claude Code's own state; a private, empty `/tmp`; the chosen skills mounted read-only. A link swapped in after the guard's check cannot send a write out of the worktree. Without `bwrap` the turn stops (`sandbox_unavailable`): it never runs unwrapped | `src/session-wrapper.ts` |
| After the session | Nothing reaches the commit unreviewed; the factory's Git runs no hooks; the hand-over skips files the IDE runs | `src/mr.ts`, `src/git.ts`, `src/handoff-sensitive.ts` |

The read-only sessions (the Claude review, the simplification pass, the Task check, the stop
explanations, the morning digest) have no `Bash`, no write tool and no MCP server; the review and
the simplification pass also get the file-tool guard, the Task check a path guard of its own that
holds every tool to its own checkout (`guardHooks`, `src/task-check.ts`).

## What no session can reach

Denied for reading and writing to every agent session of a job and to the Task check, as tool
rules and sandbox rules at once ([trust model](../guide/trust-model.md#what-no-session-can-reach)):

- the factory's config directory and `auth.env`; its state directory but `worktrees/` (so
  `sf.sock`, the tokens, `jobs/`, `queue.json`, the logs);
- the other jobs' worktrees and the other workspaces' checkouts;
- the tunnel client's profile; Claude Code's global config and its backups;
- `~/.ssh`, `~/.codex`, `~/.aws`, `~/.config/gh`, Git's credential files, `~/.netrc`, `~/.npmrc`,
  Claude Code's credentials;
- the usual Unix socket locations: the session bus and the systemd user manager behind it, docker,
  containerd, podman, tailscaled, SSH agents, tmux, X11;
- for reading, the `.env` and `.env.*` files of the worktree and the checkout.

`SSH_AUTH_SOCK` is not passed on. The denials are built per session from the config, the registry
and the session's working directory (`src/sandbox-denials.ts`). What each session can reach, as a
table: [the trust model](../guide/trust-model.md#what-each-session-can-reach).

## The other sandboxes

- **The Codex gate** (`src/gate.ts`) runs `codex exec` inside bubblewrap: the whole machine
  read-only, every denied path hidden (a folder behind an empty tmpfs, a file behind
  `/dev/null`), only Codex's home and the iteration's directory writable, a short environment
  with no `SF_*` setting and no other tool's key. A seccomp filter refuses new `AF_UNIX` sockets,
  and syscalls of another architecture that could get around it, so the abstract sockets of the
  machine stay out of reach while TCP to OpenAI works (`gateWrapper`, `src/sandbox-denials.ts`;
  `src/seccomp.ts`). With the sandbox on, the gate never runs without the wrapper
  (`gate_sandbox_unavailable`).
- **The workspace's test command** (`src/test-command.ts`) runs code the Implementer wrote, so the
  factory builds its own bubblewrap sandbox: the file system read-only with the denied paths and
  `/run` hidden, only the worktree (not its `.git`) and a private in-memory `/tmp` writable, no
  network but its own loopback, an environment of `PATH`, `LANG`, `CI`, `HOME`, `TMPDIR` and
  `npm_config_cache`, its own process namespace that dies with the runner. A fingerprint of `.git`,
  `.claude/`, `.mcp.json` and `.codex/` taken before and after fails a run that changed them.
  Without `bwrap` it does not run at all (`tests_unavailable`).
- **The Claude Code planner** runs in a planning copy whose `.claude/settings.local.json` the
  factory writes: the copy read-only, Write and Edit only in the prototypes folder, the shell in
  Claude Code's sandbox with no network, the secrets denied to every tool, web search and fetch
  denied, artifacts off (`src/planning-copy.ts`).

## Denials and how they are recorded

- **Tool calls the session's permission checks refused** are listed by tool name, never with
  their input, in the iteration's `meta.json` (`denials`) and in the Report under
  `## Denied actions`, which the reviewers read (`publish`, `src/execution/turns.ts`).
- **The file-tool guard's refusals** carry a reason the agent reads, such as "… is agent
  configuration; the factory does not let a job change it". Like every message of the session, it
  is in the job's `events.jsonl` and on the dashboard's Stream.
- **A command the Bash sandbox stops** simply fails inside it; its output is in `events.jsonl` like
  any other. The factory does not count those.
- **A session that would start weaker does not start**, and the job stops with the reason:
  `user_settings_weaken_sandbox` (naming the key and the path), `sandbox_unavailable`,
  `gate_sandbox_unavailable`, `path_denial_unrepresentable`, `watched_path_unsafe`, and
  `invalid_config` for a `SF_SANDBOX_ALLOW_READ` entry that would open a denied path.
- **`sf smoke` proves the denials** on the real Claude Code and Codex after every update
  ([Testing](testing.md#the-live-smoke-test)).

## The guard on what is published

The guard (`src/guard.ts`) scans text before the factory publishes it, with two sources of terms
([Configuration: the guard](../guide/configuration.md#the-guard)):

- **Secrets, in every workspace:** the values of `auth.env` keys ending in `TOKEN`, `SECRET`,
  `PASSWORD` or `API_KEY` and of `SF_NTFY_URL` (12 characters or more, not a number or a
  boolean), the dashboard and MCP tokens, and known key formats: private key blocks, GitHub,
  GitLab, OpenAI, Slack and AWS keys (`SECRET_PATTERNS`).
- **Names, in a workspace with `"guard": true`:** the names, Git hosts, ticket key prefixes and work
  email domains of the user's other workspaces, built from the registry and the jobs at every
  check (public hosts and mail domains left out), plus the private list `guard-terms.txt` in the
  config directory, which never lives in a repository: whole words, `re:` expressions, and `!`
  lines that drop a false positive.

It runs at three points: at Clean on the change as the factory would commit it (a hit becomes a
Fix section `Guard`, at most twice); on the MR text (two more MR text turns, then a stop); and
before every push or merge request the factory makes, on the commits the push publishes (message,
added lines, new paths), the branch name and the MR text. A hit there refuses with `guard_hit` and
pushes nothing. Every file is read as text whatever its attributes, and in a guarded workspace a
push that holds LFS files is refused, since only their pointers can be read. Only `sf guard` and
its pre-push hook (`sf guard install-hook`) print a match, never a secret's; every other message
names places only.

## Secrets

| Secret | Where it lives | Who uses it |
| --- | --- | --- |
| The settings, with the Git host and ntfy tokens | `auth.env` in the config directory | `sf serve` and the runners; no session gets an `SF_*` variable, and the Git host tokens reach no child process (`withoutHostTokens`, `src/forge.ts`) |
| The dashboard and MCP tokens | `dashboard-token`, `mcp-token` (0600) in the state directory (`src/secrets.ts`) | the two listeners, compared in constant time (`sameSecret`, `src/http.ts`) |
| The tunnel's key and the MCP URL with the token | `tunnel-runtime.key` in the config directory; the tunnel client's profile | the tunnel client |
| The MCP URL as Claude Code stores it | `~/.claude.json`, after `claude mcp add` | the user's Claude Code; denied to every session the factory starts |
| The Claude and Codex logins | Claude Code's credentials; `~/.codex` | the CLIs themselves; sandboxed commands see no Anthropic or cloud credential variable |
| SSH keys, Git credentials | `~/.ssh`, the credential helper | only the factory's own fetch and push, outside the sandbox |

They stay out of prompts and logs in five ways:

1. **No agent's tools or commands can read them** (the denials above), so none can put one into a
   prompt. The one exception is by design: the gate's wrapper binds back Codex's own home, whose
   login goes to OpenAI anyway.
2. **No session's environment holds them**: sessions get the basics and their own provider's
   variables; sandboxed commands not even those (`sessionEnvironment`, `sandboxEnvDenials`,
   `src/session.ts`).
3. **The planner's tools and the Patch leave them out**: `read_file` refuses credential-like names
   and Git-ignored files, links resolved (`src/repo-files.ts`); the Patch leaves out ignored and
   credential-like paths (`src/patch.ts`).
4. **Reviewer output is redacted** before it is stored or sent: keys in known formats, environment
   values (in a verdict's text, those of 8 characters or more) and both tokens become `[redacted]`
   in verdicts, items and the reviewers' live events, and Codex's raw answer file is deleted once
   read (`src/redact.ts`).
5. **Logs name places, not values**: `sf serve` prints the dashboard URL as `/d/<token>/`; the
   tunnel's output shows the token as `<token>` (`src/tunnel.ts`); error messages carry no absolute
   host paths (`src/errors.ts`); a Git host token goes only in the `Authorization` header of a
   request to its own host, with redirects refused (`src/forge.ts`).

## Untrusted input

| Input | Read by | What holds |
| --- | --- | --- |
| The repository: code, docs, `AGENTS.md`, fixtures | every session | The sandbox bounds what a session can do; the reviewers are read-only and told to verify the Report's claims against the Patch, not to trust them ([review rules](../../factory/HANDBOOK.md#review-rules)) |
| The Task file and its images | the Implementer, the reviewers, the Task check | The reviewers read the factory's own copy of the Task file, not the worktree's, which the Implementer can write; images are checked by their bytes (PNG, JPEG, WebP, GIF, at most 10 of 5 MB each, `src/attachments.ts`) |
| Web content | a planner | The Implementer, the Claude review, the simplification pass and the Task check have no web tool; the Claude Code planner's web search and fetch are denied |
| A merge request's review comments | the Implementer of a job from review comments | Quoted in its Task file "as the reviewers wrote them … the requests to address, not instructions about how the factory works" (`src/review-job.ts`) |
| Other people's commit messages | the morning digest | One model call with no tools and no MCP server (`src/digest-run.ts`) |
| A pin placed on another page | the coordinator | Read as data, never as instructions ([runbook](../runbooks/coordinator.md#context-and-usage)); the page reaches the factory only through a window it opens, after the user's Allow ([trust model](../guide/trust-model.md#point-mode-on-other-pages)) |
| A planner's suggestion | the user | Stored, never sent by itself: only the user's Send gives it to the Implementer, and only the text the page showed (its SHA-256 is checked, `src/planner.ts`) |
| A model's claims | the factory | Checked, not believed: a contest counts only with evidence the factory finds (`findEvidence`, `src/ledger.ts`), a quote of the user must be in the user's message, the commit is the reviewed tree, the MR text meets its rules, and no model's claim of the user's approval is ever acted on |

Agent configuration is the injection path that outlives a session, so it is closed at every
place it could be written: the file-tool guard and `denyWrite` keep the Implementer out of the
worktree's `.claude/`, `.mcp.json`, `.codex/` and `.git`; every job session runs with
`disableAllHooks`; the test run fails if it changed them; the factory's Git calls run no hooks; the
automatic hand-over leaves a change to such a file for the user to read first.

## The Claude Code trust dialog

The factory accepts Claude Code's trust dialog only for its own planning copies, and only with the
user's consent ([SECURITY.md](../SECURITY.md)). With the default `SF_PLANNER_TRUST=ask` the user
runs `sf planner trust` and answers the dialog; with `auto`, set once in the factory's
configuration, `sf planner setup` and `sf planner start` answer it in a terminal of their own as
the user would, only for the folder the setup made and only while its working tree holds none of
the repository's Claude Code configuration. A planning copy is checked out without anything the
repository tracks under `.claude/` but its `CLAUDE.md`, and without its `.mcp.json`
(`src/repository-config.ts`). The factory reads Claude Code's global config to know whether the
copy is trusted and never writes it (`src/planner-session.ts`).

## The planning connection

- **The MCP endpoint** (`src/server.ts`) listens on `127.0.0.1` only, rejects a Host or Origin that
  is not local before any routing, and answers only a request with the MCP token, in the path
  (`/mcp/<token>`) or as `Authorization: Bearer`, compared in constant time. The token is read
  from its file on every request, so a rotation (`sf mcp-url --rotate`) counts at once and an
  unreadable file refuses everything. The token goes no further than that check.
- **The tunnel** to ChatGPT has no inbound port: the tunnel client makes an outbound HTTPS long
  poll to OpenAI and forwards requests to the loopback endpoint. The transport is authenticated by
  the tunnel's runtime key; the ChatGPT connector is set to No authentication, because the tunnel
  client, not the connector, holds the factory's token, and the tunnel is registered in the
  user's OpenAI organisation, which decides who may use it
  ([runbook](../runbooks/chatgpt-connection.md#how-a-request-travels)).
- **The tools only plan.** None starts, reviews, approves or pushes a job; `queue_add` only queues
  a written ticket and `suggest_changes` only stores a note.
- **Claude Code as a client** registers the server as `software-factory`, never with
  `--scope project` (which would write the token into the repository's `.mcp.json`). Every job
  session and the Task check deny that server's tools.

## The dashboard and remote access

- **Local** (`src/dashboard.ts`): a loopback listener; every path behind `/d/<token>/` or the
  cookie of a token visit (`HttpOnly`, `SameSite=Strict`); Host and Origin checked; a content
  security policy with `frame-ancestors 'none'` and `X-Frame-Options: DENY`; strict, bounded JSON
  bodies on every action, each delegated once to the job lifecycle. The pages it builds from other
  content (a workspace's vision, a planner's prototypes) are served under their own policy, as an
  opaque origin that can use neither the dashboard's cookie nor its API.
- **Remote, through Tailscale**: `tailscale serve` (never Funnel) proxies the tailnet address to a
  second listener on `127.0.0.1:8789`. Its origins must be `https://<machine>.<tailnet>.ts.net`
  (`SF_DASHBOARD_REMOTE_ORIGINS`), and `SF_DASHBOARD_REMOTE_LOGINS` is required: only requests
  that Tailscale marks with a listed login are served, every other gets an empty `403`. From there
  Approve, Retry, Create merge request, Merge, Archive and Merged — archive need the ticket typed
  again ([Operations: the dashboard on your phone](../guide/operations.md#the-dashboard-on-your-phone-tailscale)).

## Product repositories

- **Nothing is published without the user's command.** The factory never pushes or commits outside
  the MR preparation of a Clean, never opens or merges a merge request on its own, never pushes to
  `main` or `master` ([Handbook](../../factory/HANDBOOK.md#what-the-factory-never-does)). By
  default a finished job is handed over to the user's checkout, and the user commits and pushes
  from the IDE. The coordinator's rule is stricter still: in a product repository it never
  approves, pushes or opens a merge request without the user's explicit go, and that code never
  goes into published artifacts or other external pages ([runbook](../runbooks/coordinator.md#git-and-pull-requests)).
- **The user's checkout is never overwritten.** The hand-over is refused on a dirty or busy
  checkout; the job's own commit is kept as `refs/factory/ABC-12`, and Ask for changes saves a
  snapshot of the checkout as `refs/factory/ABC-12-ask` (`src/handoff.ts`).
- **The Git host tokens go only to their host**: `SF_GITHUB_TOKEN` to `api.github.com`,
  `SF_GITLAB_TOKEN` to `gitlab.com` or the host of `SF_GITLAB_URL`; on any other host the merge
  request actions are off. The pass of merged jobs sends `GET` requests only and deletes no branch.

## What runs outside the sandbox

The factory itself, as the user: the fetch, the worktrees, the commit and rebase at Clean, the
push, the merge request on the Git host, the hand-over, the notifications, the planning copy's
setup. No agent can reach these: the agents only write files in their worktree, and the factory
decides what to commit. It commits only the tree the reviewers saw. Its Git calls all start in
`src/git.ts` with `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, which no caller can switch
off, so a hook or a `core.hooksPath` that resolves into files a job wrote never runs. LFS objects
are pushed explicitly, and a job that changed `.lfsconfig` is not pushed
([trust model](../guide/trust-model.md#what-runs-outside-the-sandbox)).

## How it is checked

- **On every update**, `sf smoke` runs one real job with canaries: its Sandbox step has the
  Implementer probe the canary `auth.env`, the dashboard token, `jobs/`, `sf.sock`, `~/.ssh`, the
  SSH agent, the session bus, `docker.sock`, a canary in the home directory and the host's
  `/tmp`, and passes only when every probe was refused; its Gate sandbox step checks that the
  gate's wrapper hides the canary and refuses an abstract Unix socket
  ([factory/README.md: Live smoke test](../../factory/README.md#live-smoke-test)).
- **In the unit tests**, among others: `sandbox-denials.test.ts`, `session-wrapper.test.ts`,
  `seccomp.test.ts`, `host-tmp.test.ts`, `test-command.test.ts`, `guard.test.ts`, `redact.test.ts`,
  `mcp-auth.test.ts`, `repo-files.test.ts`, `handoff-sensitive.test.ts`, `git.test.ts`
  (`factory/test/`).
- **By independent audits**, three so far, each kept with its findings and what came of them
  ([docs/audits](../audits/README.md)). The audit of 2026-11-09 found two critical ways out of the
  sandbox (a test run that rewrote the worktree's `.git`, agent configuration a job could write);
  both are closed, and [SECURITY.md](../SECURITY.md) says when the whole was last checked.

## Limits and trade-offs

- **The network is open where it must be.** Claude and Codex are remote models, so their CLIs
  reach their providers. Bash commands reach `registry.npmjs.org` and `SF_SANDBOX_DOMAINS` only,
  but a request to an allowed domain can still carry what a session read; the gate's network is
  open but for Unix sockets.
- **Built once per session.** A path created after a session started stays reachable to it until
  the factory starts the session again.
- **Unix sockets.** Linux sandboxes allow every Unix socket or none, and repositories' tests use
  their own, so all are allowed and the known socket locations are denied instead; a socket
  elsewhere stays reachable. A repository whose tests need docker needs `SF_SANDBOX=off`, which
  drops every Bash denial.
- **Outside the home directory** a session reads what any user may read.
- **A phone lost unlocked** opens the dashboard; the dangerous actions still need the ticket
  typed.
- **The planner session answers to the user's Claude account** through Remote Control, and the
  user's claude.ai connectors load in it (each asks before a call); a prototype's script runs in
  the user's browser under a policy that cannot close every channel.
- **The guard reads text, not intent.** A secret in a format it does not know, or a name the user
  did not list, passes; and it checks what is published, not what reaches a model provider.

The complete list: [the trust model: the limits](../guide/trust-model.md#the-limits) and the
"Open" section of [SECURITY.md](../SECURITY.md#open).

Next: [Data flows](data-flows.md).
