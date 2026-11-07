# The trust model

The factory runs agents on your machine, as you. This page says what each session it starts can
and cannot reach, what the factory does itself outside any sandbox, and the limits you should know
about. The exact rules are in the reference, [factory/README.md](../../factory/README.md)
(section Jobs, "The path denials").

## The idea

An agent session needs its own worktree, the repository's checkout and a package registry. It
never needs your credentials, the factory's own state or other people's jobs: the factory fetches,
commits, rebases, pushes and opens merge requests itself, outside the sandbox. So every session
the factory starts is denied what it does not need, in two places at once:

- **the tools** (`Read`, `Edit`, `Write`, and the `Grep` and `Glob` searches as far as Claude Code
  applies `Read` rules to them): permission deny rules in the session's `disallowedTools`;
- **Bash**: Claude Code's sandbox (bubblewrap on Linux) with the same paths in its
  `filesystem.denyRead` and `filesystem.denyWrite`, and network access only to `registry.npmjs.org`
  and the hosts in `SF_SANDBOX_DOMAINS`.

A job's sessions (the Implementer, the Claude review, the simplification pass) also get a
**file-tool guard**: a `PreToolUse` hook that checks every file tool call by its real path, links
resolved (below). The web tools `WebFetch` and `WebSearch`, which the sandbox does not hold, are
denied to every job's turns.

The denials are built for each session when it starts, from the factory's config, the workspace
registry and the session's own working directory.

## What no session can reach

Denied for reading and writing, in every session (the Implementer and its MR turns, the Claude
review, the simplification pass, the Task check):

| What | Why it matters |
| --- | --- |
| The factory's config directory and the env file it loads (`auth.env`) | every token: Git hosts, notifications |
| The state directory, but `worktrees/`: `sf.sock`, `dashboard-token`, `mcp-token`, `jobs/`, `checks/`, `queue.json`, the logs | `sf.sock` and the tokens accept approve, accept and merge; the jobs hold every Report and review |
| Other jobs' worktrees: every other workspace's folder, and every other ticket in the own workspace | another ticket's work in progress |
| Other workspaces' checkouts (from the registry) | other repositories |
| The tunnel client's profile (`$TUNNEL_CLIENT_PROFILE_DIR` or `~/.config/tunnel-client`) | the MCP token |
| Claude Code's global config (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`) and its backups (`~/.claude/backups`) | the MCP URL with its token, once `claude mcp add` stored it; the global config is denied for writing too (below) |
| `~/.ssh`, `~/.codex`, `~/.aws`, `~/.config/gh`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.netrc`, `~/.npmrc`, `~/.claude/.credentials.json` | your keys and logins |
| The Task checks' checkouts (`<temp>/sf-task-checks-<uid>/`) | the Task files being checked |
| Where your Unix sockets live, when they exist: `/run/user/<uid>` and `$XDG_RUNTIME_DIR`, `/run/dbus`, `/var/run/dbus`, `/run/docker.sock`, `/var/run/docker.sock`, `/run/containerd`, `/run/podman`, `/run/tailscale`, `/var/run/tailscale`, `/run/screen`, `/tmp/.X11-unix`, every `/tmp/ssh-*` and `/tmp/tmux-<uid>` | the D-Bus session bus (the systemd user manager runs commands outside any sandbox), docker, tailscaled, your SSH agents and tmux |

Denied for reading: the `.env` and `.env.*` files that exist in the session's worktree and its
workspace's checkout (tracked or not, ignored ones included; a folder Git cannot list is walked
instead), but `.env.example`, `.env.sample` and `.env.template`. The tools are also denied every `.env` and `.env.*` path by pattern.

Every session also denies the tools of the MCP server named `software-factory`, the name under
which you add the factory to Claude Code: a server added in the `user` scope loads into every
session, and none may call the planning tools with the token Claude Code holds for it.

Denied for writing (the global config for reading too, above): Claude Code's user settings and
global config (`~/.claude/settings.json`, `~/.claude.json`), which the next session would load and which could switch the sandbox's
filesystem rules off or start an MCP server outside it; the factory also pins filesystem isolation
on in its own settings, which outrank yours. And the factory's own installation, so an agent cannot
change the factory that runs it (unless the session's own repository is the factory's clone: the factory developing
itself).

Before each Implementer, review and simplification session starts, the factory reads your user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`): if it sets `sandbox.enabled` false, `sandbox.filesystem.disabled` true, or an `allowRead`/`allowWrite` entry covering a denied path, or cannot be read as JSON, the session does not start and the job stops with `user_settings_weaken_sandbox`, naming the key and the path (a missing file is fine).

