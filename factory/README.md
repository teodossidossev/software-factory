# software-factory

The local factory process. It serves MCP tools to the Context owner (ChatGPT or any MCP client)
and provides the `sf` command. How to work with it is in [HANDBOOK.md](HANDBOOK.md); the
vocabulary is in [../CONTEXT.md](../CONTEXT.md).

It provides the planning tools (`guide`, `read_file`, `search`, `write_task`) and the execution
tools (`start`, `check`, `request_fix`, `mark_clean`). The Implementer runs as a headless Claude
Agent SDK session (`@anthropic-ai/claude-agent-sdk`, pinned in `package.json`) in a worktree of
the job, inside Claude Code's sandbox. At Clean the factory commits, rebases and verifies, and
the user finishes the ticket with approve (the push) or abort, from the terminal (`sf approve`,
`sf abort`) or from the dashboard (section Dashboard), or with `sf reset` (terminal only), and is
told about the states that need them through a desktop notification and ntfy. The Context owner is told through MCP Events:
ChatGPT subscribes to the event `software_factory.job` and the factory POSTs a signed webhook on
each state that needs it (section MCP Events).

## Commands

```sh
npm install && npm run build      # once, inside factory/
bin/sf workspace add <name> --read <path>   # the local checkout; every job works in a worktree of it (--work is retired)
bin/sf workspace list
bin/sf workspace remove <name>
bin/sf serve                      # foreground; Ctrl+C stops it; prints the dashboard URL
bin/sf up [--no-open] [--no-tunnel]   # sf serve plus the tunnel (../scripts/sf-tunnel.sh run, output prefixed "tunnel | ") and the dashboard opened in the browser; Ctrl+C stops both; npm start at the repository root
bin/sf dashboard [--open]         # the dashboard URL of the last sf serve start; --open opens it with xdg-open; works without sf serve
bin/sf start <workspace> <ticket> # start the job in a worktree of its own (same as the start tool); needs sf serve
bin/sf say <workspace> <ticket> <message...>   # a user message into the session; needs sf serve
bin/sf status [<workspace> <ticket>]           # one job (with its worktree, sensitive and deleted paths) or all jobs, with estimated cost and elapsed time; works without sf serve
bin/sf watch <workspace> <ticket> [--once]     # the session live; works without sf serve
bin/sf approve <workspace> <ticket> [--as-is]  # push the branch prepared at Clean; --as-is pushes a tip edited by hand; needs sf serve
bin/sf abort <workspace> <ticket> [--discard]  # end the job; the worktree stays (its path printed); --discard removes the worktree and the branch; needs sf serve
bin/sf reset <workspace> <ticket>              # end the session, remove the worktree and archive the job; the branch stays; needs sf serve
bin/sf events list                             # MCP event subscriptions (no secrets) with the live job each ticket filter matches; needs sf serve
bin/sf events remove <id>                      # remove a subscription; needs sf serve
bin/sf events test <id>                        # send a test event (state "test") to a subscription, print the answer; needs sf serve
bin/sf ticket <workspace> <ticket> [--no-wait] # the ChatGPT conversation of one ticket: instruction to paste, wait for its subscription, test it; needs sf serve
bin/sf notify-test                             # one test notification on every channel; works without sf serve
bin/sf auth-test < token.txt                   # verify an access token from stdin with the SF_AUTH_* settings; works without sf serve
bin/sf info                                    # version, directories, settings, sf serve and tunnel state, workspaces, jobs, subscriptions; works without sf serve
npm run typecheck && npm test
```

Exit codes: 0 ok, 1 error, 2 usage. `sf approve` exits 1 unless the branch was pushed; `sf events
test` exits 1 unless the callback answered 2xx.

`sf up` is `sf serve` in the same process, then the tunnel as a child process (`SF_TUNNEL_SCRIPT`
names another script) and the dashboard through `xdg-open` once serve listens. When the script is
missing, its check fails (no profile or key: `scripts/sf-tunnel.sh check`) or the tunnel exits on
its own, one `tunnel | ...` line says so with the runbook path and `sf up` goes on without it; it
is not restarted (`npm run tunnel` in another terminal once it is fixed). A launcher failure is
one `sf: ...` line and the printed URL stays usable by hand. A signal stops the tunnel first, then
the servers, exit code 0.

### sf status

One line per current job (archived ones excluded), sorted by workspace and ticket: `WORKSPACE`,
`TICKET`, `STATE`, `ITER` (published iterations), `BRANCH`, `SINCE` (the last state change),
`EST_USD`, `ELAPSED` and `ERROR` (the error code; `sf status <workspace> <ticket>` prints the
message below the table). Both work without `sf serve`; they read the state directory.

- `EST_USD` is the recorded cost, an estimate of the API-equivalent price and not a charge: the
  session usually runs on the user's Claude subscription. It is the sum of `cost_usd` over
  `meta.json` of the published iterations 1 to `iteration`, with four decimals (`0.0000` for a real zero or no iteration yet).
  A running iteration or an MR preparation turn adds nothing until its iteration is published, and
  `cost_usd_total` is never used. `unknown` means a published iteration has no usable cost (its
  `cost_usd` is null or missing, or its `meta.json` is missing); an unreadable or malformed
  `meta.json` is an error.
- `ELAPSED` is wall-clock time since `created_at` as `HH:MM:SS` (hours go beyond 23), including
  waiting for review, for the user and for MR preparation. For a job in `pushed`, `aborted` or
  `failed` it ends at `updated_at` and stops growing; for every other state it ends now.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SF_PORT` | `8787` | Port of `http://127.0.0.1:<port>/mcp` (loopback only, Host and Origin checked). |
| `SF_ENV_FILE` | `~/.config/software-factory/auth.env` | Environment file every `sf` command reads first: `KEY=VALUE` lines, `#` comments, optional `export`, quotes allowed; a variable already set in the environment wins; a missing file is fine. Empty value: no file. The repository root's `npm run serve` relies on it. |
| `SF_DASHBOARD` | on | `off` starts no dashboard listener (and removes an old `dashboard-token`). |
| `SF_DASHBOARD_PORT` | `8788` | Port of the dashboard, `http://127.0.0.1:<port>/d/<token>/` (loopback only, Host and Origin checked). |
| `SF_CONFIG_DIR` | `${XDG_CONFIG_HOME:-~/.config}/software-factory` | Directory of the workspace registry. |
| `SF_HANDBOOK` | `factory/HANDBOOK.md` | Handbook served as instructions (its `## Quick start` section) and by `guide`. |
| `SF_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/software-factory` | Job state and the `sf.sock` socket. |
| `SF_WORKTREE_ROOT` | `${SF_STATE_DIR}/worktrees` | Where every job's worktree is created: `<root>/<workspace>/<ticket>`; absolute. |
| `SF_MAX_JOBS` | `3` | Live jobs per workspace; a further `start` is `job_limit`. |
| `SF_SENSITIVE_PATHS` | empty | Comma-separated globs added to the sensitive paths of `src/rules.ts`. |
| `SF_CHECK_AFTER_START_MIN` | `15` | `check_after_minutes` returned by `start` and by `check` during the first iteration. |
| `SF_CHECK_AFTER_FIX_MIN` | `5` | `check_after_minutes` returned by `request_fix` and by `check` during later iterations. |
| `SF_MAX_TURNS` | `150` | `maxTurns` of every Implementer turn. |
| `SF_MAX_ITERATIONS` | `5` | Published iterations after which `request_fix` is refused (`iteration_limit`, job `needs_human`). |
| `SF_CLAUDE` | bundled binary | Absolute path of the Claude Code executable (`pathToClaudeCodeExecutable`). |
| `SF_MODEL` | unset | Model of every Implementer turn, passed as is as the `model` option of `query()`; unset uses the user's Claude Code default. |
| `SF_SANDBOX` | on | `off` runs the Implementer without Claude Code's sandbox. |
| `SF_SANDBOX_DOMAINS` | empty | Comma-separated extra hosts sandboxed commands may reach, besides `registry.npmjs.org`. |
| `SF_DESKTOP_NOTIFY` | on | `off` disables the desktop notification. |
| `SF_NOTIFY_ITERATIONS` | off | `on` also notifies `awaiting_review` (each published iteration). |
| `SF_NTFY_URL` | unset | Full ntfy topic URL, e.g. `https://ntfy.sh/<topic>`; unset disables ntfy. |
| `SF_NTFY_TOKEN` | unset | Sent as `Authorization: Bearer <token>` to a server that needs it. |
| `SF_AUTH_ISSUER` | unset | OAuth issuer exactly as the tokens' `iss`, trailing slash included (Auth0: `https://<tenant>.<region>.auth0.com/`). Unset: no authentication at all. |
| `SF_AUTH_AUDIENCE` | required with `SF_AUTH_ISSUER` | The API identifier that must be in the token's `aud` (a string or an array). |
| `SF_AUTH_RESOURCE` | `SF_AUTH_AUDIENCE` | The `resource` of the protected resource metadata; an `https` URL. |
| `SF_AUTH_OPEN_METHODS` | `initialize,ping,tools/list,server/discover,notifications/initialized` | Comma-separated MCP methods allowed without a token; empty opens none. `events/*` methods are refused (`invalid_config`). |
| `SF_EVENTS_ALLOW_LOOPBACK` | off | **Tests only.** `on` accepts event callback URLs on loopback (`127.0.0.0/8`, `::1`, `localhost`), over `http` too. Never set it in real use. |

