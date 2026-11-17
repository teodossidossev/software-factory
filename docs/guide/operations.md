# Operations

This page covers keeping the factory running: updating it, the service's CPU limits, reading its
status and metrics, logs, cleaning up old jobs and worktrees, backup, troubleshooting, and its
tests.

## Updating the factory

`sf serve` and each job's runner (`sf run`) are separate processes. A runner keeps the code it
loaded when it started until it exits; it exits when its job waits for you or has ended, and the
next runner of that job (when you answer it) loads whatever build is on disk then. Restarting
`sf serve` leaves running jobs running. Both check the state's format at start (`state-version` in
the state directory): a factory older than the state it finds refuses to start with
`state_too_new` ([State format version](../../factory/README.md#state-format-version)).

**From a second clone used only to run it** ([Install (b)](install.md#b-a-second-clone-used-only-to-run-the-factory)):

```sh
sf update --check    # how many commits behind origin/main, and the newest; changes nothing
sf update            # drain, pull, build, restart, resume, smoke
```

`sf update` refuses an install with uncommitted changes, one not on `main` and one that cannot
fast-forward (`install_not_clean`, `install_not_on_main`, `install_diverged`) before it touches any
job. Then it writes the `updating` marker and drains: while the marker exists `sf serve` refuses
every command and dashboard action that changes something (`update_in_progress`; Pause, the merge
request's status and the reads still answer), and the run queue, the automatic Task checks and the
hand-over after `config_locked` wait. It pauses every job in `working` or `awaiting_review` (a job
it could not pause is named, with the state it reached), waits until every job is idle and no
runner is left, then pulls, runs `npm ci` when the lockfile changed, builds and typechecks, with
the output in `update.log` in the state directory. A failed step resets the install to the commit
it started from, rebuilds it and resumes the paused jobs on the old code (`update_failed`). A good
build restarts the service; the new `sf serve` resumes the jobs the update paused (jobs you had
paused stay paused) and catches up on what the marker held back; then `sf update` runs `sf smoke`
(`--no-smoke` skips it). The whole behaviour: [Updating the install](../../factory/README.md#updating-the-install).

- **The drain did not settle in 10 minutes** (`drain_timeout`): it names the jobs, checks or
  hand-overs that held it, resumes the jobs it paused and pulls nothing. Run it again later.
- **Without the service** (an `sf serve` you started by hand): after the build it tells you to
  restart `sf serve`; the new one finishes the update. Until then the gates stay.
- **Without a running `sf serve`**: it refuses with `jobs_running` while a job's runner still runs
  (start `sf serve`, then update), and otherwise updates directly.
- **An interrupted update** (`sf status` says `update interrupted`, or `sf update` says
  `update_interrupted`): the install may be half way. Check it (`git status`, `git log -1` in the
  clone, `npm run build` in `factory/`), then `sf update --abandon`, which removes the marker and
  resumes the jobs the update paused. An update that died while it drained is taken over by the
  running `sf serve` by itself.
- **The new `sf serve` did not start** (`serve_not_started`): `journalctl --user -u
  software-factory`; the first `sf serve` that starts resumes the paused jobs.

**From the clone you develop in** ([Install (a)](install.md#a-from-the-clone-you-develop-in)):
`sf update` works there too when the clone is clean and on `main`; while you develop on a branch,
update by hand:

```sh
cd ~/work/software-factory
git pull
npm run setup        # npm ci and the build in factory/
# stop sf serve (Ctrl+C in its terminal), then:
npm start
```

Then:

- **Add a new key** to `workspaces.json` (or a new setting to `auth.env`) only when no job that
  started before the update is still running: an older runner reads `workspaces.json`,
  `job.json` and `queue.json` with its own strict schema, and a key it does not know stops it.
  After `sf update` no older runner is left.
- A changed setting in `auth.env` applies to `sf serve` once it restarts, and to each runner that
  starts after that; a runner already running keeps its settings.
- Building into a clone by hand while a job's next runner starts can load a mix of old and new
  files; `sf update` drains first for that reason.

## The service's CPU limits

The systemd user service (`sf service install`) caps the whole factory, `sf serve`, every job's
runner and everything they run, at half the machine's cores (at least one, at most eight:
`CPUQuota=800%` on 20 cores) and runs it at `Nice=10`, so a busy factory leaves your IDE and other
programs responsive. `sf service install` writes these into the unit each time; there is no
setting for them. To change them, add a drop-in, which `sf service install` never writes or
removes:

```sh
mkdir -p ~/.config/systemd/user/software-factory.service.d
printf '[Service]\nCPUQuota=1200%%\nNice=5\n' > ~/.config/systemd/user/software-factory.service.d/limits.conf
systemctl --user daemon-reload
systemctl --user restart software-factory     # running jobs keep running
systemctl --user show software-factory -p CPUQuotaPerSecUSec -p Nice   # 12s and 5
```

`CPUQuota=` with no value in the drop-in removes the cap. An `sf serve` you start by hand has
no limits. The CPU cap needs the `cpu` controller delegated to your systemd user instance (the
default on current distributions); `Nice=10` applies either way. More:
[Service](../../factory/README.md#service).

## The service's watchdog

`sf serve` reports its own checks, but not its own crash or hang. `sf service install` therefore
writes, next to the service, `software-factory-watchdog.timer` (every five minutes it runs
`sf health --notify`) and `software-factory-alert.service` (systemd runs it once it has given up
restarting the service: five failed starts in five minutes). You get one notification when
`sf serve` stops answering or its unit failed ("Software Factory: sf serve does not answer since
…; journalctl --user -u software-factory") and one when it answers again; nothing in between. The
last state is `watchdog.json` in the state directory.

```sh
sf service status                                  # watchdog: software-factory-watchdog.timer active, last run …
systemctl --user list-timers software-factory-watchdog.timer
journalctl --user -u software-factory-watchdog    # what each run saw and sent
```

`sf update` does not rewrite the units: after the update that brought the watchdog, run
`sf service install` once more (`sf service status` says "watchdog: not installed" until then).
After fixing a crash loop, `systemctl --user reset-failed software-factory` and
`systemctl --user start software-factory` start the service again. More:
[Service](../../factory/README.md#service).

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
says the gate costs more than it finds. On jobs with the Claude review, consider
`SF_GATE_LEVEL=auto` (the default) or a lower `SF_GATE_MAX_ROUNDS`; on a job without it the gate
is the only reviewer, at level `full` in every round, and `SF_GATE_MAX_ROUNDS` does not apply to
it: `SF_MAX_ITERATIONS` and `SF_GATE_MAX_TOKENS` bound it. Or Accept on churn. The exact
counting rules:
[sf metrics](../../factory/README.md#sf-metrics).

## Logs: where to look

| What | Where |
| --- | --- |
| `sf serve` itself (start, the gate's state, plan-check notification failures, warnings) | its terminal (stdout and stderr); as the service, `journalctl --user -u software-factory` |
| `sf update`'s pull, `npm ci`, build and typecheck | `update.log` in the state directory |
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

After each of `digest.times` (`workspaces.json`, 1 to 4 times a day, default 08:00, weekdays only by
default; an older file's `digest.at` counts as one time), `sf serve` makes the morning digest of the
workspaces that are followed (`digest.track`) or have My daily on (`digest.my_work`); each run covers
the period from the earliest time of the previous digest day, so a later run refreshes the whole
brief. Each time runs at most once a day: a machine that slept through several runs once on
waking, for the latest. The dashboard's **Digest** (in the header) shows it, its schedule ("Updates
at 08:30 · 10:45 (weekdays)", with **Edit** for the times) and two tabs: **Brief** (yesterday, in
progress now, today, merged by colleagues, waiting on me; **Copy for the stand-up** per app) and
**Repositories**. A digest in another language than English carries every text in English too: the
switch "<language> · English · Both" chooses what the page shows and copies. **Generate now**
makes one at once, and so does `sf digest --now` (it prints the record's path and the cost); `sf
digest` prints the latest one's period and counts. Each scheduled digest sends one notification
with counts only.

What it reads: for each such workspace, a bare mirror of its own under
`<state dir>/digest/mirrors/`, cloned once from the origin URL of your checkout (with your
checkout's objects as a reference, then dissociated) and fetched from origin on every digest; your
checkout's local branches are fetched into the mirror's `refs/sf-local/heads/`. It reads your
checkout's `origin` URL and `user.email`, and its README.md for the description.

My daily also counts the factory's work as yours: the jobs of a My daily workspace (current and
archived) that were handed over, pushed or merged yesterday or today go into Yesterday and into
Today's "done:" items, even before you commit a hand-over. It leaves out branches without recent
work: an open branch of yours is a problem or a plan only when you committed on it yesterday or
today, or a job on it is still going (a pushed one counts while its merge request is open, or when it has none). The
Repositories tab still shows the others.

What it never touches: your checkouts. No pull, no checkout, no fetch in them; their refs, index and
files stay as they are. The digest's texts (your company's code and commit messages) stay on this
machine: the state directory and the token-protected dashboard; they go only to the model, as every
job's work does. The notification carries counts only.

A fetch that fails (no network, no credentials: Git never asks, `ssh` runs in batch mode) is not
fatal: the digest uses the mirror's older data and says "data as of" the last good fetch. A model
call that fails twice leaves a digest with the Git data and the error. The records go after 60 days;
delete `digest/mirrors/` to make the mirrors be cloned again.

Cost: one model session per digest, about $0.30 with Sonnet for three repositories (the prototype's
measure, before the English texts, which add to it); each scheduled time is one session. The page
and `sf digest --now` show each digest's cost.

## A workspace's vision

A workspace's vision is its Markdown files (`VISION.md`, an optional `CODEMAP.md`, and
`chapters/<name>.md`) in English and in Bulgarian, kept by the factory and read as one page on the
dashboard. `sf serve` must be running. Store English first, then Bulgarian, each from a folder
given as an absolute path (`sf serve` reads it, not your terminal):

```
sf vision put bookshop en "$PWD/vision/en"
sf vision put bookshop bg "$PWD/vision/bg"
sf vision                      # what is stored: workspace, language, files, last put
sf vision remove bookshop bg   # one language (Bulgarian before English)
sf vision remove bookshop      # the whole vision
```

A put replaces that language's files, all or nothing, and builds the page again; a refusal says
what is wrong (a link, a file that does not belong, a file too large, text that is not UTF-8) and
changes nothing. With English alone, the page's Bulgarian side shows the English text with a note.

To read it, open **Workspaces** (on a phone, the page select's Workspaces): the card of a
workspace with a vision has **Vision ↗**, which opens the page in a new tab. A card shows the link
after the dashboard's next update of the workspaces (a reload does it); an open page shows a new
put when it is reloaded. The page opens in Bulgarian, with a switch to English.

No job's session reads the vision: it is in the state directory, which every one of them denies.
The Claude Code planner reads its English files when it plans a ticket of that workspace (`sf
planner setup` names their folder in the planning copy), so they go to Anthropic with the rest of
the planning; run `sf planner setup <workspace>` again after the first put and after removing the
vision, so the copy says whether there is one. To move it into the workspace's repository later, copy
`<state dir>/vision/<workspace>/<lang>/` as it is. More: [Vision](../../factory/README.md#vision).

## Cleaning old jobs and worktrees

- **Worktrees** are removed by the factory at the hand-over or the push, by `sf reset`, by
  `sf abort --discard`, and by Restart. An aborted job keeps its worktree (its path is printed):
  `sf reset my-app APP-12` removes it. Never delete a worktree directory by hand while its job is
  live; if one is gone anyway, `git worktree prune` in the checkout clears the registration.
- **Jobs**: `sf reset my-app APP-12`, or *Archive* on a Done card or a finished job's page,
  archives the job directory as `jobs/my-app/APP-12.<timestamp>/` (they stay for `sf metrics` and
  the ticket's history); *Archive* also moves the ticket's active Task file to the archive, and so
  does *Merged — archive* (`sf handed-done --merged`) for a handed-over or pushed job you merged. A
  pushed or handed-over job found merged is archived by `sf serve` itself, checked every 10
  minutes: its merge request merged on the Git host (with a host token; `GET` requests only), or,
  for a pushed job, its commit in `origin/<base>` after a fetch of the base. There is no prune command:
  delete old archived job directories by hand when you no longer want them.
- **Tickets**: *Archive* in a Queue card's ⋯ menu (or on a Done card) moves the Task file and its
  images to `.software-factory/archive/`; *Delete…* (in the card's ⋯ menu or the Archived drawer)
  removes them.
- **Branches**: `sf mr merge` and *Merge…* delete the merged branch on `origin`. Delete merged
  branches in your checkout, and on `origin` after a merge on the host, as usual. Restart deletes
  the old job's branch only when it has no commits and was never pushed.
- **Saved refs** `refs/factory/<ticket>` and `refs/factory/<ticket>-ask` go by themselves seven days
  after the job is pushed or aborted.
- **Temporary files**: the Task check's temporary checkouts are removed when the check ends; files
  kept by `sf restart --keep-files` are under `<state dir>/tmp/`.

### Leftover sandbox processes

Claude Code's Bash sandbox (`bwrap`) outlives the `claude` process of a session that ended: the
leftovers are reparented to the systemd user manager, each with its `sh` and `socat` children. The
factory ends them itself: an orphaned `bwrap` of your user (its parent is pid 1 or `systemd`) whose
command line names a path under the factory's worktree root or state directory, with everything it
started, gets SIGTERM, then SIGKILL 2 s later. A sandbox of a running session, another user's
process and a bwrap naming neither directory (a Flatpak app's) are never touched; an orphaned
sandbox of your own Claude Code session counts when it names a path under the state directory, as
its deny list does. It runs shortly after each query of a job's session, after a job's session is
stopped (abort, pause, restart, reset), and every 10 minutes while `sf serve` runs; each run that ends
something logs `sandbox reaper: ended …`, and a failure logs `sandbox reaper: failed: …` (in
`journalctl --user -u software-factory` for the service). More:
[Jobs](../../factory/README.md#jobs).

## Backup

| What | Why |
| --- | --- |
| `~/.config/software-factory/` | `workspaces.json`, `norms.json`, `auth.env` (holds your tokens: keep the backup private), `rules/`, `tunnel-runtime.key` |
| `.software-factory/` in each workspace's checkout | the Task files, their images, the archived tickets: they are **not in Git** |
| `~/.local/state/software-factory/` | the jobs' history, `queue.json`, the Task checks, the tickets' history, the morning digests, the workspaces' visions (`vision/`), the dashboard token; worth keeping, not needed to start again (leave out `worktrees/`, `digest/mirrors/` and `sf.sock`) |

Copy them while no job runs, or stop `sf serve` first. A restored state directory needs the same
workspaces and checkouts.

## The dashboard on your phone (Tailscale)

The dashboard listens on `127.0.0.1` only. To open it from your phone, `tailscale serve` on the PC
proxies `https://<machine>.<tailnet>.ts.net/`, reachable only inside your own tailnet, to a second
listener of its own, the remote port (`SF_DASHBOARD_REMOTE_PORT`, default 8789). That port serves
only the Tailscale logins you list, and asks again before a push or a merge.

1. Install Tailscale on the PC and the phone and log both into the same tailnet. In the Tailscale
   admin console, DNS: turn on MagicDNS and HTTPS certificates (`tailscale serve` asks for it if
   they are off).
2. On the PC, once: `sudo tailscale set --operator=$USER` (so your user may run `tailscale serve`).
3. `tailscale serve --bg 8789` (the remote port, not the dashboard's 8788). It proxies
   `https://<machine>.<tailnet>.ts.net/` to `http://127.0.0.1:8789` and keeps doing so across
   reboots. `tailscale serve status` shows the address; `tailscale serve reset` removes it. If
   you pointed it at 8788 before, run `tailscale serve reset` first.
4. Add to `auth.env`, then restart `sf serve` (`systemctl --user restart software-factory` for the
   service):
   ```
   SF_DASHBOARD_REMOTE_ORIGINS=https://<machine>.<tailnet>.ts.net
   SF_DASHBOARD_REMOTE_LOGINS=<your login>
   ```
   Your login is the one `tailscale status` shows for your devices (such as `you@github` or
   `you@example.com`); several are comma-separated. Without the logins `sf serve` does not start.
5. `sf dashboard` prints `Through Tailscale: https://<machine>.<tailnet>.ts.net/d/<token>/`; open
   it on the phone once. The page sets a cookie, so from then on
   `https://<machine>.<tailnet>.ts.net/` alone opens the dashboard: bookmark that one.

What the phone gets:

- Only requests that Tailscale marks with a listed login (`Tailscale-User-Login`) are served.
  A tagged device or a Funnel request has no login and gets a 403; `sf serve`'s log names the
  login refused (or `none`), never the path.
- Approve, Retry (which pushes again after a failed push), Create merge request and Merge ask a
  second time: "Type <ticket> to continue", and the button works only with the ticket typed
  exactly. The other actions work as on the PC.
- The local dashboard (`http://127.0.0.1:8788`) is as before: it refuses the Tailscale address and
  ignores Tailscale's headers.

`sf serve` prints no token (its log is the service's journal): its line is
`software-factory dashboard http://127.0.0.1:8788/d/<token>/ (sf dashboard prints the full URL)`,
with `remote listener 127.0.0.1:8789` and the Tailscale address beside it. `sf dashboard`,
`sf status` (its last line) and `sf info` print the full URL; `sf up` opens it in your browser
itself.

Use `tailscale serve`, never `tailscale funnel`: Funnel puts the address on the public internet
(and its requests carry no login, so the remote port refuses them anyway).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `sf: Port 8787 on 127.0.0.1 is already in use. Set SF_PORT to a free port.` | another `sf serve` (from another clone or terminal), or another program, has the port | stop the other `sf serve` (`ss -ltnp \| grep 8787`); or set `SF_PORT` (in `auth.env`, so the ChatGPT tunnel's script, which asks `sf mcp-url --port`, uses the same port) |
| `401` from the MCP endpoint, or `sf-tunnel: FAIL: the factory refused the token` | the client has no token, an old one (after `sf mcp-url --rotate`) or one of another state directory | take the URL from `sf mcp-url`; restart the tunnel (`npm run tunnel` again) so its `run` writes the current token into the profile |
| `warning: mcp-token in the state directory had mode 644; it is 600 now.` at `sf serve`'s start | the token file was readable by others | `sf mcp-url --rotate`, then restart the tunnel and update other MCP clients |
| `unsafe_mcp_token` at `sf serve`'s start | `mcp-token` is a link, a directory or another user's file | remove it and start `sf serve` again (a new token), then restart the tunnel |
| `profile_unsafe` from `scripts/sf-tunnel.sh check` | the tunnel profile's mode is not 0600 or its directory's not 0700 (wider, or stricter such as a 0500 directory) | `scripts/sf-tunnel.sh run` (or `doctor`) sets them |
| `invalid_mcp_token` at `sf serve`'s start, or `mcp: every request is refused: …` in its log | `mcp-token` in the state directory is not a valid token or cannot be read | `sf mcp-url --rotate` writes a new one; then restart the tunnel and update other MCP clients |
| `Port 8788 … Set SF_DASHBOARD_PORT to a free port.` | the dashboard port is taken | as above, or `SF_DASHBOARD_PORT=8798` |
| `Port 8789 … Set SF_DASHBOARD_REMOTE_PORT to a free port.` | the remote port is taken | as above, or another `SF_DASHBOARD_REMOTE_PORT`; then point `tailscale serve --bg <port>` at it |
| `Another sf serve is already listening on the socket.` (`serve_running`) | a second `sf serve` on the same state directory | use the running one; run only one `sf serve` per state directory |
| `sf serve is not running.` | a command that needs `sf serve` (`start`, `say`, `queue`, `approve`, …) | start it (`npm start` or `npm run serve`, or `systemctl --user start software-factory`) |
| `update_in_progress` | `sf update` is draining or building; or its build is done and waits for `sf serve` to restart (`sf status` shows the phase) | wait for it to end; restart `sf serve` when it says so |
| `update_interrupted`, or `update interrupted` in `sf status` | an `sf update` ended while building, or its rollback failed (`rollback_failed`) | check the install (`git status`, `npm run build` in `factory/`), then `sf update --abandon` |
| `state_too_new` at `sf serve`'s or a runner's start | the state was written by a newer factory than the one starting | update the factory (`sf update`) |
| `serve_running` from `sf service install` | an `sf serve` you started by hand answers (not the service's own) | stop it (its jobs keep running), then `sf service install` again |
| `serve_busy` from `sf service install` | a Task check or a hand-over runs inside the service's `sf serve`, and a restart would cut it off | run `sf service install` again when it has ended (`sf status` shows the job) |
| `systemd_unavailable` | no systemd user services on this machine | run `sf serve` (`npm run serve`) as before |
| `socket_path_too_long` | `SF_STATE_DIR` is too deep for a Unix socket (107 bytes) | use a shorter state directory |
| `sf serve` refuses to start with `registry_invalid` or `queue_invalid` | `workspaces.json` or `queue.json` has a key or value the strict parser does not accept | fix the file by the message (see [Configuration](configuration.md#the-workspace-registry-workspacesjson)) |
| every `sf` command says `invalid_env_file` | a line in `auth.env` is not `KEY=VALUE` | fix that line |
| the dashboard says 404 / the bookmark stopped working | wrong or rotated token, or another port; a bookmark of `/` after `sf dashboard --rotate` (the cookie belongs to the old token) or after the browser dropped the cookie | `sf dashboard` prints the current URL: open it once, and `/` works again; `sf dashboard --rotate` makes a new token at the next `sf serve` start |
| a 403 on the phone, and `dashboard: refused a request on the remote port from login none` in `sf serve`'s log | the request came without a Tailscale login: from a tagged device, through Funnel, or not through `tailscale serve` | open it from a device logged in as you, through `tailscale serve` (not Funnel) |
| a 403 on the phone, the log naming your login | the login is not in `SF_DASHBOARD_REMOTE_LOGINS` | add it as the log shows it, restart `sf serve` |
| a 403 on the phone, no log line | the address is not in `SF_DASHBOARD_REMOTE_ORIGINS`, or `sf serve` was not restarted after adding it | add exactly the `https://<machine>.<tailnet>.ts.net` that `tailscale serve status` shows, restart `sf serve` ([The dashboard on your phone](#the-dashboard-on-your-phone-tailscale)) |
| the phone's address gives a 403 or nothing, and `tailscale serve status` shows `8788` | `tailscale serve` points at the local port, which refuses the Tailscale address | `tailscale serve reset`, then `tailscale serve --bg 8789` |
| `confirm_required` on the phone | Approve, Retry, Create merge request, Merge, Merged — archive or Archive was sent from the remote port without the ticket typed | use the dialog: type the ticket exactly as shown |
| `invalid_config` naming `SF_DASHBOARD_REMOTE_ORIGINS` at `sf serve`'s start | an entry is not `https://<machine>.<tailnet>.ts.net` (http, another domain, a port, a path or a trailing part) | write each origin as `tailscale serve status` shows it, comma-separated, then start `sf serve` again |
| `invalid_config` naming `SF_DASHBOARD_REMOTE_LOGINS` or `SF_DASHBOARD_REMOTE_PORT` at `sf serve`'s start | remote origins without logins, or the remote port equal to `SF_DASHBOARD_PORT` | set `SF_DASHBOARD_REMOTE_LOGINS`; give the remote port another number |
| the hand-over or your own `git config` fails with "could not lock config file … File exists" | a stale `.git/config.lock` in the checkout: Claude Code's sandbox leaves an empty read-only one, which the factory removes when no job of the workspace runs; a lock that is not the sandbox's is never touched (`handover_failed`) | wait for the workspace's running jobs to end (`config_locked` hands over by itself); if no job and no Git command runs, delete `.git/config.lock` by hand |
| sessions fail with an authentication message, `session_failed` | the Claude login expired | run `claude` and `/login`, then *Tell it to go on* |
| `gate_failed` with a login message, or `gate: off` in `sf info` | Codex not found or not logged in | `codex login`; set `SF_CODEX` to its absolute path when it is not on the `PATH` of `sf serve` |
| `mr_push_failed` "Permission denied" or "rejected" | your Git credentials cannot push to `origin`, or the host refused the push | fix your SSH key or credential helper (`git push --dry-run` in the checkout), then Push again |
| notifications (`notify_failed`, `ntfy: failed (fetch failed (ETIMEDOUT))`) or Git host calls fail with `ETIMEDOUT` on a slow network | Node gave each connect attempt only 250 ms before the next address, and a name with an unrouted IPv6 address lost its IPv4 attempt too; since SF-231 each attempt gets 2.5 s and ntfy retries once | if it still happens, the network drops IPv4 connections too: check `curl -4 https://ntfy.sh/v1/health` and the network itself |
| `mr_auth_failed`, `mr_token_missing` | the GitHub or GitLab token is missing, expired or lacks a permission | set or renew `SF_GITHUB_TOKEN` / `SF_GITLAB_TOKEN` in `auth.env`, restart `sf serve` |
| a job sits in `working` with no new Stream entries, or `runner_failed` / `runner_timeout` | its runner died (killed, out of memory) | look at `runner.log`; restart `sf serve` (a job found `working` without a runner becomes `needs_human`, `serve_restarted`), then *Tell it to go on* |
| `sandbox_unavailable` | bubblewrap or socat missing, or user namespaces disabled | install them; see Claude Code's sandbox documentation |
| a merge check or a job's tests fail with files that "exceeded" their limit (`run-tests: <file> exceeded 300000 ms and was killed`) while other runs of the suite go on (other jobs' tests, an Implementer's `npm test`) | load: several full runs at once on one machine slow every file down; each run gives way above `SF_TEST_BUSY_LOAD` (0.75 times the machine's cores) and retries a file killed under that load, but each run still keeps at least one file running | land jobs one at a time (merge checks on a quiet machine), or lower the limit (`SF_TEST_BUSY_LOAD`, in the environment the tests run in) so the runs give way sooner |
| `max_turns` on big tickets | `SF_MAX_TURNS` (150) too low | `SF_MAX_TURNS=300` in `auth.env`, restart `sf serve`, *Tell it to go on* |
| the tunnel says `not started` or `exited` | profile or key missing, or the factory not answering | `scripts/sf-tunnel.sh check`; the [connection runbook](../runbooks/chatgpt-connection.md#diagnostics) |
| ChatGPT shows old tools | the connector caches its tool list | *Refresh* the plugin in ChatGPT and open a new chat |
| `branch_exists` at Start | a branch of an earlier attempt | delete it (`git branch -D APP-12-…`) or Restart the old job |
| `worktree_exists` at Start | a leftover worktree | `sf reset my-app APP-12` |
| the laptop lost its network: a queued ticket says "start failed (fetch_failed); next try HH:MM" and a notification said "APP-12 could not fetch main; the queue tries again" | the run queue's start could not fetch the base from `origin`; it left no job and kept the ticket in its place | nothing: the queue tries again 5 minutes after the first failure, then 10, then every 15, and starts it once the network is back; Remove from queue (`sf queue remove my-app APP-12`) stops it. A start by hand that cannot fetch still fails its job (`fetch_failed`): Start again once online |

## The tests

The factory's own tests need no model and no network:

```sh
npm test                 # from the repository root, or in factory/: build, then node scripts/run-tests.mjs unit
npm test -- --test-name-pattern=foo   # arguments after -- go on to node --test, before the files
npm run typecheck        # tsc --noEmit
```

`scripts/run-tests.mjs unit` runs `node --test --test-timeout=120000 --test-concurrency=<N>
dist/test/*.test.js` with N half the cores rounded down (at least 1) and at nice 10, which every
test process inherits, so the IDE and other work stay responsive while the suite (or several jobs'
suites) run. Its exit code is the tests' own (1 when `node --test` was killed by a signal).
`SF_TEST_CONCURRENCY=4 npm test` runs 4 files at once; `SF_TEST_NICE=0 npm test` keeps the normal
priority; any other value of either stops with exit code 2 before a test runs
([Configuration](configuration.md#for-running-the-tests)). Since SF-223 a run gives way when the
machine is busy: while the 1-minute load average is at or above `SF_TEST_BUSY_LOAD` (0.75 times the
machine's cores by default, also under the service's CPUQuota), it starts no further file as long as another of its files runs, prints `run-tests:
the machine is busy …` once, ends its last line with how long it gave way, and retries a file killed
at its limit under that load like a failed file. Since SF-114 every sf process a test
starts is tracked by `factory/test/support/children.ts` and stopped (SIGTERM, then SIGKILL after 5 s)
at the end of its file, also on a failure or a signal, and a file whose tests leave an `sf serve`
running fails; an `sf serve` a test expected to refuse fails the test after 30 s instead of hanging.
The script lines in `factory/package.json`:

```json
"test": "npm run build && node scripts/run-tests.mjs unit",
"test:browser": "npm run build && node scripts/check-browser.mjs && node scripts/run-tests.mjs browser"
```

The dashboard's browser tests open the page in a real Chromium through Playwright; they are not
part of `npm test`:

```sh
cd factory
npm run browsers         # once per machine: playwright install chromium
npm run test:browser     # build, check that Chromium is installed, run test/browser/ (node scripts/run-tests.mjs browser: the same concurrency and nice)
SF_BROWSER_HEADED=1 npm run test:browser   # with a visible window
```

A failing browser test saves a screenshot under `factory/dist/test-results/`. And the live check
with the real Claude Code, Codex and Git is `sf smoke` ([Install](install.md#check-that-it-works)).

Next: [Ways of working](ways-of-working.md).