No session gets your SSH agent (`SSH_AUTH_SOCK` is not passed on), and neither does the Codex gate.

## The home directory

A job's sandboxed commands read nothing in your home directory but what a build needs, the
**kept paths** that exist:

- the job's own worktree and its workspace's checkout;
- Git's configuration: `~/.gitconfig`, `~/.config/git`;
- the Node toolchains and their caches: `~/.npm`, `~/.nvm`, `~/.volta`, `~/.local/share/fnm`,
  `~/.local/share/pnpm`, `~/.yarn`, `~/.bun`, `~/.node-gyp`, `~/.cache/node`, `~/.cache/node-gyp`,
  `~/.cache/pnpm`, `~/.cache/yarn`, `~/.cache/ms-playwright`, and `~/.local/bin`;
- Claude Code's shell snapshots (`~/.claude/shell-snapshots`, or under `$CLAUDE_CONFIG_DIR`),
  which every Bash command sources first;
- the entries of `SF_SANDBOX_ALLOW_READ`, for other toolchains (`.m2/repository,.gradle/caches`,
  [configuration](configuration.md)). An entry that is, holds or lies in a denied path (such as
  `.ssh` or `.config`), or that is or holds the home directory itself (`.`, or a link to it or to
  `/`), stops the session with `invalid_config`.

Every other entry of the home directory, and of each folder on the way down to a kept path, is in
the sandbox's `denyRead`; the same holds for Claude Code's configuration directory when
`CLAUDE_CONFIG_DIR` puts it outside the home. Nothing is re-allowed with `allowRead` (which would win over every denial
inside what it re-opens), so the denials above still hold inside a kept path: a `.env` in the
checkout, say. Your user settings are held against those specific denials only: an `allowRead` of
`~/projects/**` there is yours to make; one of `~/.ssh` stops the job.

## The file-tool guard

