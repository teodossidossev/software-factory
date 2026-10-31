# Runbook: SF-007 operator console and approved Claude launch

The operator console runs in your own terminal and does three things:
- it lists OpenClaw-accepted jobs;
- it shows a job's exact instruction;
- it takes your decision from the keyboard.

**Approve & Run** then runs the existing SF-006 adapter for that job in the same terminal:
1. preflight and prepare;
2. Claude Code `/implement` in manual permission mode;
3. "Did /implement finish?";
4. collect.

You stay in control of the task, every Claude permission, the review, and Git.

Since Review 01 there is no web page and no network listener. Design and threat model: `docs/design/SF-007-local-operator.md`. Manual fallback: `docs/runbooks/claude-execution.md` (`scripts/sf006-execute.sh`).

## Consent boundaries

- **Acceptance is not authorization.** OpenClaw acceptance and a message in ChatGPT are never an approval. Discovery only lists a job.
- **An approval is what you type in the console** (`a` on a job you reviewed). It covers exactly the request id and instruction SHA-256 shown, and the app repository configured at that moment. It is:
  - used once;
  - expired after 15 minutes if unused;
  - checked again before anything is written to the app repository.
- **In the session:**
  - You answer Claude Code's workspace-trust and permission prompts (`--permission-mode manual`; never `-p`, auto or skip-permissions).
  - After Claude exits, you answer "Did /implement finish …? [y/N]".
- **One session at a time on this host**, whether started from the console or the manual CLI. A second launch is refused and nothing is claimed.
- **Never automatic:**
  - nothing starts by itself;
  - a job whose `launch.claim` exists never launches again: a new attempt needs a new job id from ChatGPT;
  - ChatGPT is not notified: ask it to review the finished job.
- **Yours alone:** Git staging, commits, pushes and accepting the code.

## One-time setup (opt-in, by you)

Prerequisites:
- the bridge is built (`cd bridge && npm run build`);
- `python3` is installed (Linux Mint default; it holds the session gate);
- `gnome-terminal` is installed;
- the app is registered with its private `.env` (SF-006 runbook);
- Claude Code is logged in, and the personal `/implement` skill exists.

There is nothing to enable or start: no service, listener or pairing. Optionally, install a desktop launcher that opens the console in one click:

```bash
scripts/sf007-operator.sh render-assets ~/sf007-assets       # writes one file, installs nothing
cat ~/sf007-assets/sf007-operator-console.desktop
install -m 0644 ~/sf007-assets/sf007-operator-console.desktop ~/.local/share/applications/
```

Or just run `scripts/sf007-operator.sh` (the console) in any terminal.

## Daily use

1. Agree on the task with ChatGPT and authorize the dispatch, as before. OpenClaw accepts it.
2. Open the console: the "Software Factory operator console" launcher, or `scripts/sf007-operator.sh`. The queue shows the job as `awaiting_operator`.
3. Type its number, or `app/job`, and Enter. The console shows the request id, the SHA-256 and the exact instruction text. Control characters appear as escapes such as `\x1b`, so the text cannot disturb the terminal.
4. Decide:
   - **`a` (Approve & Run):** preflight, prepare, then Claude Code in this terminal. Answer its prompts; when it ends, answer the finished question and read the result. Enter returns to the queue.
   - **`l` (Later):** the job stays waiting, marked deferred.
   - **`x` (Reject):** you confirm by typing `reject`. Final; the job never runs.
   - **Anything else:** back to the queue.
5. Refresh with `r`; quit with `q`. Finished jobs show their SF-006 state and the four artifact SHA-256 values.
6. Ask ChatGPT to review the job. Then review, commit and push in the app repository yourself.

| Status | Meaning | What you can do |
|---|---|---|
| `accepted` | OpenClaw accepted it, but this app cannot run here (no valid `.env`/`APP_REPO`) | Fix the registration, or ignore it |
| `invalid` | Acceptance not proven: receipt, instruction SHA-256 or record | Inspect the job directory; a new dispatch is needed |
| `awaiting_operator` | Waiting for you; a failed earlier launch is shown with its reason | `a`, `l`, `x` |
| `approved` | Approved, not yet started (expires after 15 min) | `c` (Cancel approval) |
| `launching` | A console took the approval and is preparing | Watch that console |
| `running` | The Claude session is running | Work in its terminal. If "the session process is gone", see recovery |
| `needs_inspection` (`launch_unconfirmed`) | Claimed, but whether Claude Code started could not be confirmed | Inspect the repository; a retry needs a new job id |
| `prepared` | Prepared, not started. "approve again to resume it" means the earlier launch found another session running | `a` (resume), or the shown CLI command |
| `pending_manual` | Handed off with the manual CLI | The shown command |
| `completed`, `failed`, `interrupted`, `needs_inspection` | SF-006 final states (reason and next step shown) | Review; a retry needs a new job id |
| `rejected` | You rejected it | none |

"LIST INCOMPLETE" means the queue is not complete. Either a listing limit cut it (100 apps, 1,000 jobs per app or 5,000 jobs in total), or a directory was not inspected: `factory-data`, `factory-data/apps`, an app directory or a `jobs` directory that is a symlink, not a directory, or not readable. The console names each one. This affects only what is listed; the session limit still counts every session. A mediator without `factory-data/apps` shows "not initialized yet" instead: that is a clean, empty state.

## Recovery