The socket path `${SF_STATE_DIR}/sf.sock` must fit a Unix socket address (107 bytes on Linux);
a longer one is refused at start with `socket_path_too_long`.

The execution variables are read once when `sf serve` starts. `sf status` and `sf watch` read
`SF_STATE_DIR` themselves; `sf start`, `sf say`, `sf approve`, `sf abort`, `sf reset` and `sf events` use it to find the socket; `sf notify-test` reads the notification variables itself; `sf auth-test` reads `SF_AUTH_*` itself.

## OAuth

With `SF_AUTH_ISSUER` set, the MCP endpoint is an OAuth resource server (the authorization server is
hosted, e.g. Auth0; the factory issues no tokens and knows no clients). `sf serve` prints
`auth: <issuer> audience <audience>`, or `auth: off` without `SF_AUTH_ISSUER`, where everything
behaves as without this section. An invalid combination stops `sf serve` with `invalid_config`.

- `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp`
  return the same protected resource metadata (`Cache-Control: no-store`):
  `{"resource": SF_AUTH_RESOURCE, "authorization_servers": [SF_AUTH_ISSUER], "bearer_methods_supported": ["header"], "scopes_supported": ["openid", "profile", "email"]}`.
- `POST /mcp` with `Authorization: Bearer <token>`: the token must verify (below), whatever the
  method; the tools then see the caller. An invalid token gets `401` with
  `WWW-Authenticate: Bearer error="invalid_token", error_description="...", resource_metadata="<origin of SF_AUTH_RESOURCE>/.well-known/oauth-protected-resource"`
  (`500` when the authorization server's keys cannot be fetched).
- `POST /mcp` without a token: a single JSON-RPC message whose `method` is in
  `SF_AUTH_OPEN_METHODS` runs unauthenticated (by default `initialize`, `ping`, `tools/list`,
  `server/discover`, `notifications/initialized`); anything else, a batch, a response or an
  unparseable body included, gets the same `401` challenge. Every `tools/call` needs a token by
  default. The body limit is unchanged (4 MiB, `413` beyond).
- `GET /mcp`, other methods and other paths are unchanged.

A token is accepted when it is a JWT with `alg` `RS256` whose `kid` is in the issuer's JWKS and whose
signature verifies, `iss` equals `SF_AUTH_ISSUER`, `aud` contains `SF_AUTH_AUDIENCE`, `exp` has not
passed and `nbf` (if any) has (60 s leeway each; the SDK's bearer check additionally refuses a token
past `exp` without leeway), and `sub` is set. The JWKS location is `jwks_uri` of
`<issuer>.well-known/openid-configuration`, read once (falling back to `<issuer>.well-known/jwks.json`);
keys are cached by `kid` for an hour, an unknown `kid` refetches the JWKS at most once per minute, and
every request to the authorization server has a 10 s timeout. A rejection is logged as
`software-factory bearer token rejected: <reason>` (`malformed`, `unsupported_alg`, `unknown_kid`,
`bad_signature`, `wrong_issuer`, `wrong_audience`, `expired`, `not_yet_valid`, `missing_sub`,
`jwks_unavailable`), never with the token.

With a verified token, `start`, `request_fix`, `mark_clean` and `write_task` append
`{"type": "principal", "tool": "<tool>", "principal": "<sub>"}` to the job's `events.jsonl` after
they succeed; `sf watch` shows it as `<tool> by <sub>`. `write_task` for a ticket that has no job yet
has no event log, so nothing is recorded for it.

`sf auth-test` reads one token from stdin (never an argument, so it stays out of the shell
history), verifies it with the same code against the `SF_AUTH_*` settings and prints
`valid: sub <sub>`, the scopes and the expiry (exit 0) or `rejected: <reason>` (exit 1). It does not
need `sf serve`. For example `xclip -o -selection clipboard | bin/sf auth-test`.

## MCP Events

The factory implements the ChatGPT MCP Events contract (draft MCP Events specification, webhook
delivery and callback verification only; no polling, streaming, replay, `gap` or `terminated`), so
an event-triggered task in ChatGPT runs when a job needs the Context owner instead of on a
schedule. `initialize` advertises the capability `events: {}`. The three methods are protocol
methods on the same `/mcp` endpoint as the tools, not tools. They need the token's `sub`: with
OAuth they are never open (`SF_AUTH_OPEN_METHODS` refuses them); without OAuth they answer the
JSON-RPC error `-32000` with `data.reason` `unauthenticated`.

**The event.** One, `software_factory.job`. `inputSchema` (the filter):
`{workspace?: string, ticket?: string}`, no other keys; empty means every job. `payloadSchema`:
`{workspace, ticket, state, iteration, branch, error?: {code, message}, mr?: {title}}`. It fires on
every transition to `awaiting_review`, `needs_human`, `ready_for_human_review`, `pushed` (with
`mr.title`), `aborted` and `failed`; `starting`, `working` and `preparing_mr` do not fire. `state`
is `"test"` only for `sf events test`. Every authenticated principal may see and subscribe to it;
deliveries go to every subscription whose filter matches. The intended setup is one subscription
per ticket, from the ChatGPT conversation that plans it: `sf ticket <workspace> <ticket>` prints
the instruction to paste there, warns about subscriptions that would also match the ticket, waits
for the ticket's subscription and sends it a test event (`--no-wait` prints and exits 1 when there
is none). The dashboard shows the same answer per job (its Reviewer block, with the same two
messages to copy and a test event to send) and lists the subscriptions, refreshed on every change.
A job in `awaiting_review` whose reviewer has not acted can be nudged from the same block (SF-035):
the `awaiting_review` event goes again, with a new `eventId` and the current time, to every
subscription that receives the job, through the same queue and retries; a subscription that
still has a delivery of that iteration on its way gets no second one.

**`events/list`** `{cursor?}` → `{events: [{name, description, delivery: ["webhook"], inputSchema,
payloadSchema}]}`, one page, no `nextCursor`.

**`events/subscribe`** `{name, arguments?, delivery: {mode: "webhook", url, secret}, cursor?, ttlMs?}`
→ `{id, refreshBefore, cursor: null, truncated: false, ttlMs}`.

- `name` must be `software_factory.job` (else `-32602`, `unknown_event`); `delivery.mode` must be
  `webhook` (`-32602`, `unsupported_delivery`); `arguments` must match the filter
  (`-32602`, `invalid_arguments`); `secret` must be `whsec_` + canonical base64 of 24 to 64 bytes
  (`-32602`, `invalid_secret`).
- `url`: `https`, at most 2048 characters, no userinfo, the host not `localhost`/`*.localhost`
  and not a non-public address literal (loopback, private, shared, link-local, documentation,
  multicast, reserved, IPv4-mapped, unique-local; `-32015`, `invalid_url`). Every connection
  (verification and delivery) resolves the host and connects only to public addresses, keeping
  the hostname for TLS; none left is `blocked_address`.
