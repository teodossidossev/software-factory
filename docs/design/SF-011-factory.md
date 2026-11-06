# SF-011 design: the factory, rebuilt around the Idle gap

Historical: the current behaviour is specified in factory/README.md.

Status: agreed design, 2026-11-01. Nothing implemented yet. Vocabulary: `CONTEXT.md`. Decisions:
`docs/adr/0001` to `0003`. This replaces the SF-009/SF-010 direction (OpenClaw transport, file-based
supervisor, MCP Events, Keycloak) and the deferred reproducible-setup proposal.

## 1. The workflow it serves

1. The User gets a Ticket in Jira and plans it with the Context owner (ChatGPT, web), which reads the
   Workspace's read checkout: AGENTS.md, coding and documentation standards, project documentation.
2. The solution is split into subtasks of roughly one merge request each (about 20-30 files, a soft
   limit). Each subtask is one Task file: `.software-factory/<ticket>.md` in the work checkout.
3. The User says "start". The factory creates the Branch and the Implementer runs
   `/implement .software-factory/<ticket>.md`.
4. A ChatGPT scheduled task calls `check`. When an Iteration is ready, the Context owner reads the
   Report and the Patch, reviews, and either appends a Fix section (`request_fix`), which starts the
   next Iteration (`/implement <file> Fix N`), or declares Clean (`mark_clean`).
5. On Clean the User is notified, reads the Branch in the IDE, and runs `sf approve` (MR preparation
   and push) or `sf abort`.
6. The User opens the merge request.

The User types nothing to ChatGPT between "start" and human review.

## 2. Components

One Node.js process, `factory/`, in TypeScript, using the MCP SDK v2 server (as today) and the
Claude Agent SDK. It serves:

- **MCP tools** on `127.0.0.1:8787/mcp`, through the existing tunnel and connector (no auth,
  loopback, unchanged): `guide`, `read_file`, `search`, `write_task`, `start`, `check`,
  `request_fix`, `mark_clean`. Reads and searches work on the read checkout of a Workspace, with the existing
  credential exclusions and ignored content skipped. `write_task` is confined to
  `.software-factory/` of the work checkout.
- **The Implementer session** per Job (Agent SDK, `permissionMode: auto`, `cwd` = work checkout,
  the User's settings and skills, Claude Code's sandbox with the npm registry and the GitLab host
  allowed). Deny rules: during Iterations every mutating Git command (commit, push, merge, rebase,
  amend, reset, checkout, switch, stash, clean), `sudo`, `.env*`, `.git/**`. During MR preparation
  rebase, add and commit are allowed; push is done by the factory.
- **CLI `sf`**: `start`, `watch` (live stream of the session), `say` (a message into the session),
  `approve`, `abort [--discard]`, `reset`, `status`.
- **Notifications**: ntfy (phone) and a desktop notification, for `ready_for_human_review`,
  `needs_human`, `pushed` and errors. Iterations are silent.
- **Dashboard** (later): read-only v1 served by the same process (HTML, server-sent events,
  loopback, a random token in the URL); v2 adds approve, abort and say.

- **The Handbook** (`factory/HANDBOOK.md`): the single text that tells any Context owner, whichever
  model it is, how to work with the factory. Its first section is returned as the MCP server
  `instructions` at connect time; `guide` returns it in full; the file is readable for models
  without MCP access (pasted, or as project instructions). It covers the cycle, the tools and
  their order, the Task file header and `Fix N` sections, Clean, the check intervals, the Report
  template, the Git rules and the MR template. It never contains Ticket context: that is the Task
  file. A model that takes over mid-Ticket calls `guide`, then `check`, and has everything.

State lives in `~/.local/state/software-factory/`: the Workspace registry, per-Job state, the
Report and Patch of every Iteration, and the Git rules and templates.

## 3. Job lifecycle

| State | Meaning | Next |
|---|---|---|
| `starting` | Checkout verified clean, `git fetch`, Branch created from `origin/<base>` (base from the Task file header, default master). Submodules updated only on explicit request | `working` or `failed` |
| `working` | An Iteration runs | `awaiting_review`, `needs_human` |
| `awaiting_review` | Report and Patch ready; `check` returns them | `working` (Fix section), `ready_for_human_review` (Clean) |
| `needs_human` | 5 Iterations without Clean, an error, or the sandbox refused something essential. The session stays alive | `working` (`sf say`), `aborted` |
| `ready_for_human_review` | Clean; User notified | `preparing_mr`, `aborted` |
| `preparing_mr` | Rebase, conflicts, commits by the Git rules, MR title and description by the MR template (the `visual-pr` text, GitLab-adapted); then the factory verifies branch name, commit header, that the Branch is rebased and that the diff to the target equals the reviewed Patch | `pushed`, or back to `awaiting_review` if the diff changed |
| `pushed` | Pushed to origin; User notified with the Branch name | `closed` (User opens the merge request) |
| `aborted` | Session ended; changes left in place (`--discard` resets the Branch) | — |

Limits: one active Job per machine in v1 (`max_concurrent_jobs = 1`), 5 Iterations per Job,
`maxTurns` and a USD budget per Iteration from configuration.

## 4. Check intervals

`SF_CHECK_AFTER_START_MIN` (default 15) and `SF_CHECK_AFTER_FIX_MIN` (default 5). `start` and
`request_fix` return "check again in N minutes"; the Context owner creates the scheduled task with
that interval once, in the planning conversation. An early `check` answers "still working".

## 5. Report and Patch

The Report follows the Report template: what was done, tests run and their results, open questions,
and for a Fix Iteration a table of each requested item with fixed / rejected and the reason. The
factory appends the changed-file table (files, line counts, a warning above 30 files). The Patch is
`diff` against the base branch including untracked files, excluding ignored and credential-like
paths, at most 2 MiB; a changed submodule pointer is reported, never applied.

## 6. Order of work

1. Stop the self-hosting supervisor and OpenClaw now. Keep `bridge/` and the tunnel until the switch.
2. `factory/` core: the Handbook, tools, session, Task file, check/fix loop, notifications. Pilot: the Software
   Factory repository itself, with the Implementer in a separate clone. The pilot verifies that the
   scheduled task sees the planning conversation's context.
3. MR preparation, with the Git rules, the Report template and the MR template written together with
   the User.
4. Dashboard v1.
5. Delete `bridge/`, `deploy/openclaw`, `deploy/keycloak`, `scripts/openclaw`, `scripts/sf0*`,
   `config/openclaw`, and retire the SF-004 to SF-010 runbooks. Reports and designs stay as history.

Later, as separate tasks: Dashboard v2, Jira and Git integrations (the Job already records ticket
key, Workspace and Branch for them), concurrent Jobs.

## 7. Known limitations, accepted

- The sandbox covers Bash only; Read, Edit and Write follow deny rules. No further detectors.
- Nothing proves that the User approved in ChatGPT; `start` is trusted like `factory_authorize_execution` was.
- The Idle gap equals the check interval, not zero, until a push trigger exists.
- `socat` must be installed for the sandbox network; `bubblewrap` is present.
