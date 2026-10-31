# SF-010: ChatGPT MCP Events discovery probe

Jobs: sf010-chatgpt-event-probe-20261030 (probe), sf010-event-probe-launcher-repair-20261030 and
sf009-publication-recovery-launcher-20261031 (launcher). Status: **catalog discovery passed once; the
probe is stopped and not activated.** Authenticated subscriptions, callback delivery and automatic
ChatGPT continuation remain unverified and unimplemented. Independent review and operator approval
come before any step below.

Result of the one operator-approved attempt, 2026-10-31, verified by the context-owning reviewer:
ChatGPT displayed Events -> `probe.test`; `probe_status` returned
`{status:running,events:1,subscriptions:refused}`; and the preserved `probe.log` has `events/list`,
HTTP 200, protocol `2026-07-28`, at 09:30:11.528Z, after `tunnel-started.txt` 09:28:46Z. The
temporary window ended safely. The checkpoint's `discovery: "unverified"` is deliberately hardcoded
(see "Reading the result") and is not the combined verdict. Evidence:
`review/SF-010/event-probe-live-attempt/` (`probe.log`, `checkpoint.json`).

## What it answers

One question: does ChatGPT receive the event catalog through a tunnel and expose the test event?

A refused subscription or a passing local SDK test proves neither event delivery nor automatic
continuation of a conversation.

## The probe

`bridge/src/event-probe/` is a standalone entry point. It imports nothing from the production bridge.

| Surface | Behavior |
| --- | --- |
| `server/discover` | `2026-07-28`, capabilities `tools` and `events: {}` |
| `initialize` | Legacy clients are still served; tunnel-client may probe with it |
| `tools/*` | One read-only tool, `probe_status` |
| `events/list` | One fixed event, `probe.test`, `delivery: ["webhook"]` |
| `events/subscribe`, `events/unsubscribe` | `-32024` with `data.reason: "discovery_probe"`, credentials or not. A request malformed at the envelope level gets the SDK's own error first; either way nothing is accepted |
| `subscriptions/listen` | The same `-32024`; no stream opens. `maxSubscriptions: 0` is a second lock |

- No subscription storage, callback delivery or execution tools. No authenticated principal:
  `authInfo` is never set and caller-supplied identity is ignored.
- Loopback only, explicit `SF010_PROBE_PORT`, refusal when the port is taken.
- Body limit 64 KiB (`413`), header limit 16 KiB. The lifetime is 600 seconds at most; expiry closes
  every connection and exits 0. If shutdown ever hung, a backstop would end the process within 5
  more seconds with exit 1.
- Each request logs one JSON line with `at`, `era`, `method` (allowlisted, otherwise `other`),
  `protocol`, `auth` (present or not) and `status` (`0` if the client left before a response).
  Headers, bodies, tokens, callback secrets and user identifiers are never logged.
- `status` is the HTTP status. JSON-RPC errors also use 200, so a log line shows that a request
  arrived, not that it succeeded. The log does not show where a request came from.
- `era` is the SDK's legacy classification, so a request the SDK rejects also shows `modern`.
  Read it together with `status`.

## Tunnel route

Inspected: tunnel-client 0.0.18 help and embedded documentation, the secret-free lines of the
live profile, and the running process. Nothing was changed.

| Option | Result |
| --- | --- |
| Add a `probe` channel to the live tunnel | **Not usable.** Connectors call `/v1/mcp/{tunnel_id}`, and no way to make ChatGPT send a non-`main` channel is documented. It would also restart the live daemon |
| Second tunnel-client on the same tunnel ID | **Forbidden.** One shared queue per tunnel, delivered to whichever client polls first, so ordinary bridge traffic would reach the probe |
| Point `main` at the probe | **Forbidden.** It switches the existing route |
| Separate tunnel ID, tunnel-client and connector | **Supported by the installed client.** The existing bridge route is untouched |

The only permitted route is the separate test tunnel `tunnel_6ae483b7841c819189072dd173ea821a`,
with the key reference `file:$HOME/.config/software-factory/tunnel-runtime.key`. Its connector must
be a separate ChatGPT connector on that tunnel, in a workspace where Work chat and event-triggered
tasks are allowed.