- The id is derived from `{principal, url, name, arguments}` (arguments in canonical JSON):
  `sub_` + 32 base64url characters of a SHA-256. A subscribe with the same identity is a refresh: same
  id, `createdAt` kept, the new secret stored (the old one also signs for 10 minutes).
- Limits: 8 active subscriptions per principal, 32 in total (`-32000`, `subscription_limit`); a
  refresh does not count.
- Verification before storing: a POST of `{"type":"verification","challenge":"<32 random bytes,
  base64url>"}`, signed like a delivery with `webhook-id: msg_verification_<random>` and
  `X-MCP-Subscription-Id: <id>`, 10 s timeout. It needs a 2xx whose JSON body is `{"challenge":
  "<the same>"}` (compared in constant time); otherwise `-32015` with `data.reason`
  `challenge_failed`, `timeout`, `connection_failed` or `blocked_address`. A success for the same
  principal, URL and secret is reused for an hour.
- `refreshBefore`: now + 7 days; a `ttlMs` grants less (at least one minute); `ttlMs: null` (no
  expiry) is not granted, the 7 days apply. An expired subscription gets no deliveries and is
  dropped. ChatGPT refreshes with `events/subscribe` before `refreshBefore`.

**`events/unsubscribe`** `{name, arguments?, delivery: {url}}` (the subscribe identity) or `{id}` →
`{}`. Idempotent: an unknown subscription is `{}` too. Another principal's subscription is refused
(`-32000`, `forbidden`).

**Delivery.** One POST per event and subscription, body
`{"eventId": "evt_<32 hex>", "name": "software_factory.job", "timestamp": "<ISO time of the
transition>", "data": <payload>, "cursor": null}` (at most 256 KiB; never larger in practice),
serialized once and sent byte for byte on every attempt. Headers: `Content-Type: application/json`,
`webhook-id` (= `eventId`), `webhook-timestamp` (Unix seconds of this attempt), `webhook-signature`
(`v1,<base64 HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<body>">` keyed with the decoded
secret, Standard Webhooks; two space-separated signatures during a secret rotation),
`X-MCP-Subscription-Id`. Each attempt has 10 s and never follows a redirect, uses no proxy and runs
in the `sf serve` process, never in the Implementer's environment. Outcomes:

| Answer | Then |
|---|---|
| 2xx | delivered |
| 410 | the subscription is removed with its pending deliveries |
| 413 | the event is dropped |
| other 3xx and 4xx, `blocked_address` | dropped, not retried |
| 5xx, timeout, connection failure | retried after 5 s, 30 s, 2 min, 10 min and 1 h (at most 6 attempts), then dropped |

Deliveries never block the state transition. Pending ones are kept in
`${SF_STATE_DIR}/events-queue.json` (attempts made, next time, the exact body), so a restart of
`sf serve` resumes them with the same `eventId` (a due one at once). Each attempt is appended to the
job's `events.jsonl` as `{type: "event_delivered" | "event_failed", subscription, attempt, status}`
(`status`: the HTTP status, or `timeout`, `connection_failed`, `blocked_address`, `too_large`,
`no_subscription`); `sf watch` and the dashboard show it as one line,
`event to <id> attempt <n> delivered|failed: <status>`.

**Store.** `${SF_STATE_DIR}/subscriptions.json` (0600, replaced atomically):
`{subscriptions: [{id, principal, event, input, url, secret, previousSecret?, previousSecretUntil?,
createdAt, refreshBefore, cursor: null}]}`; the secret is stored as given because it signs the
deliveries. An invalid file stops `sf serve` (`events_state_invalid`).

**`sf events`** (through the socket): `list` prints `ID`, `PRINCIPAL`, `EVENT`, `INPUT`, `HOST`
(of the URL only), `CREATED` and `REFRESH_BEFORE`, never the secret; `remove <id>` removes one and
its pending deliveries; `test <id>` sends one event with `state: "test"` (workspace and ticket from
the filter, else `test`/`SF-TEST`) once, without retry or job log, and prints `delivered` and
`status` (a 410 removes the subscription).

In ChatGPT the user creates an event-triggered task on the event `software_factory.job` of the
Software Factory connector, with the instruction to call `check` for the ticket in the payload; the
exact UI wording is not documented here (see the ChatGPT task UI). One conversation per ticket
(SF-019): when a job is `pushed` or `aborted`, every subscription whose `ticket` filter is that
job's ticket receives that last event (delivered, or given up after the retries) and is then
removed, logged on the job as `subscription_removed` (`sf watch`: `subscription <id> removed:
the job ended`); a `failed` start keeps it for the next start. `sf events list` shows, per
subscription, the live job its ticket filter matches (`LIVE_JOB`).

## Jobs

One job per ticket; several jobs of a workspace at a time, up to `SF_MAX_JOBS` (default 3) in a
live state (`starting`, `working`, `awaiting_review`, `needs_human`, `ready_for_human_review`,
`preparing_mr`); `pushed`, `aborted` and `failed` free a slot. A further `start` is refused with
`job_limit`, naming the live tickets. Every job works in a **worktree** of its own (SF-019,
ADR-0004): `${SF_WORKTREE_ROOT:-<state dir>/worktrees}/<workspace>/<ticket>`, created from the
workspace's checkout; the checkout itself (the user's IDE checkout) is never written by the
factory beyond its Git refs (branches, `refs/sf/snapshot/*`) and worktree registrations.

- `start` reads `.software-factory/<ticket>.md` of the checkout (its `base` and `title`), fetches
  `origin <base>` when `origin` exists (60 s), refuses an existing branch (`branch_exists`) or a
  leftover worktree directory or registration (`worktree_exists`; `sf reset` of the ticket removes
  it), runs `git worktree add --no-track -b <ticket>-<slug> <path> <origin/base or base>` and,
  when `.gitmodules` exists, `git submodule update --init --recursive` in the worktree (120 s).
  The Task file is copied into the worktree (`.software-factory/<ticket>.md`, the directory
  excluded through the shared `info/exclude`), and the first turn `/implement
  .software-factory/<ticket>.md` runs with the worktree as cwd. A previous job of the ticket in
  `failed`, `aborted` or `pushed` is archived first; any other state refuses (`job_exists`). The
  record and the validation are under the job lock, the fetch and the worktree creation under
  the workspace's Git lock, so a long fetch holds no other job.
- When the session is idle (its last queued turn ended), the factory publishes an iteration: the
  Report (the last assistant text, plus `## Changed files` and `## Denied actions`), the Patch
  (`git diff <base commit>` plus untracked files in the worktree, without ignored,
  credential-like and `.software-factory/` paths, at most 2 MiB) and the structured file list
  (`files` in `meta.json`, SF-024: `path`, `status` added/modified/deleted, `sensitive`
  declared/undeclared/no, `additions`, `deletions`). The job goes to `awaiting_review`.
- `request_fix` appends `## Fix N` to the Task file of the checkout, copies it into the worktree
  and runs `/implement .software-factory/<ticket>.md Fix N` in the same session (`resume`). From
  `ready_for_human_review` it first reopens a worktree from the branch (`git worktree add <path>
  <branch>`): the next iteration's Patch is the whole change against the target, and the next
  Clean amends the prepared commit.
- `mark_clean` runs the MR preparation (section below) and ends in `ready_for_human_review` with
  the branch in the checkout. It takes `sensitive`, the undeclared sensitive paths of the reviewed
  iteration the Context owner accepts; any left out refuse it with `sensitive_unacknowledged`.
- Every prompt the factory sends (the `/implement` line of `start` and `request_fix`, or the user's
  message of `sf say`) is followed by a blank line and `FACTORY_PROMPT_RULES` (`src/prompts.ts`):
  the factory's rules and the Report template, with the ticket and iteration filled in.