- **"Another Claude session is running":** a session holds the host-wide session gate, or a hand-started SF-006 session is alive. Nothing was claimed. Approve the job again when that session has ended. A job already `prepared` is resumed, not prepared twice.
- **The gate stays busy although no session is visible** (the message names a pid "or a process it started"): a process that a Claude session started in the background still holds the gate's inherited descriptor. Find the holders with `fuser -v ~/.local/state/software-factory/claude-session.lock` and let them end, or stop them yourself. **Never delete the gate file or its directory while it is held**: a new file would split the gate. Removing it while no process holds it is harmless; it is recreated (0600).
- **"the session process is gone" (`running`):** the terminal or the machine died during the session. Run `scripts/sf006-execute.sh collect <app> <job>` and answer honestly. The job ends `interrupted`, `failed` or `needs_inspection`; it is never relaunched.
- **`prepared` from the manual CLI:** `scripts/sf006-execute.sh run <app> <job>`.
- **"an approval record is unreadable":** a job's `approval.json` in `~/.local/state/software-factory/operator/jobs/<app>/<job>/` is damaged or a symlink. Approvals are refused until you inspect and remove it.
- **"the lock file is corrupt" or "another process is replacing a stale lock":** a per-job `execution.lock`, or a `.execution.lock.takeover-*` marker, in the job directory (or in the operator state's job directory) is damaged or left behind by a crash.
  1. Make sure no adapter or console process runs: `pgrep -af 'execution/cli.js|operator/main.js'`.
  2. Remove that file by hand.

  Never remove a lock while an adapter runs.
- **A hand-started session** (SF-006 `handoff`, or resuming an interrupted job):
  - Start it with the gated command the CLI prints for a handoff: `flock --nonblock --conflict-exit-code 75 ~/.local/state/software-factory/claude-session.lock claude …`.
  - To resume an interrupted session, prefix the same way: `flock --nonblock --conflict-exit-code 75 ~/.local/state/software-factory/claude-session.lock claude --resume <session id>`.

  Exit code 75 means another session is running. A session started any other way (e.g. `claude --continue` or the in-app `/resume` picker) is not counted: do not start other jobs meanwhile. Resuming a `completed`, `failed` or `needs_inspection` job by its session id is counted while it runs (Review 03), even without the `flock` prefix.
- **"Running sessions cannot be verified: <app>[/<job>] (<category>)":** the safety scan cannot rule out a hand-started session there. Every launch is refused until you fix the named place. Nothing else is affected.

  | Category | Meaning | What to do |
  |---|---|---|
  | `not JSON`, `unknown schema`, `execution.json or its job directory cannot be read` | The record is damaged or not an SF-006 record | Repair it from your backup, or move the job directory out of `factory-data` |
  | `unknown state` | The state is not one of SF-006's | as above |
  | `no valid session id` | A `running`, `pending_manual` or `interrupted` record without a valid session id: a live session cannot be ruled out | Make sure no Claude session for that job runs, then repair the record or move the job out |
  | `app directory …`, `jobs directory …` | A symlink, a non-directory, or a directory you cannot read under `factory-data/apps` | Restore a plain, readable directory |
  | `a symlink or not a directory` for `factory-data` or `factory-data/apps` | as above | as above |

  A missing `factory-data` or `apps` (never initialized), or an app without a `jobs` directory, never blocks.
- **`gate_unresponsive`** (the session gate's helper did not answer or did not end in time):
  - **"was stopped; the gate is free again":** nothing was started; just try again.
  - **"may still hold the session gate (pid N)":** that helper could not be shown to have ended, so every launch stays refused. Check it with `ps -o pid,stat,args -p N` and `fuser -v ~/.local/state/software-factory/claude-session.lock`. It is never a Claude session: only a helper that was never told to start Claude is stopped. End it yourself (`kill -9 N`), then try again.
- **`launch_unconfirmed` naming a pid "left running" (keeps the session gate):** the helper did not hand over within 30 s after the launch request. It may be, or become, a Claude session, so it was not killed. Check that pid (`ps -o pid,stat,args -p N`). Let a Claude session finish, or end the process yourself if it is a stuck helper.
- **Gate busy because of a transcript viewer:** a process whose command line contains a recorded session id also counts, for example `tail -f ~/.claude/projects/…/<id>.jsonl` or an editor on that transcript. Close it and the launch can go ahead.
- **`needs_inspection` with `launch_unconfirmed`:** the adapter took the gate and claimed the job, but could not confirm that Claude Code started. The gate helper ended before the hand-over, or Claude ended within that moment. Inspect the app repository (`git status`, the transcript if any). The job never launches again; ask ChatGPT for a new job id to retry.

## Inspect and remove

```bash
scripts/sf007-operator.sh status                     # read-only queue in the terminal
fuser -v ~/.local/state/software-factory/claude-session.lock   # who holds the session gate, if anyone
rm ~/.local/share/applications/sf007-operator-console.desktop  # remove the launcher, if installed
```

Nothing runs in the background; closing the console stops it. Accepted jobs stay pending and do not start later by themselves. The private state directory `~/.local/state/software-factory/operator/` holds approvals, decisions, launch records and `events.jsonl` (the audit log). Keep it as an audit trail, or remove it after uninstalling.

## Demo (fake Claude, throwaway repositories)

```bash
scripts/sf007-demo.sh
```

It runs the console in this terminal against a throwaway mediator, app repository and receiver under `/tmp`. It uses a fake `claude`, which asks a permission question that you answer, and the demo's own session gate. Everything is removed when you quit with `q`. It touches no real job, app, OpenClaw or Claude Code.

## Fallback

The manual SF-006 CLI is unchanged in use and now shares the session gate:

```bash
scripts/sf006-execute.sh preflight|prepare|run|handoff|collect|status <app> <job>
```

It is your recovery tool and does not need an SF-007 approval. Decisions made in the console (Reject, Later) are not checked by it.