Open risk (B2 in the report): the embedded documentation says a remote Streamable HTTP channel does
not advertise `stateless` unless it independently supports self-contained requests, and no setting
for this was found. The tunnel might therefore not have carried `2026-07-28` requests. The attempt
of 2026-10-31 settled this for catalog discovery: `events/list` arrived through the tunnel with
protocol `2026-07-28` and the `modern` era.

## Operator procedure

The one approved attempt ran on 2026-10-31; any further run needs a new operator approval. Local
ports 8791 and 8792 are the test ports; the existing bridge uses 8787 and its tunnel health endpoint
8790.

`scripts/sf010-event-probe-live.sh` is the one canonical launcher and replaces the earlier start,
stop and rollback blocks. `review/SF-010/chatgpt-event-live-20261030/live-supervisor.sh` is a
historical record of a refused job. Do not run it.

### Before the run

1. Independent review of `review/SF-009/publication-recovery-launcher-20261031/`, whose seven-entry
   `SOURCE-SHA256SUMS` the launcher requires, is complete, and the operator approves one live attempt. A permission refusal is an answer: change it only as the
   operator's own decision, in `/permissions` or by running the launcher in a terminal. No agent
   works around it.
2. Open the ChatGPT connector settings for the test tunnel, so that the rescan can start at once.
   The usable window is under ten minutes and it is not extended.

### Run

From the repository root, in a terminal that stays open:

```sh
bash scripts/sf010-event-probe-live.sh --operator-approved
```

What it does, in order:

- Refuses, with nothing created, on a missing command, a source hash mismatch, an occupied test
  port, existing build output, the live tunnel ID, a changed live profile, an inactive route, an
  existing attempt directory, or a worktree path it cannot capture. The refusal does not use up the
  attempt.
- Claims `review/SF-010/event-probe-live-attempt/` with an atomic `mkdir`. That directory is the
  record of the one attempt; a later run refuses. There is no retry, restart or extension.
- Creates a fresh private `/tmp/sf010-event-probe.XXXXXX` and prints `SF010_RUN=...`, builds to
  `bridge/sf010-event-probe-validation-dist`, and starts the probe on 8791.
- Checks the catalog locally, once, before the tunnel. Nothing local calls the probe after that.
- Requires positive remaining time before and after a `tunnel-client init` bounded to 30 seconds,
  with a fresh profile directory inside the run.
- Runs the tunnel with `INT` six seconds before the 600-second deadline and `KILL` five seconds
  later, so that it is gone by the deadline. The deadline counts from before the probe started.
  `timeout -v` writes its own line to a private file only if that timer fires.
- Stops, publishes evidence, removes what it created and runs every postcheck.

The launcher handles EXIT, INT, TERM and HUP. A signal only marks the run; one cleanup path stops
the owned processes with TERM, then KILL, within about eight seconds. Before each signal it checks
PID, start time and boot ID, or the run's environment marker for descendants. A reused or unverified
PID is never signalled. A child whose identity could not be read stays `unknown` until its PID has
left `/proc`. The descendant scan reports whether it completed; a process it cannot read is ruled out
only if it has left `/proc`, belongs to another real user, or started before the launcher. Any other
one counts as an unreadable candidate, so an unrelated unreadable process of the same user that
starts during the run also withholds the boundary. That errs on the safe side. `kill -9` of the launcher itself cannot be handled: `timeout` and the
probe's own lifetime still end those processes, but nothing is published, so `checkpoint.json` stays
at its last non-final state.

### Discovery, in the ChatGPT UI

Once the checkpoint `state` is `ready`: in ChatGPT, connect or rescan the probe connector and open
its page. Do not subscribe. Record whether `probe.test` is visible. Only the operator can see this,
and the launcher never reports it: `discovery` in the checkpoint is always `unverified`.

While the window is open, in a second terminal, with the printed value:

```sh
SF010_RUN=/tmp/sf010-event-probe.REPLACE
cat "$SF010_RUN"/tunnel.*/started
grep -F '"method":"' "$SF010_RUN/probe.log"
curl -fsS -m 5 http://127.0.0.1:8792/readyz
```

After the run the same evidence is in the attempt directory, as `tunnel-started.txt` and a sanitized
`probe.log`.