The permission rules match paths as written, and Claude Code asks them only when a call would
otherwise prompt. So every job session also gets a `PreToolUse` hook, which runs in every
permission mode (`auto` and the smoke's `dontAsk` included) and checks each call by its real path
(for a new file: the nearest existing folder's real path plus the rest):

- `Write`, `Edit`, `MultiEdit` and `NotebookEdit` pass only inside the job's own worktree, outside
  its `.git`. A link in the worktree that points out of it does not help.
- `Read`, `Grep`, `Glob` and `LS` are refused in the home directory outside the kept paths and
  the session's own Claude Code project folder (`~/.claude/projects/<the worktree's path, every
  character but letters and digits as ->`), where Claude Code keeps the session's transcript and the
  tool output it saves. Bash is still denied that folder.
- `Glob` and `Grep` walk the folders below their path. The installed Claude Code runs ripgrep for
  them without following links, but the guard holds them as if they did: it walks every folder the
  search would reach (its path, or the working directory, and each fixed part of a `Glob` pattern),
  following each link to a folder, outside the worktree too (the temporary directory, a toolchain).
  A search is refused when its folder, or a link anywhere below it, is a refused path or holds the
  home directory (a search of `/home`), naming the path. A folder or link the guard cannot read
  for another reason than its absence or a refused permission refuses the call.
- A `~` path, or an input the guard cannot read, is refused; the reason names the path.

## Environment

A session gets the basics (`PATH`, `HOME`, the locale, proxies), the Anthropic and Claude Code
variables, and the cloud providers' (`AWS_*`, `GOOGLE_*`, `CLOUD_ML_*`) only when Claude Code itself
runs on Bedrock or Vertex (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`): a workspace never
needs them. Sandboxed commands see none of the credentials passed: every `ANTHROPIC_*`, `AWS_*`,
`GOOGLE_*`, `CLOUD_ML_*` and `CLAUDE_CODE_OAUTH_TOKEN` is unset for them
(`sandbox.credentials.envVars`, mode `deny`), in the Implementer's turns and in the review, the
simplification pass and the Task check alike.

## What each session can reach

| Session | Reads | Writes | Runs commands |
| --- | --- | --- | --- |
| Implementer (and its MR turns) | its worktree, its workspace's checkout (with its `.git`), the kept paths of the home directory, the rest of the machine outside the home directory but the paths above | its worktree (outside its `.git`, the guard), the sandbox's temporary directory | Bash in the sandbox |
| Claude review, simplification pass | as the Implementer, with the guard | nothing (read-only tools) | none |
| Task check | its own checkout of the Task's base only (a path guard on every tool call) | nothing | none |
| Codex gate | Codex's own read-only sandbox: the files of the machine | nothing | read-only |

## What runs outside the sandbox

The factory itself, as you: `git fetch`, the worktrees, the commit and rebase at Clean, the push,
the merge request on the Git host, the hand-over to your checkout, the notifications. None of these
are open to an agent; the agent only writes files in its worktree, and the factory decides what
to commit.

No Git call of the factory runs the repository's hooks or its fsmonitor: every one starts in one
place (`factory/src/git.ts`) with `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, and no
argument or environment variable switches that off. A hook such as a `pre-push`, or a
`core.hooksPath` such as `.husky` that resolves into files a job wrote, would otherwise run code an
agent wrote, outside the sandbox. Your own Git commands in your checkout still run your hooks.
Git LFS objects, which a `pre-push` hook (`git lfs pre-push`) used to send, are pushed explicitly
with `git lfs push` before the branch, and only when the job changed LFS files; a job that changed
`.lfsconfig` is not pushed (that file could send the objects and your credentials elsewhere), nor
is any job while the `.lfsconfig` git-lfs reads in your checkout (where another job may be handed
over) is not the base branch's.

## The workspace's test command

A workspace's `test_command` (in `workspaces.json`) runs code the Implementer wrote, so the factory
never runs it with its own reach. It runs it in a bubblewrap (`bwrap`) sandbox it builds itself,
before the MR text, on the reviewed worktree:

- the whole file system read-only, and every path of the table above hidden: a directory shows as
  empty, a file as empty (`/dev/null`). So `auth.env`, `sf.sock` and the tokens are out of reach;
- `/run` hidden too, with the Unix sockets in it (your D-Bus and systemd user manager, the SSH and
  keyring agents, Docker): through them a command could start a process outside the sandbox;
- only the job's worktree and a private `/tmp` writable; that `/tmp` is the sandbox's own in-memory
  file system, so it is gone with the sandbox, also when the runner was killed mid-run (it uses
  memory, not disk: a suite that writes much to `/tmp` needs the memory for it);
- no network (a network namespace of its own); loopback works, for tests that start a server;
- an environment of `PATH`, `LANG`, `CI=1`, your `HOME` (read-only), `TMPDIR=/tmp` and
  `npm_config_cache=/tmp/npm-cache` only: no `SF_*` setting and no value of the env file;
- in a process namespace of its own that dies with the runner (`--die-with-parent`,
  `--unshare-pid`): no process of the run outlives it, however the runner ends; a timeout
  (`SF_TEST_TIMEOUT_MS`) or an abort kills the run's whole process group.

Without `bwrap` the command does not run at all (`tests_unavailable`); there is no fallback outside
the sandbox. It runs with the runner's control group and nice value, so the service's CPU limits
apply.

## The limits

- **Built once per session.** A worktree or state entry created after a session started stays
  readable to it until the factory creates the session again (a new job, a restart of the
  runner, a recovered job). A denied path that is gone since is left out of later commands, so the
  sandbox leaves no placeholder for it.
- **The Task check** does not deny the Task checks' parent directory, because it runs inside it: a
  check could read another check's checkout running at the same time.
- **The Codex gate** has only Codex's own read-only sandbox: it can read files the paths above
  deny to Claude. It cannot write, and it gets no SSH agent and no `SF_*` setting.
- **Unix sockets.** On Linux the sandbox can allow every Unix socket or none (allowing them by path
  is macOS only), and the repositories' tests use sockets of their own, so all are allowed. The
  known socket locations above are denied instead; a socket elsewhere, in a path not denied, stays
  reachable. `sf.sock` is in a denied path; whether that refuses a `connect()` to it, and to the
  session bus and `docker.sock`, is what the `Sandbox` step of `sf smoke` checks. Abstract sockets
  belong to a network namespace and stay out of reach. A repository whose tests need docker needs
  `SF_SANDBOX=off`.
- **Outside the home directory** a session still reads what the paths above do not deny (`/etc`,
  `/opt`, other users' readable files). The guard and the home denials cover your home only.
- **Very large worktrees.** A search that would walk more than 50,000 folders is refused, links or
  not: give it a narrower path.
- **Links made while a search runs.** The guard walks a search's folders for links when the call
  is made; a link a background command makes after that check, while the search runs, is not seen.
- **A checkout or worktree that is the home directory** (or holds it) keeps it whole: nothing in
  it is denied as a home entry, only the specific denials above.
- **Claude Code's other folders** (`~/.claude/projects` of other sessions, its plugins, its
  settings) are denied to the tools and to Bash alike: a tool that needs one of them fails.
- **The Task check** keeps its own path guard (its checkout only); the file-tool guard is the job
  sessions'.
- **No command outside the sandbox.** Claude Code would let a session ask to run a command
  without the sandbox, and a project's `.claude/settings.json` could switch the sandbox off; the
  factory sets `allowUnsandboxedCommands: false`, so neither works: every Bash command runs
  sandboxed, with the denials. A repository whose checks cannot run in the sandbox needs
  `SF_SANDBOX=off`.
- **Unusual path names.** A denied path whose name Claude Code would cut into pieces as a permission
  rule (a space or comma after a `)`, as in `a (b) c`) stops every session with
  `path_denial_unrepresentable` instead of running it without that denial: rename the folder.
- **`SF_SANDBOX=off`** keeps the tool rules and drops everything Bash was denied: commands then run
  with your full access.
- **Your own checkout.** A session reads its workspace's checkout as before, including its other
  Task files in `.software-factory/`.

## Checking it

`sf smoke` has a `Sandbox` step: the job's Implementer runs a probe of the run's own canary env
file, dashboard token, `jobs/`, `sf.sock`, `~/.ssh` and `SSH_AUTH_SOCK`, and of the session bus,
`docker.sock`, a canary file the smoke makes in your home directory (`~/.sf-smoke-<suffix>/canary`,
removed at Cleanup) and `~/.claude/projects` inside its sandbox, and the step passes only when every
one was refused (absent only where the path is really missing; the home canary never). It also
checks that the Implementer was offered no `WebFetch` or `WebSearch`, and that its `Write` of a file
outside the worktree left no file and was refused by the file-tool guard. So that the probe reaches the sandbox, only the
smoke's Implementer runs in permission mode `dontAsk`, without the auto mode classifier, for its
own temporary state only: it may run any `node probe.mjs …` call (a prefix rule, in that session
only, so the probe still reaches the sandbox when the Implementer adds to its command line) and
the file tools its ticket needs (`Read`, `Edit`, `Write`, `Glob`, `Grep`, `TodoWrite`), and any
other tool call is denied, not asked. That mode also approves any Bash command that runs in the sandbox and the allow rules of
the Claude Code settings it loads, with no classifier. This is safe there: every such command runs
in the same sandbox with the same path denials as a real job's, the smoke works in its own
temporary directory on canary data, and that sandbox is what the step checks. Real jobs keep mode
`auto` and the classifier, with no extra allow rule. See [Install: check that it works](install.md#check-that-it-works).

Back to the [guide](README.md).