- `check` returns the last published Report and Patch in every state except `working` and
  `starting`, and `files`: the sensitive paths (with `declared`) and the deleted paths of that
  iteration. `meta.json` records `cost_usd` (this iteration's cost) and `cost_usd_total` (the
  SDK's cumulative total for the session).
- `sf say` queues a message as the next turn (in `working`, `awaiting_review`, `needs_human` or
  `ready_for_human_review`, where it reopens the worktree like `request_fix`); outside `working`
  the job goes back to `working` and publishes a new iteration at the end.
- A failed turn, a session that does not report permission mode `auto`
  (`permission_mode_mismatch`), an unavailable sandbox (`sandbox_unavailable`, with the SDK's
  message) or the iteration limit put the job in `needs_human`. When `sf serve` starts, jobs found
  `working` become `needs_human` (`serve_restarted`) and keep their session for `sf say`; jobs found
  `preparing_mr` become `needs_human` (`mr_serve_restarted`) for another `mark_clean`. Nothing is
  retried automatically.
- `check` also returns `mr`, the MR text, once MR preparation produced one.
- `sf abort` works in every non-terminal state: it aborts the running turn (queued prompts are
  dropped) and sets `aborted` without `error`; the branch and the worktree stay, and the
  worktree's path is printed (`worktree` in the result). `--discard` removes the worktree
  (`git worktree remove --force`, `git worktree prune`) and the branch (`git branch -D`); a
  failing step leaves `aborted` with `error.code` `discard_failed`. `--discard` is refused
  (`rebase_in_progress`) while a rebase or a Git lock is in progress in the worktree.
- `sf reset` works in every state: it ends a live session, removes the worktree and archives the
  job directory as `start` archives a terminal job. The branch is not touched; the job's snapshot
  ref (`refs/sf/snapshot/<ticket>`) is deleted, as on `pushed` and `abort`. When the workspace is
  no longer registered (or its checkout is gone), only the job record is archived and the result
  says `checkout: unavailable`; the dashboard's Archive of a finished job behaves the same.
  That Archive checks the state and retires the job in one hold of the execution lock, so a job
  that replaced the finished one in the meantime is refused (`invalid_state`), never retired.
- The ticket actions Archive and Delete (dashboard start screen) run in one hold of the same lock:
  they check the ticket (a live job refuses with `job_active`), retire its finished job, and only
  then move or delete the Task and MR files (and, for Delete, the stored request). Restore and
  `start` wait for the whole action. A retirement that fails changes no file. A file operation
  that fails after a successful retirement is reported, but the job stays archived and the files
  stay as far as they got; nothing is rolled back.

The checkout's Git operations of one workspace (fetch, worktree add and remove, branch delete,
the snapshot ref, push) are serialized through one Git lock per workspace; turns, publication,
`check`, `say` and the start of another job run concurrently.