| Outcome | Evidence |
| --- | --- |
| **Pass** | `probe.test` visible in ChatGPT, **and** an `events/list` line with `at` later than the tunnel `started` time and `status` 200. Both are required. The log line alone proves neither JSON-RPC success nor origin |
| Partial | A later `events/list` line, but ChatGPT does not show the event: suspect the account or workspace (B3) or the catalog shape |
| Fail | `server/discover` or `initialize` after that time, and no `events/list`: see `era` and `protocol`. Only `legacy` lines means the modern path was not used (B2) |
| Fail | No lines after that time: tunnel or connector, not the probe |

The local check adds one `events/list` line before `started`; it does not count.

Record any `events/subscribe` line and what ChatGPT shows on `-32024`, particularly whether it
prompts for linking. That is evidence for the next checkpoint, not a failure of this one.

Passing shows discovery only. Callback delivery and automatic continuation stay unverified.

### Reading the result

`checkpoint.json` keeps three questions apart:

| Field | Meaning |
| --- | --- |
| `review_boundary` | Nothing of this run is running, the scan completed and the evidence is complete. It says nothing about success |
| `outcome` | `window_completed`: the real stop time was reached after ready, and cleanup and every postcheck passed. `failed` or `interrupted` otherwise |
| `discovery` | Always `unverified`; the table above decides it |

`cleanup_ok`, `postchecks_ok` and `evidence_ok` only ever go from true to false, so a later healthy
command cannot hide an earlier failure. `postchecks.txt` lists each required check as `pass` or
`fail`. `tunnel.deadline_reached` is true only for exit 124 or 137 with `tunnel.timer_fired`, which
comes from `timeout`'s own line, and the clock at or past the stop time. A 124 or 137 from the tunnel
itself is a failure, even if the launcher sees it after the stop time. The worktree check fails on
any listing or hashing error; only paths that Git lists as deleted are captured without a hash. A
symlink is captured by its target and the kind of its referent, plus the referent's hash when that
is a file, so a retargeted link differs even if the content is equal or the link dangles. A directory
listed as a path (a gitlink or nested repository), a FIFO, a socket or a device has no capture:
before the attempt it refuses with `unsupported path kind`, and during the run it fails the check.

| Exit | Meaning | Operator action |
| --- | --- | --- |
| 0 | `window_completed` | Rollback below |
| 1 | `failed`, nothing running | Read `errors`, then rollback below |
| 129, 130, 143 | `interrupted`, nothing running | Rollback below |
| 3 | `state: uncertain`, `review_boundary: false`: work may survive, or evidence is incomplete | Read `liveness`, `scan_complete`, `unreadable_candidates` and `evidence_ok`. `alive` and `unknown` mean what they say. A kept `.rollback` in the attempt directory is private and unsanitized. Find what is left with `grep -lzxF "SF010_OWNER=$SF010_RUN" /proc/[0-9]*/environ`, and stop only those processes; that search cannot see an unreadable candidate. The run directory and build output are kept, and any later manual removal is the operator's decision |

### Rollback

The launcher has already removed the run directory and the build output, unless it says otherwise.
Then, in ChatGPT and Platform settings, remove the probe connector and the test tunnel. The live
tunnel, its profile and the bridge are never part of this procedure. The attempt directory stays
as review evidence.

## Next checkpoint: authenticated subscription and callback

Separate from this probe, not implemented and not authorized. It starts only after discovery passes.

It must show that ChatGPT calls `events/subscribe` as an authenticated principal, the server
verifies the callback challenge, and one signed event reaches ChatGPT. Whether that event continues
a conversation is a further observation, to be recorded on its own.

Prerequisites:

1. The discovery checkpoint passed, with ChatGPT's reaction to `-32024` recorded.
2. An authentication design selected by the operator, preserving existing tool behavior (report,
   step 2). ChatGPT does not support machine-to-machine grants, so a fixed service identity is
   not available.
3. An authorization server reachable by ChatGPT, since the tunnel does not carry it.
4. Token, audience and scope verification on `events/*`, with a subscription ID derived from the
   verified principal.
5. Durable subscription storage, and outbound HTTPS with connect-time address pinning and no redirects.
6. Challenge verification and Standard Webhooks signing, with `-32015` on callback failure.
7. Account and workspace access to event-triggered tasks confirmed (B3).
8. An event opt-in separate from review delegation, and the wiring from B4.
