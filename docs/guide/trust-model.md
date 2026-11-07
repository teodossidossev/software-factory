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
| `~/.ssh`, `~/.codex`, `~/.aws`, `~/.config/gh`, `~/.git-credentials`, `~/.netrc`, `~/.npmrc`, `~/.claude/.credentials.json` | your keys and logins |
| The Task checks' checkouts (`<temp>/sf-task-checks-<uid>/`) | the Task files being checked |

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

## What each session can reach

| Session | Reads | Writes | Runs commands |
| --- | --- | --- | --- |
| Implementer (and its MR turns) | its worktree, its workspace's checkout (with its `.git`), the rest of the machine but the paths above | its worktree, the sandbox's temporary directory | Bash in the sandbox |
| Claude review, simplification pass | as the Implementer | nothing (read-only tools) | none |
| Task check | its own checkout of the Task's base only (a path guard on every tool call) | nothing | none |
| Codex gate | Codex's own read-only sandbox: the files of the machine | nothing | read-only |

## What runs outside the sandbox

The factory itself, as you: `git fetch`, the worktrees, the commit and rebase at Clean, the push,
the merge request on the Git host, the hand-over to your checkout, the notifications. None of these
are open to an agent; the agent only writes files in its worktree, and the factory decides what
to commit.

## The limits

- **Built once per session.** A worktree or state entry created after a session started stays
  readable to it until the factory creates the session again (a new job, a restart of the
  runner, a recovered job). A denied path that is gone since is left out of later commands, so the
  sandbox leaves no placeholder for it.
- **The Task check** does not deny the Task checks' parent directory, because it runs inside it: a
  check could read another check's checkout running at the same time.
- **The Codex gate** has only Codex's own read-only sandbox: it can read files the paths above
  deny to Claude. It cannot write, and it gets no SSH agent and no `SF_*` setting.
- **Unix sockets.** On Linux the sandbox can allow every Unix socket or none, and the
  repositories' tests need them, so all are allowed. `sf.sock` is in a denied path; whether that
  also refuses a `connect()` to it is what the `Sandbox` step of `sf smoke` checks.
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
file, dashboard token, `jobs/`, `sf.sock`, `~/.ssh` and `SSH_AUTH_SOCK` inside its sandbox, and the
step passes only when every one was refused. See [Install: check that it works](install.md#check-that-it-works).

Back to the [guide](README.md).
