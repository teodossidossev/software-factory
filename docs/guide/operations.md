# Operations

This page covers keeping the factory running: updating it, reading its status and metrics, logs,
cleaning up old jobs and worktrees, backup, troubleshooting, and its tests.

## Updating the factory

`sf serve` and each job's runner (`sf run`) are separate processes. A runner keeps the code it
loaded when it started until it exits; it exits when its job waits for you or has ended, and the
next runner of that job (when you answer it) loads whatever build is on disk then. Restarting
`sf serve` leaves running jobs running. There is no version check between them.

**From the clone you develop in** ([Install (a)](install.md#a-from-the-clone-you-develop-in)):

```sh
cd ~/work/software-factory
git pull
npm run setup        # npm ci and the build in factory/
# stop sf serve (Ctrl+C in its terminal), then:
npm start
```

**From a second clone used only to run it** ([Install (b)](install.md#b-a-second-clone-used-only-to-run-the-factory)):

```sh
cd ~/.local/lib/software-factory
git pull
cd factory && npm install && npm run build && cd ..   # check that the build passed
# stop sf serve, then from the clone's root:
npm run serve
```

Then:

- Run `sf smoke` after an update that changed the factory's code; it must end with `smoke: PASS`.
- **Add a new key** to `workspaces.json` (or a new setting to `auth.env`) only when no job that
  started before the update is still running: an older runner reads `workspaces.json`,
  `job.json` and `queue.json` with its own strict schema, and a key it does not know stops it.
- A changed setting in `auth.env` applies to `sf serve` once it restarts, and to each runner that
  starts after that; a runner already running keeps its settings.
- Building into a clone while a job's next runner starts can load a mix of old and new files; update
  between tickets, or use the second clone.

## sf status

```
$ sf status
WORKSPACE  TICKET  STATE                  ITER  BRANCH                           SINCE                EST_USD  ELAPSED   ERROR
my-app     APP-12  needs_human            3     APP-12-export-the-report-as-csv  2026-11-06 14:02:11  1.2345   00:41:07  gate_rounds
```

One line per current job (archived ones left out), sorted by workspace and ticket; it works without
`sf serve`.

| Column | Meaning |
| --- | --- |
| `STATE` | the job state ([Concepts](concepts.md#the-job-states)) |
| `ITER` | published iterations |
| `BRANCH` | the job's branch |
| `SINCE` | the last state change, in local time |
| `EST_USD` | the recorded cost of the published iterations and their Claude reviews, four decimals: an estimate of the API-equivalent price, not a charge (the sessions usually run on your Claude plan); `unknown` when an iteration has no cost |
| `ELAPSED` | wall-clock time since the job was created, waiting included; it stops once the job is pushed, aborted or failed |
| `ERROR` | the stop or failure code |

Below the table it adds a line for a job that went on by itself after a turn limit, and for a job
waiting for a usage limit ("waiting for the usage limit (Claude): resets at …").
`sf status my-app APP-12` shows one job with its error message, the worktree, the hand-over ("in
your checkout on …" with the MR title, or why it was not handed over), and the sensitive,
out-of-scope and deleted paths of its last iteration.

## sf metrics

```sh
sf metrics                    # every workspace
sf metrics my-app --since 2026-11-01
sf metrics --json
```

What the Codex gate cost and what its findings were worth, one row per job (current and archived,
`APP-12 (archived)`), then totals; it works without `sf serve`.

| Column | Meaning |
| --- | --- |
| `STARTED`, `STATE`, `ITER` | the day the job was created, its state, its published iterations |
| `LEVELS` | the gate level of each iteration: `F` full, `L` light (ran), `l` light (skipped), `-` none, `·` no gate decision (a Claude fix verdict, the gate off, an older job), `?` unreadable |
| `RUNS` | gate runs, failed ones included |
| `TOKENS` | the job's gate tokens (input plus output) |
| `FIXED`, `CONTESTED`, `ACCEPTED`, `NIT`, `OPEN` | the gate's findings by how they ended in the ledger, each finding counted once: fixed (also "must fix" by you), contested by the Implementer, accepted (a risk you accepted, or a blocker or major left), nits, and open (still open, escalated, or the job ended first) |
| `YIELD` | `FIXED` over all the gate's findings, nits included, as a percentage: how much of what the gate raised was worth fixing; `-` without findings |

The totals add the jobs, gate runs, tokens, findings by outcome, the overall yield, the share of
iterations at each gate level and the records that could not be read. A low yield with many tokens
says the gate costs more than it finds: consider `SF_GATE_LEVEL=auto` (the default),
`SF_GATE_MAX_ROUNDS` or Accept on churn. The exact counting rules:
[sf metrics](../../factory/README.md#sf-metrics).

## Logs: where to look

| What | Where |
| --- | --- |
| `sf serve` itself (start, the gate's state, plan-check notification failures, warnings) | its terminal (stdout and stderr) |
| Everything a job did: prompts, the Implementer's messages and tool calls, the reviewers' messages, verdicts, state changes, notes | `~/.local/state/software-factory/jobs/my-app/APP-12/events.jsonl`; read it with `sf watch my-app APP-12` or the job's Stream |
| A job's runner process (crashes, stack traces) | `jobs/my-app/APP-12/runner.log` |
| Each iteration's Report, Patch, file list, review and gate records | `jobs/my-app/APP-12/iterations/NNN/` (`report.md`, `patch.diff`, `meta.json`, `review.json`, `gate.json`, `gate-level.json`) |
| The findings and how they stand | `jobs/my-app/APP-12/ledger.json` |
| The rules a job was given | `jobs/my-app/APP-12/rules.json` (or `sf rules my-app APP-12`) |
| Task checks | `checks/my-app/APP-12/<sha>.json` |
| A plan's history | `tickets/my-app/APP-12/history.jsonl` |
| Failed notifications | `notify_failed` lines in the job's `events.jsonl` |
| The morning digests and their mirrors | `digest/<id>.json`; `digest/mirrors/<workspace>.json` (the last good fetch and the last error) |

Secrets and environment values are redacted in the logged reviewer and gate messages.

## The morning digest

Once a day after `digest.at` (`workspaces.json`, default 08:00, weekdays only by default), `sf
serve` makes the morning digest of the workspaces that are followed (`digest.track`) or have My
daily on (`digest.my_work`). The dashboard's **Digest** (in the header) shows it; **Generate now**
makes one at once, and so does `sf digest --now` (it prints the record's path and the cost); `sf
digest` prints the latest one's period and counts. A scheduled digest sends one notification with
counts only.

What it reads: for each such workspace, a bare mirror of its own under
`<state dir>/digest/mirrors/`, cloned once from the origin URL of your checkout (with your
checkout's objects as a reference, then dissociated) and fetched from origin on every digest; your
checkout's local branches are fetched into the mirror's `refs/sf-local/heads/`. It reads your
checkout's `origin` URL and `user.email`, and its README.md for the description.

What it never touches: your checkouts. No pull, no checkout, no fetch in them; their refs, index and
files stay as they are. The digest's texts (your company's code and commit messages) stay on this
machine: the state directory and the token-protected dashboard; they go only to the model, as every
job's work does. The notification carries counts only.

A fetch that fails (no network, no credentials: Git never asks, `ssh` runs in batch mode) is not
fatal: the digest uses the mirror's older data and says "data as of" the last good fetch. A model
call that fails twice leaves a digest with the Git data and the error. The records go after 60 days;
delete `digest/mirrors/` to make the mirrors be cloned again.

Cost: one model session per digest, about $0.30 with Sonnet for three repositories (the prototype's
measure); the page and `sf digest --now` show each digest's cost.

## Cleaning old jobs and worktrees

- **Worktrees** are removed by the factory at the hand-over or the push, by `sf reset`, by
  `sf abort --discard`, and by Restart. An aborted job keeps its worktree (its path is printed):
  `sf reset my-app APP-12` removes it. Never delete a worktree directory by hand while its job is
  live; if one is gone anyway, `git worktree prune` in the checkout clears the registration.
- **Jobs**: `sf reset my-app APP-12`, or *Archive* on a finished job's page, archives the job
  directory as `jobs/my-app/APP-12.<timestamp>/` (they stay for `sf metrics` and the ticket's
  history). There is no prune command: delete old archived job directories by hand when you no
  longer want them.
- **Tickets**: *Archive ticket* moves the Task file and its images to
  `.software-factory/archive/`; *Delete…* (in the card's ⋯ menu or the Archived drawer) removes
  them.
- **Branches**: the factory never deletes a pushed branch. Delete merged branches in your checkout
  and on `origin` as usual. Restart deletes the old job's branch only when it has no commits and was
  never pushed.
- **Saved refs** `refs/factory/<ticket>` and `refs/factory/<ticket>-ask` go by themselves seven days
  after the job is pushed or aborted.
- **Temporary files**: the Task check's temporary checkouts are removed when the check ends; files
  kept by `sf restart --keep-files` are under `<state dir>/tmp/`.

## Backup

| What | Why |
| --- | --- |
| `~/.config/software-factory/` | `workspaces.json`, `auth.env` (holds your tokens: keep the backup private), `rules/`, `tunnel-runtime.key` |
| `.software-factory/` in each workspace's checkout | the Task files, their images, the archived tickets: they are **not in Git** |
| `~/.local/state/software-factory/` | the jobs' history, `queue.json`, the Task checks, the tickets' history, the morning digests, the dashboard token; worth keeping, not needed to start again (leave out `worktrees/`, `digest/mirrors/` and `sf.sock`) |

Copy them while no job runs, or stop `sf serve` first. A restored state directory needs the same
workspaces and checkouts.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `sf: Port 8787 on 127.0.0.1 is already in use. Set SF_PORT to a free port.` | another `sf serve` (from another clone or terminal), or another program, has the port | stop the other `sf serve` (`ss -ltnp \| grep 8787`); or set `SF_PORT` (the ChatGPT tunnel expects 8787) |
| `Port 8788 … Set SF_DASHBOARD_PORT to a free port.` | the dashboard port is taken | as above, or `SF_DASHBOARD_PORT=8798` |
| `Another sf serve is already listening on the socket.` (`serve_running`) | a second `sf serve` on the same state directory | use the running one; run only one `sf serve` per state directory |
| `sf serve is not running.` | a command that needs `sf serve` (`start`, `say`, `queue`, `approve`, …) | start it (`npm start` or `npm run serve`) |
| `socket_path_too_long` | `SF_STATE_DIR` is too deep for a Unix socket (107 bytes) | use a shorter state directory |
| `sf serve` refuses to start with `registry_invalid` or `queue_invalid` | `workspaces.json` or `queue.json` has a key or value the strict parser does not accept | fix the file by the message (see [Configuration](configuration.md#the-workspace-registry-workspacesjson)) |
| every `sf` command says `invalid_env_file` | a line in `auth.env` is not `KEY=VALUE` | fix that line |
| the dashboard says 404 / the bookmark stopped working | wrong or rotated token, or another port | `sf dashboard` prints the current URL; `sf dashboard --rotate` makes a new token at the next `sf serve` start |
| the hand-over or your own `git config` fails with "could not lock config file … File exists" | a stale `.git/config.lock` in the checkout: Claude Code's sandbox leaves an empty read-only one, which the factory removes when no job of the workspace runs; a lock that is not the sandbox's is never touched (`handover_failed`) | wait for the workspace's running jobs to end (`config_locked` hands over by itself); if no job and no Git command runs, delete `.git/config.lock` by hand |
| sessions fail with an authentication message, `session_failed` | the Claude login expired | run `claude` and `/login`, then *Tell it to go on* |
| `gate_failed` with a login message, or `gate: off` in `sf info` | Codex not found or not logged in | `codex login`; set `SF_CODEX` to its absolute path when it is not on the `PATH` of `sf serve` |
| `mr_push_failed` "Permission denied" or "rejected" | your Git credentials cannot push to `origin`, or the host refused the push | fix your SSH key or credential helper (`git push --dry-run` in the checkout), then Push again |
| `mr_auth_failed`, `mr_token_missing` | the GitHub or GitLab token is missing, expired or lacks a permission | set or renew `SF_GITHUB_TOKEN` / `SF_GITLAB_TOKEN` in `auth.env`, restart `sf serve` |
| a job sits in `working` with no new Stream entries, or `runner_failed` / `runner_timeout` | its runner died (killed, out of memory) | look at `runner.log`; restart `sf serve` (a job found `working` without a runner becomes `needs_human`, `serve_restarted`), then *Tell it to go on* |
| `sandbox_unavailable` | bubblewrap or socat missing, or user namespaces disabled | install them; see Claude Code's sandbox documentation |
| `max_turns` on big tickets | `SF_MAX_TURNS` (150) too low | `SF_MAX_TURNS=300` in `auth.env`, restart `sf serve`, *Tell it to go on* |
| the tunnel says `not started` or `exited` | profile or key missing, or the factory not answering | `scripts/sf-tunnel.sh check`; the [connection runbook](../runbooks/chatgpt-connection.md#diagnostics) |
| ChatGPT shows old tools | the connector caches its tool list | *Refresh* the plugin in ChatGPT and open a new chat |
| `branch_exists` at Start | a branch of an earlier attempt | delete it (`git branch -D APP-12-…`) or Restart the old job |
| `worktree_exists` at Start | a leftover worktree | `sf reset my-app APP-12` |

## The tests

The factory's own tests need no model and no network:

```sh
npm test                 # from the repository root, or in factory/: build, then node --test dist/test/*.test.js
npm run typecheck        # tsc --noEmit
```

The dashboard's browser tests open the page in a real Chromium through Playwright; they are not
part of `npm test`:

```sh
cd factory
npm run browsers         # once per machine: playwright install chromium
npm run test:browser     # build, check that Chromium is installed, run test/browser/
SF_BROWSER_HEADED=1 npm run test:browser   # with a visible window
```

A failing browser test saves a screenshot under `factory/dist/test-results/`. And the live check
with the real Claude Code, Codex and Git is `sf smoke` ([Install](install.md#check-that-it-works)).

Next: [Ways of working](ways-of-working.md).