Every turn runs with `cwd` = the job's worktree, `permissionMode: "auto"`, `settingSources: ["user",
"project"]`, a per-turn deny list from `src/rules.ts` (iterations: mutating Git commands, `sudo`,
`EnterWorktree`, `.git/**` edits, `.env` files; MR preparation: the same with `add`, `commit`,
`rebase`, `restore`, `checkout`, `switch`, `rm` and `mv` allowed), a filtered environment (no
`SF_*`, no inherited Claude Code session markers) and, unless `SF_SANDBOX=off`, the sandbox
`{enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, network: {allowedDomains:
["registry.npmjs.org", ...SF_SANDBOX_DOMAINS], allowLocalBinding: true, allowAllUnixSockets: true}}`.
Local binding and Unix sockets are allowed so that the repository's own tests, which start servers on
loopback and on Unix sockets, run inside the sandbox. The factory's own `fetch` and `push` run outside
the Implementer, so the Git host is not needed there; a repository whose checks need other hosts
(another package registry, a test service) lists them in `SF_SANDBOX_DOMAINS`. Nothing is written
under `~/.claude`.

The sandbox (bubblewrap) needs a mount point for every path it masks. When such a path does not
exist in the worktree it creates it as a zero-byte file with mode 0444 and leaves it there:
`.bashrc`, `.gitconfig`, `.gitmodules`, `.mcp.json`, `.claude/settings.json`, `.claude/skills` and
others, plus the empty directory `.claude/.cc-writes/` (Claude Code's own). The factory removes them
(`src/placeholders.ts`) after every turn, before the Patch is built and before the MR verification,
and in `abort` before the Git steps, and logs what it
removed as `placeholders removed: a, b, c` in `sf watch` and the dashboard. The exact rule: in the
root of the worktree an entry whose name starts with `.`, and in `.claude/` any entry, is
removed when it is a regular file (not a symbolic link) of size 0 with mode exactly 0444; then
`.claude/.cc-writes` and `.claude` are removed when they are empty directories. Nothing else is
touched: a file with content, a writable file, a symbolic link, a non-empty directory and anything
deeper or elsewhere stay. The Patch and the `mr_dirty` check also skip an untracked file that matches
the rule, in case the sandbox recreates one after the cleanup. A file the factory left in place
does not match the rule, so it is a change of the Implementer's or the user's.

### Sensitive paths

`SENSITIVE_PATHS` in `src/rules.ts` (globs from the repository root: `*` and `?` inside one
segment, `**` across directories, `{a,b}` alternatives) names dependency manifests and lockfiles
(`package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `pom.xml`, `build.gradle*`,
`requirements*.txt`, `pyproject.toml`, `Pipfile*`, `go.mod`, `Cargo.toml`, `Gemfile*`,
`composer.json` and the like), environment and tool configuration (`**/.env*`, `**/*.env`,
`.npmrc`, `.nvmrc`, `.tool-versions`, `tsconfig*.json`, `*.config.{js,ts,mjs,cjs}`, `.eslintrc*`,
`.prettierrc*`, `.editorconfig`, `.gitignore`, `.gitattributes`, `.gitmodules`), CI and containers
(`.github/**`, `.gitlab-ci.yml`, `Jenkinsfile`, `Dockerfile*`, `docker-compose*.yml`,
`compose*.yml`, `.dockerignore`, `Makefile`), IDE and agent files (`.idea/**`, `.vscode/**`,
`.claude/**`, `CLAUDE.md`, `AGENTS.md`) and every dotfile in the root. `SF_SENSITIVE_PATHS`
(comma-separated globs) adds patterns. The Task file's front matter may declare `may_touch:` with
paths or globs the ticket is expected to change (`[a, b]` or `a, b`): a sensitive path matching it
is `declared`, every other sensitive path `undeclared`. The Report's `## Changed files` lists the
sensitive paths first under `### Sensitive` (each `declared` or `undeclared`, `deleted` when it
is) and the deleted paths under `### Deleted`; `sf status <ws> <ticket>` prints `sensitive:` and
`deleted:` lines; the `awaiting_review` (with `SF_NOTIFY_ITERATIONS=on`) and
`ready_for_human_review` notifications carry the same two lines (the body holds three lines, so
the ready notification shows the title and the sensitive line). `.env` files stay denied to the
Implementer; listing them is a second net for files created by tools it runs.

## MR preparation

MR preparation runs when the Context owner calls `mark_clean` (from `awaiting_review`, or as the
retry from `needs_human` after a failed preparation, `mr_attempts > 0`); never while a turn runs.
It ends in `ready_for_human_review` with the branch, holding exactly one commit, in the user's
checkout, and the worktree removed. `sf approve` then pushes that commit and nothing else.

1. Target: `git fetch origin <base>` (60 s) when `origin` exists, target `origin/<base>`, else the
   local `<base>`.
2. Snapshot of the reviewed change: a commit of the reviewed worktree, built in a temporary
   index (`GIT_INDEX_FILE` in the job directory): `read-tree <base_commit>`, every Patch path from
   the worktree (`hash-object -w`, `update-index --add --cacheinfo`; deleted paths
   `update-index --force-remove`), `write-tree`, `commit-tree <tree> -p <base_commit> -m "sf
   snapshot <ticket>"`. The commit is kept under `refs/sf/snapshot/<ticket>` (so `gc` keeps it),
   replaced on the next Clean and deleted on `pushed`, `abort` and `reset`; the worktree's
   index, `HEAD` and files are not touched. `mr-snapshot.json` records `target_ref`,
   `target_commit`, `base_commit`, `snapshot_commit` and the reviewed `paths`. A retry keeps the
   snapshot.
3. State `preparing_mr`, `mr_attempts + 1`, one turn in the same session with the MR deny list and
   `mrPrompt` (`src/prompts.ts`): target, previous error on a retry, the instructions, and the
   Handbook's `## Git rules` and `## MR template` verbatim. The instructions:
   - stage the files of the reviewed change by path, never `git add -A`, `git add .` or
     `git add -u` (inside the sandbox `git status` shows placeholder files such as `.bashrc`,
     `.gitconfig`, `.idea` and `.mcp.json` as untracked; they are not part of the change);
   - commit by the rules; when the branch already has a commit on top of the target (a Clean
     after a diff-check review, or after a fix asked in `ready_for_human_review`), amend it with
     `git commit --amend` instead of adding one;
   - `git rebase <target>`, resolve conflicts, run the checks;
   - write `.software-factory/<ticket>.mr.md`, its title exactly the commit subject;
   - use `git rev-parse --abbrev-ref HEAD` for the current branch (`git branch` is denied).
4. Verification, the first failure wins, each ending in `needs_human` with the worktree kept for
   the retry:

   | Code | Meaning |
   |---|---|
   | `mr_branch_mismatch` | `HEAD` of the worktree is not on the branch |
   | `mr_rebase_in_progress` | a rebase (or a Git lock) is still in progress |
   | `mr_dirty` | uncommitted changes outside `.software-factory/` |
   | `mr_not_rebased` | the target commit is not an ancestor of the branch |
   | `mr_commit_count` | not exactly one commit on top of the target |
   | `mr_commit_header` | the subject breaks `commitHeader(ticket)` in `src/rules.ts`: `<type>(<ticket>): <summary>`, type one of `feat fix chore refactor docs test perf build ci style revert`, at most 72 characters, no trailing period |
   | `mr_text_missing` | `.software-factory/<ticket>.mr.md` absent or empty |
   | `mr_text_invalid` | over 64 KiB, a first line that breaks the header rule or differs from the commit subject, or a missing `## What`, `## Why`, `## How`, `## Why the change`, `## Special things to note`, `## Change outline`, `## Testing` or `## Checklist` heading |
   | `worktree_remove_failed` | the branch is prepared but the worktree could not be removed |
   | `mr_failed`, `mr_serve_restarted` | the factory failed, or `sf serve` restarted, during preparation |

   A failed turn keeps its own code (for example `turn_failed` or `sandbox_unavailable`). Fix with
   `sf say` or by hand in the worktree and call `mark_clean` again.
5. Diff check by three-way merge: the change needs review again only when the branch differs from
   what a clean merge of the reviewed change onto the target gives. The expected result is
   `git merge-tree --write-tree --no-messages --name-only -z --merge-base <base_commit>
   <target_commit> <snapshot_commit>`; exit code 1 means conflicts, and every path it names counts
   as differing. For every reviewed path and every path of `git diff --name-only <target> <branch>`
   the blob of `<expected tree>:<path>` must equal `<branch>:<path>` (absent on both sides is
   equal), so a target change the rebase merged cleanly does not count. Otherwise `base_commit`
   and `target_commit` become the target commit, a new iteration is published (the Implementer's
   report plus `## MR preparation` naming the paths that differ; the Patch against the target),
   the worktree stays and the job goes back to `awaiting_review`. After Clean, the next
   preparation has nothing to commit or rebase.
6. Ready: the MR text is copied to `mr.md`, `base_commit` and `target_commit` become the target,
   `prepared_commit` the branch tip, the worktree is removed (`git worktree remove --force`,
   `git worktree prune`; `worktree` becomes null) and the job is `ready_for_human_review`,
   notified with the MR title and the file lines. `git checkout <branch>` in the checkout then
   gives the user the change.
7. `sf approve` (or the dashboard's Approve): allowed in `ready_for_human_review`, and in
   `needs_human` after a failed push. It refuses when the branch tip is not `prepared_commit`
   (`branch_changed`, with both hashes: the user edited the branch by hand), unless `--as-is`
   (`as_is` on the dashboard) pushes the tip as it is; `branch_missing` when the branch is gone.
   Then `git push origin <branch>:<branch>` with the protection below (120 s); `pushed` with the
   title and the merge request link (GitHub's compare page for `github.com`, GitLab's new merge
   request form otherwise; only the branch when the `origin` URL cannot be parsed). A failed
   push is `needs_human` with `mr_push_failed` or `mr_push_protected`; `sf approve` again
   retries it.

   | Code | Meaning |
   |---|---|
   | `mr_push_protected` | the branch is `main`, `master` or the job's base: nothing is pushed there directly, every change goes through a merge request |
   | `mr_push_failed` | `git push origin <branch>:<branch>` failed (120 s; stderr in the message) |

## Notifications

On `ready_for_human_review`, `needs_human`, `pushed` and `failed` (iterations are silent unless
`SF_NOTIFY_ITERATIONS=on`, which adds `awaiting_review` with `Priority: default`, `Tags: eyes` and
the body "Report and Patch of iteration N are ready for the Context owner") the
factory sends a desktop notification (`notify-send --app-name="Software Factory" "<ticket>:
<state>" <body>`, 5 s, when `notify-send` is on `PATH`) and, with `SF_NTFY_URL` set, one ntfy POST
(10 s; headers `Title`, `Priority` high for `needs_human` and `failed`, `Tags`). The body has at most
three lines: the branch, the error, or the MR title and link when pushed. A failure never changes
the job; it is appended to `events.jsonl` as `{type: "notify_failed", channel, message}` and shown
by `sf watch`. `sf notify-test` sends one test notification on both channels and prints what each
did.

ntfy is a push notification service: install the ntfy app on the phone and subscribe to a topic
name of your choice, then set `SF_NTFY_URL` to that topic's URL (for example
`https://ntfy.sh/<topic>`). On the free public server the topic name is the only secret, so make it
long and unguessable.

State layout under `${SF_STATE_DIR}`:

```
sf.sock                                  # 0600, while sf serve runs; one JSON request/response per connection
subscriptions.json                       # 0600, MCP event subscriptions with their signing secrets (section MCP Events)
events-queue.json                        # 0600, pending event deliveries, resumed at the next sf serve start
dashboard-token                          # 0600, the dashboard token of the last sf serve start
jobs/<workspace>/<ticket>/job.json       # workspace, ticket, branch, base, base_commit, target_commit, worktree, prepared_commit, mr_attempts, state, iteration, session_id, created_at, updated_at, error
jobs/<workspace>/<ticket>/events.jsonl   # {ts, iteration, message | prompt | state | type: "notify_failed" | "principal" | "event_delivered" | "event_failed" | "subscription_removed" | ...}; what sf watch reads
jobs/<workspace>/<ticket>/iterations/NNN/{report.md,patch.diff,meta.json}
jobs/<workspace>/<ticket>/mr-snapshot.json   # the reviewed change at Clean: target, base_commit, snapshot_commit, paths
worktrees/<workspace>/<ticket>/          # the job's worktree (SF_WORKTREE_ROOT), from start to Clean, abort or reset
jobs/<workspace>/<ticket>/mr.md              # the MR text, once pushed or after a diff-check iteration
jobs/<workspace>/<ticket>.<timestamp>/   # an archived earlier job
```

`iteration` in `job.json` counts published iterations; `updated_at` is the time of the last state
change (`since` in `check`).

## Dashboard

A page served by `sf serve` on a second loopback listener,
`http://127.0.0.1:${SF_DASHBOARD_PORT:-8788}/d/<token>/`, separate from the MCP port so the
tunnel never reaches it. The first `sf serve` writes a random token (32 bytes, hex) to
`${SF_STATE_DIR}/dashboard-token` (0600) and prints the URL; later starts reuse the file, so a
bookmark keeps working across restarts, and `sf dashboard` prints the URL again from that file
and `SF_DASHBOARD_PORT`. `sf dashboard --rotate` removes the file: the next `sf serve` start makes
a new token and prints the new URL (a running `sf serve` keeps the old one until then). A missing
or unusable file is replaced at start the same way; `SF_DASHBOARD=off` removes it. Any path
without the right token answers 404 with an empty body.

`sf dashboard --open` prints the same URL and then opens it in the browser with `xdg-open` (Linux
only, from `xdg-utils`), run without a shell with the URL as its one argument and waited for up to
10 s. The same checks as without `--open` come first (dashboard off, no or invalid token, invalid
port: exit 1, nothing launched). When `xdg-open` is missing, exits unsuccessfully or does not finish
in time, `sf` exits 1 with the reason; the printed URL stays usable by hand. Exit 0 means the
launcher accepted the URL, not that the page loaded: nothing checks that `sf serve` is running.
On another platform `--open` is refused (`open_unsupported`); plain `sf dashboard` works everywhere.

**The start screen (SF-025).** A Setup section at the top of the page, open while there is no
workspace or no job and collapsed with a one-line summary afterwards (the user's own toggling is
kept), in two parts. **Workspaces** lists the registry (name, path, live jobs, a problem such as a
missing checkout) with Remove (off while the workspace has a live job; the registration only,
nothing on disk changes) and an Add form: a name and the path of the local checkout, typed or
pasted (the page cannot browse the machine's disk), validated as `sf workspace add` does (an
absolute path that exists and is the root of a non-bare Git work tree, a name not registered
yet) with the refusal shown as it comes; the checkout is where the Task files live and from which every job's worktree is created.
**New ticket** takes the workspace, the ticket key, a one-line title, what the user wants in their
own words and the Context owner (ChatGPT; Claude Code is listed and disabled until SF-023), and
writes a **ticket skeleton** (SF-028), `.software-factory/<ticket>.md` in the checkout, through
the Task file writer: the front matter (`ticket`, `title`, `base` = the branch `origin/HEAD`
points at, else `main`), `# <ticket>: <title>` and `## Status: waiting for the Context owner`
with one line of explanation. The user's words are **not** written into it: they are kept in the
state directory (`<state dir>/requests/<workspace>/<ticket>.md`) and become the first message of
the ticket's conversation. An existing Task file is never replaced from the page
(`409 ticket_exists`). **Tickets** lists the Task files of every usable workspace whose ticket
has no live job, each with a line saying what it waits for (the conversation; the user's start;
a new start after a finished job), a `waiting for the conversation` badge for a skeleton, its last
job's state, its `Reviewer` line by the rules of the Reviewer block, and *Open the conversation*:
a link (`target=_blank`, opened only by the user's click, and the same URL in a box to copy) to
`https://chatgpt.com/?q=` plus the message of `ticketConversation` URL-encoded. The message names
the connector, `guide`, the ticket and the workspace, carries the user's words, and tells the
Context owner to investigate (`read_file`, `search`), discuss, write the Task file over the
skeleton with `write_task`, subscribe with the ticket's filter (the `sf ticket` instruction), and
call `start` itself only when the user says start. A message too long for a link (over 7500
characters of URL) is offered in a box to copy instead. Whether ChatGPT sends a prefilled message
by itself is up to ChatGPT, so the page says to press Enter if it is not. There is no Start
button: the job starts in the conversation (or with `sf start` in the terminal). Archive, Restore
and Delete… are described under SF-027. The workspaces and
the tickets come with the stream (`workspaces` and `tickets` events) on connect, after every
change made from a page, on every state change and on every change of the subscriptions, so two
open pages agree and the Reviewer line of a ticket turns to `subscribed` when ChatGPT subscribes.
A change made with `sf workspace add|remove` or `write_task` shows at the next refresh of the
stream (a state or subscription change, an action from a page, or a reload). Only the server's
ChatGPT URL becomes a link: a conversation URL without that prefix is rendered without one.

Version 2 shows, live: every job with its state; for the selected job (the most recently updated
one, or `#<workspace>/<ticket>` in the URL) a job card with the ticket, the state and the
Approve… and Abort… buttons in its head, the branch, base, iteration, estimated cost ("est. $",
not a charge) and update time as facts, the error, the Reviewer line and the message box; and
under it one card with four tabs (SF-026): Iterations (each iteration's Report and Patch), Merge
request (the MR text once there is one, else a note), State history, and Event stream (the
Implementer's session as `sf watch` prints it, following new lines; scrolling up switches follow
off). The selected tab is kept when another job is selected. The layout is one spacing and type
scale on cards: the Setup card, a 300 px sidebar with the jobs (ticket, workspace and branch,
state badge, a `no reviewer` or `broad` badge for live jobs only) and the collapsed
Subscriptions table, and the job on the right; below 900 px everything stacks. It also takes the user's three commands for the selected job, with the same meaning
as in the terminal: approve (`sf approve`, the push of the branch prepared at Clean, with an
explicit "as it is" choice for a tip edited by hand: `sf approve --as-is`), abort (`sf abort`,
with an explicit discard choice that is unchecked every time a confirmation opens: `sf abort
--discard`) and say (`sf say`: a multiline message; Enter adds a line, only the Send button
submits). Each is one deliberate click; approve and abort ask for a confirmation that names the
job and the branch, explains what follows (the push; the session ends and the worktree stays, or
the worktree and the branch go with discard) and sends nothing when cancelled. The page enables
a control from the state it shows (approve in `ready_for_human_review` and in `needs_human`
after a failed push; abort in every non-terminal state; say in `working`, `awaiting_review`,
`needs_human` and `ready_for_human_review`) and says why one is off, but the factory decides: a
refusal such as
`invalid_state` or `turn_running` from a concurrent `sf` command or Context-owner action is
shown as it comes. Nothing is retried or replayed: a reload, a reconnect or a network error never
repeats an action. An answer that does not settle the outcome (no answer, a body cut after the
headers even with status 200, a 2xx without a result, `internal_error` or any 5xx without a
factory code) is reported as an unknown outcome, because the action may have run; a 4xx, with or
without JSON, and a 5xx with a factory code are definite. After an unknown outcome the draft stays
and that job's controls stay off until a state read started after it succeeds (abort stays on while
a preparation is known to run). A failed read says so and shows a Refresh state button; the next
`job` event of the stream tries the read too. The read then lifts the hold but not the doubt: the
page says to check the state and the event stream, in a line of its own that a definite answer
does not replace, until the next action for the job starts; it sends nothing by itself. A read
without an answer in 10 s counts as failed, and a confirmation that the hold makes unavailable
closes. Approve and abort
stay the user's: the Context owner has no tool for them.

Approve answers when the push ends. The outcome is shown as the factory reports it: pushed with
the branch, the MR title and the link as text to copy (the branch and the title only, with a
note to open the merge request by hand, when the origin URL cannot be parsed); `needs_human`
with the push error; `branch_changed` as the refusal it is. Abort stays available in
`preparing_mr` (a Clean being prepared); it ends the preparation. Say shows whether
the message was queued behind a running turn (it has not run yet) or started a turn; the draft
stays on any error, only the text that was sent is cleared on acknowledgement, and drafts are
kept per job when the selection changes. A confirmation and a request are bound to the job they
were opened for: changing the selection closes the confirmation and never retargets a request,
and an answer that arrives for another job changes nothing on the shown one.

**Reviewer.** Under the job's header fields the page says who receives the job's MCP Events,
from the subscriptions of `sf events list` and with the rules of `sf ticket`: `Reviewer:
subscribed` with the id, host and filter of the subscription filtered on the job's ticket (and on
its workspace or none); `Reviewer: broad` (a warning) when only a subscription without a ticket
filter receives it, naming the id and `sf events remove <id>`; `Reviewer: none` (red), "Nobody will
review this job", and, while the job is not pushed, aborted or failed, a collapsed "Set up the
reviewer in ChatGPT" block with the two messages of `sf ticket` ("Call guide." and the
instruction that creates the ticket's task and subscription) in boxes with a Copy button (the
clipboard, or the text selected for Ctrl+C). When the ticket is subscribed and a broad subscription also matches, a
warning says ChatGPT would review it twice and names the `sf events remove` command. Send test
event is on only for `subscribed`: one request to the ticket's own subscription, "Sending…", then
whether it was delivered and the status, or the refusal; it is never retried, and an answer that
arrives after the selection changed is kept for its own job. The job list shows a `no reviewer`
(red) or `broad` badge on the card; a subscribed job has none. A Subscriptions section under the
job list shows each subscription's id, filter, host, refresh time and the live (not pushed,
aborted or failed) job its ticket filter matches, or "No subscriptions.". A subscribe, refresh,
unsubscribe, `sf events remove`, a 410 and the removal at the end of a job push the list, the subscriptions and the selected job
again over the stream; a subscription that only expires shows until the next refresh.

The page is plain HTML, CSS and JavaScript from `static/`, with no external resources, under
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self'` and `Cache-Control: no-store`; every value is rendered as text.

Endpoints under `/d/<token>/`. The read endpoints are GET only (anything else `405` with
`Allow: GET`); the action endpoints are POST only (anything else `405` with `Allow: POST`; GET,
HEAD and OPTIONS never act); `api/workspaces` and `api/tickets` list on GET and act on POST
(anything else `405` with `Allow: GET, POST`):

| Path | Answer |
|---|---|
| `api/jobs` | `{jobs: [...]}`: workspace, ticket, branch, base, state, iteration, mr_attempts, updated_at, created_at, error, reviewer (`subscribed`, `broad` or `none`) |
| `api/jobs/<ws>/<ticket>` | `{job, iterations: [{number, started_at, ended_at, cost_usd, changed_files, patch_truncated, denials}], mr, history: [{ts, from, to, error?}], reviewer, reviewerSetup: {guide, instruction}}`; `reviewer` is `{status: "subscribed" \| "broad", id, host, input, broad: [<ids of the subscriptions without a ticket filter that match>]}` or `{status: "none"}` |
| `api/subscriptions` | `{subscriptions: [{id, principal, input, host, createdAt, refreshBefore, job: "<ws>/<ticket>" \| null}]}`, the active subscriptions without URL or secret; `job` is the non-terminal job the ticket filter matches |
| `api/workspaces` | `{workspaces: [{name, path, liveJobs, problem}]}`: the registry, the checkout's path, its non-terminal jobs, and why the checkout cannot be used now or `null` |
| `api/tickets` | `{tickets: [{workspace, ticket, title, base, draft, request, job, reviewer, conversation: {message, url}}], archived: [{workspace, ticket, title}]}`: the Task files without a live job; `draft` is true for a skeleton; `request` the user's words of New ticket or `null`; `job` is the last job's state or `null`; `reviewer` as in the job detail; `url` is `https://chatgpt.com/?q=<message URL-encoded>`, or `null` when too long |
| `api/jobs/<ws>/<ticket>/iterations/<n>/report` | the Report, `text/markdown` |
| `api/jobs/<ws>/<ticket>/iterations/<n>/patch` | the Patch, `text/x-diff` |
| `api/jobs/<ws>/<ticket>/mr` | the MR text, `text/markdown`; 404 until there is one |
| `api/stream?job=<ws>/<ticket>&from=<line>` | server-sent events: `jobs` (on connect, on every state change and on every change of the subscriptions), `subscriptions` (as `api/subscriptions`, at the same times), `workspaces` and `tickets` (as the two endpoints, at the same times and after every setup action from a page), `job` (the job's detail, on connect, when it changes state and when the subscriptions change), `event` (`{line, ts, iteration, type, text}` for every visible line of `events.jsonl` from the 0-based `from`, as `sf watch` formats it); a comment every 15 s; at most 8 streams, then 503 |

| Method and path | JSON body | Calls |
|---|---|---|
| `POST api/jobs/<ws>/<ticket>/approve` | `{"as_is"?: boolean}` | `Execution.approve(ws, ticket, as_is)`: the push of the prepared branch; `as_is` pushes a tip edited by hand |
| `POST api/jobs/<ws>/<ticket>/abort` | `{"discard": false}`; `discard` optional, default false | `Execution.abort(ws, ticket, discard)` |
| `POST api/jobs/<ws>/<ticket>/say` | `{"message": "<text>"}` | `Execution.say(ws, ticket, message)`; the text goes as it is (nothing trimmed or split) |
| `POST api/jobs/<ws>/<ticket>/test-event` | `{}` | `sf events test` for the job's `subscribed` subscription: one test event (state `"test"`), result `{subscription, delivered, status}`; without one `404 no_subscription` and nothing is sent |
| `POST api/jobs/<ws>/<ticket>/nudge` | `{}` | `Events.nudge(job)`: the job's `awaiting_review` event again to every subscription that receives it, queued like a state change; result `{queued, pending}` (subscription ids: sent now, already on their way); `409 invalid_state` in any other state, `404 no_subscription` when nobody receives the job |
| `POST api/workspaces` | `{"name": string, "path": string}` | `Setup.addWorkspace`: the rules of `sf workspace add`; result the workspace row |
| `POST api/workspaces/<name>/remove` | `{}` | `Setup.removeWorkspace`; `409 workspace_busy` while the workspace has a live job; result `{removed}` |
| `POST api/tickets` | `{"workspace", "ticket", "title", "request"}` | `Setup.createTicket`: the ticket skeleton through the Task file writer, the request kept for the conversation; result `{workspace, ticket, path, base}` |

The actions go to the same `Execution` as the socket commands, under its lock and guards; there
is no second state machine and no other mutation endpoint. `test-event` goes to the same Events
hub as `sf events test`, and `nudge` to the same queue as a state change, with the same checks as
the actions below; neither changes a job. The setup
actions go to `src/setup.ts`, which writes the same registry file as `sf workspace add|remove`
and the same Task files as `write_task`, under the Execution's lock, so a registry change and a
start never interleave. An action request must carry the
token, an `Origin` equal to the page's exact origin (`http://127.0.0.1:<port>` with the actual
port; a missing Origin, another loopback address or port and the MCP origin are refused with
`403 invalid_origin`; a `null` or foreign Origin is already refused, `403`, by the loopback
Origin check every request passes), `Content-Type: application/json` (a `charset=utf-8`
parameter is accepted; anything else `415 unsupported_media_type`) and a body of at most 128 KiB
(`413 body_too_large`, checked against `Content-Length` and while reading; nothing is truncated)
that is UTF-8 JSON (`400 invalid_json`) of exactly the shape above: an object with the listed keys
of the listed types, no other key, no null, no array (`400 invalid_body`). Invalid names and
unknown jobs are an empty `404`, as for the reads. Nothing reaches the Execution until every check
has passed; a body cut by a disconnect is dropped without an answer. There is no CORS and no
form-encoded variant; the Host and Origin checks of the reads apply to every request.

Answers are JSON with the same security headers. A completed call is
`200 {"ok": true, "result": <the method's result, unchanged>}` whatever the outcome: an approve
that ended in `needs_human`, `awaiting_review` or `aborted`, and an abort that ended the job but
failed to discard (`result.error.code` `discard_failed`; the page says the discard may be partial
and never that the branch or the files were removed) are `200` too; the page reads `result`.
A `FactoryError` is `{"ok": false, "error": {"code", "message"}}` with its code and message kept,
under `409` for `invalid_state`, `turn_running`, `rebase_in_progress`, `job_exists`, `job_active`,
`job_limit`, `checkout_dirty`, `branch_exists`, `branch_changed`, `branch_missing`,
`worktree_exists`, `worktree_missing`, `sensitive_unacknowledged`, `ticket_exists`,
`workspace_exists` and `workspace_busy`,
`404` for `job_not_found`, `workspace_not_found`, `task_not_found`, `no_subscription` and
`subscription_not_found`, `400` for `invalid_content`, `invalid_ticket`, `invalid_name` and
`workspace_invalid`, and `500` for any other code (a Git failure before the preparation, for
example). Any other failure is `500`
with `internal_error` and a fixed message; the cause is logged, never the body or the token.

When the page's approve request is cut, the push goes on and its outcome is recorded in the job;
a second approve of a pushed job is refused (`invalid_state`).

**Files (SF-024).** The Iterations tab has a third view, Files, next to Report and Patch: the
structured file list of the selected iteration in the shape of IntelliJ's Changes list. One row
per file, the file name first and its directory after it in a muted colour, the row coloured by
status (added green, modified blue, deleted grey with the name struck through), labels
`sensitive, undeclared` / `sensitive, declared` / `deleted`, and the counts `+n −m` at the right.
Groups in this order: sensitive undeclared, sensitive declared, deleted, then the rest, each
sorted by file name. A click on a row expands, under it, that file's part of the iteration's
Patch (the section from its `diff --git` header to the next one, split in the browser from the
Patch text loaded once; nothing new from the server) as a unified diff with added lines green,
removed lines red and hunk headers muted; a second click collapses it. All rows start collapsed;
Expand all and Collapse all are in the view's header with the summary `Files N · M sensitive
undeclared · K deleted`. A file the Patch omits (binary, or beyond the Patch size limit) says so
in place of the diff; an iteration published before the list existed says so instead of rows.
The job card's head and the job list card carry badges: `N files`, and `M sensitive` (red) and
`K deleted` (orange) when the last iteration has undeclared sensitive or deleted files; the
`ready_for_human_review` job keeps the list of that iteration. The job detail's `iterations`
carry `files` (the list, or `null`), and `api/jobs` rows `files`, `undeclared`, `deleted`
counts, `worktree` and `prepared_commit`.

### Checking the page by hand

The automated checks run the page's script against a stand-in document
(`test/support/fake-dom.ts`), not a browser: layout, focus, Enter in the textarea and the form's
own behaviour are only checked by hand. With `sf serve` running on a throwaway repository and
`SF_CLAUDE` pointing at `dist/test/support/fake-claude.js` (or a real job you are willing to
end), in a browser:

1. Open the URL of `sf dashboard --open` and select a job in `awaiting_review`: Approve…, Abort…
   and the message box are on; in `pushed`, `aborted` or `failed` all are off with a reason.
2. Say: type two lines (Enter adds a line and submits nothing), click Send: "Sent" and an empty
   box; while that turn runs, send another: "Queued"; `sf watch` shows both prompts as typed.
3. Abort: click Abort…; the dialog names the job and the branch and says the files stay; Cancel:
   `sf status` is unchanged. Open it again: the discard box is unchecked; tick it: the button
   reads "Abort and discard the branch" in red; Cancel and reopen: unchecked again. Confirm a
   plain abort on a job you can lose: "Aborted; the branch … and the files stay"; the branch and
   files are still there.
4. Approve: from `ready_for_human_review` click Approve…, read the dialog, confirm: the status
   says MR preparation started, the badge turns `preparing_mr`, Approve… is off with a reason,
   Abort… stays on. When it ends: "Pushed …" with the title and the merge request link to copy
   (or the note to open it by hand).
5. A changed and a failed preparation (fake Implementer: one turn that commits an extra file, one
   that commits nothing): "Not pushed: the prepared commit differs … in <paths>" and the job back
   in `awaiting_review`; "Not pushed: MR preparation failed (mr_dirty: …)" with Approve… on again
   for the retry. Neither reads as a success.
6. Switching: start a say or an approve and select another job before the answer: that job's
   controls, status and draft are untouched; switch back: the outcome is there. A draft typed for
   each job stays with it.
7. Pending approve and disconnect: confirm an approve, close the tab, reopen the URL: the job is
   `preparing_mr`, `mr_attempts` did not grow, and the outcome appears in the history when it ends.
8. Reconnect: stop `sf serve` with the page open: the header says reconnecting and no request is
   re-sent; start it again and reopen the page with the new URL (the old token is 404).
9. Unknown outcome: with DevTools offline (or `sf serve` stopped) send a message: "outcome is
   unknown", the draft stays and Send, Approve… and Abort… stay off with a reason; the read fails
   and Refresh state appears; back online, click it: the state is current, the controls return,
   and nothing was re-sent.
10. Reviewer: on a job without a subscription the block reads `Reviewer: none` in red, the card
   in the list has a red `no reviewer` badge, Send test event is off and the two boxes hold
   "Call guide." and the instruction; Copy puts each on the clipboard (paste it somewhere to
   check). Send them in a new ChatGPT conversation: once the subscription is created the block
   turns to `Reviewer: subscribed` with its id, the badge goes and the Subscriptions section shows
   the row with the job, without a reload. Send test event: "Sending…", then "delivered, status
   200" (and ChatGPT answers in that conversation); switch jobs while it is out and the answer
   stays with its job. Subscribe a conversation without a ticket filter: the warning names it and
   `sf events remove <id>`; `sf events remove` it and the warning goes. Nudge the reviewer is on
   only for a job in `awaiting_review` with a subscription: "Sent the awaiting_review event of
   iteration <n> again to <id>", `sf watch` shows the delivery and the reviewer answers with
   `request_fix` or `mark_clean` in that conversation; once the job moves on the button goes off
   and the line goes.
11. Layout: narrower than 900 px the job list stacks above the detail and the buttons wrap; in the
   OS dark scheme the status colours and the dialog stay readable; Tab reaches Approve…, Abort…,
   the dialog's buttons, the textarea and Send; Escape closes the dialog. The Reviewer block,
   the Copy boxes and the Subscriptions table stay readable in both schemes and wrap or scroll
   inside their panel, never the page.
12. Tabs: Iterations opens by default; Merge request says there is no text until Clean prepared
   the branch, then shows it; State history and Event stream hold their content; the chosen tab
   stays when another job is selected. Approve… and Abort… sit in the head of the job card, next
   to the state badge; their reasons when off are the line under the facts. Approve… is on in
   `ready_for_human_review`; its dialog offers "push as it is" for a branch edited by hand.
14. Files: in the Iterations tab choose Files: the rows in the IntelliJ shape and order, the
   labels and counts; click a row: its diff opens under it, coloured; click again: it closes;
   Expand all opens every row, a binary file says the Patch omits it. The job card and the list
   card show `N files` and, when they apply, the red `sensitive` and orange `deleted` badges.
13. Start screen: with an empty registry (`SF_CONFIG_DIR` pointing at an empty directory) the
   page opens on Setup with the Add form; add a throwaway repository by its path (a wrong path
   shows the refusal in place); New ticket with a key, a title and two lines of request writes
   `.software-factory/<key>.md` as a skeleton (`## Status: waiting for the Context owner`, no
   request text), and the ticket appears under Tickets with `Reviewer: none`, a `waiting for the
   conversation` badge and the line saying to open the conversation; there is no Start button.
   *Open the conversation* opens a new tab on chatgpt.com with your words in the first message
   (press Enter if it stays there); the same URL is in the box and Copy puts it on the
   clipboard. Once the conversation created its task, the line turns to `Reviewer: subscribed`
   without a reload; once ChatGPT wrote the Task file the badge goes and the line says to say
   start in the conversation; after "start" the job appears under Jobs. With a workspace and a job
   the page opens with Setup collapsed and the summary line; Remove on a workspace with a live
   job is off with the reason. Narrow and dark: the two columns stack, the forms and the ticket
   cards stay readable and wrap inside their panel.

## Workspace registry

`<config dir>/workspaces.json`, written by `sf workspace add|remove` and by the dashboard's start
screen (`POST api/workspaces`):

```json
{ "workspaces": { "my-app": { "read_checkout": "/abs/path" } } }
```

Names are 1-64 characters of `a-z`, `0-9` and `-`, starting and ending with a letter or digit.
The path must be absolute and, whenever a tool uses it, the root of a non-bare Git work tree.
An invalid file is an error, never ignored. `read_file` and `search` read the checkout;
`write_task` writes `.software-factory/<ticket>.md` in it and adds `.software-factory/` to its
`.git/info/exclude`; every job's worktree is created from it (SF-019). A `work_checkout` field of
an older registry is read and ignored, with one warning when `sf serve` starts; `sf workspace add
--work` is refused.

## History

`factory/` replaced the bridge of SF-001 to SF-010: one process with a Workspace registry instead of
a single fixed repository root, Task files instead of instructions under `factory-data/` and
dispatch to a separate gateway, and an Agent SDK session instead of a file-based execution loop.
The file reader is a copy of the bridge's. SF-011-e removed the bridge; the factory took over its
port 8787 behind the tunnel (see `docs/design/SF-011-factory.md`).
