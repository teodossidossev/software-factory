# SF-010: ChatGPT review-ready events, feasibility report

Job: sf010-chatgpt-events-20261030. Date: 2026-10-30.

**Result: blocked at step 1. Nothing was implemented.** The supported path cannot be
established within this job's boundaries, so the job stopped before implementation as its
instruction requires. No source, dependency, registration, service, credential or
subscription changed, no build ran, and no callback was sent.

## Blockers

### B1 (hard): the bridge has no authenticated principal

ChatGPT supports webhook delivery only; polling and streaming are not supported.

- OpenAI, MCP Events: the `events/*` methods are served "on the same authenticated MCP
  endpoint" as tools, the subscription ID derives from "the authenticated principal", and
  the server checks that the user is authorized.
- Draft spec: "events/subscribe and events/unsubscribe MUST be called with an authenticated
  principal"; "Unauthenticated MCP servers may offer poll and push, but not webhook."
- OpenAI, Authentication: OAuth 2.1 is expected for authenticated servers. "ChatGPT does
  **not** support machine-to-machine OAuth grants such as client credentials", so a static
  service identity is not an available substitute.

Repository state:

- `bridge/src/server.ts:534` calls `createMcpHandler` with no `authInfo`; the SDK never
  derives one from headers. The probe confirms `authInfo: null`.
- There is no bearer verification or protected-resource metadata anywhere in `bridge/src`.
- `scripts/sf-tunnel.sh` creates the profile from `sample_mcp_remote_no_auth`.
- The tunnel documentation does not describe any principal for a no-auth connector.

A fixed synthetic principal such as "the tunnel owner" would satisfy the code and not the
contract: the deterministic ID and every per-user authorization check would be empty, and
`events/subscribe` is the call that makes the bridge send HTTPS to a caller-chosen URL.

### B2 (unproven): the tunnel may not route the 2026-07-28 protocol

ChatGPT requires protocol `2026-07-28` for events. tunnel-client 0.0.18's embedded
documentation says a channel accepts self-contained `2026-07-28` requests when it declares
`stateless`, and that a remote Streamable HTTP `main` channel "advertises neither capability
unless it independently supports self-contained requests". Our channel is exactly that:
`main` at `http://127.0.0.1:8787/mcp`. The profile has no such setting, and no way to set one
was found. The tunnel guide never mentions protocol versions, events or webhooks. The binary
has no `events/*` strings, which proves little because no method filter was found either.
Only a live discovery can settle this.

### B3 (account, not checkable from here)

Events are available in Work chats on ChatGPT web, in the desktop app with Cloud selected,
and with dots, subject to workspace controls for plugins and event-triggered tasks. Neither
the account's access nor those controls could be verified from this machine. The tunnel page
says tunnels do not support public plugin distribution.

### B4 (repository, implementable after B1 and B2)

No running process creates review-ready events today:

- `bridge/src/executor/main.ts` does not wire the supervisor's `reviewReady` option.
- `reconcileJobEvent` is called only by the coordinator, and `run` refuses because
  `PROVIDERS` is empty.
- `publishReviewReady` requires a provider delegation
  (`bridge/src/reviewer/events.ts:27`). A notification-only subscription needs its own
  app/job opt-in; it should not borrow review authority, and no provider may be activated.

## What is supported

| Requirement | Status |
| --- | --- |
| `server/discover` returns `2026-07-28` and `events: {}` | Works: installed SDK, proven by probe |
| Custom `events/*` handlers on the modern path | Works: registered through `setRequestHandler`, proven by probe |
| Bridge outbound HTTPS | No restriction in the `sf-bridge` unit; not exercised |
| Standard Webhooks signing | Possible with `node:crypto` and no new dependency |
| Connect-time address pinning, no redirects | Possible with `node:https` and a custom `lookup` |
| Non-replayable event, `cursor: null` | Allowed by the spec |
| Durable event identity | Exists: `eventId` in `bridge/src/reviewer/records.ts` |
| Authenticated principal | **Missing (B1)** |
| 2026-07-28 through the tunnel | **Unproven (B2)** |
| Account and workspace availability | **Unknown (B3)** |

The SDK has no events support of its own; the protocol would be hand-written on these
extension points. Version numbers played no part in these conclusions.

## What must happen next

Three things are kept separate: what is established, what is unresolved, and what is still a
design choice. Nothing in this section is authorized by this job.

### Established prerequisite

Webhook subscriptions need an authenticated principal (B1). That is the whole of what this
report establishes about authentication. It does not establish that any particular design,
migration or registration is required.

### Unresolved compatibility

- Whether the tunnel carries `2026-07-28` traffic to this bridge (B2).
- Whether ChatGPT, as the consumer, discovers and subscribes to events from a tunnelled server.
- Whether ChatGPT applies authentication to `events/*`, and how. The Authentication guide covers
  per-tool `securitySchemes` only. It does not mention `events/*`, `server/discover` or
  per-method authentication, and it does not say whether changing authentication on an existing
  connector needs a reconnect or re-registration.
- Account and workspace availability (B3).

### Step 1: bounded tunnel and client discovery check

Run this before selecting any authentication design. Each stage needs its own authorization;
neither is authorized by this job, and no stage subscribes or sends a callback.

**Stage A, passive observation: not available.** The installed diagnostics do not expose the MCP
method or protocol version, so Stage A cannot be run as a no-change check. This was checked against
existing data on 2026-10-30 at 09:43Z, generating no test traffic, after ChatGPT's ordinary calls
around 09:39Z:

| Surface | Result |
| --- | --- |
| Redacted log export (`/api/logs/export`) | 94 events, one distinct message ("dispatcher forwarded command to MCP server"); no method or protocol field |
| `/metrics` | `request_kind` is only `call`; `network_protocol_version` is the HTTP version, not MCP |
| `/health/mcp` | `state: not_observed`, `evidence: unsupported_transport`; `protocol_version` is reported only for stdio children, and this channel is `http-streamable` |
| `/api/status` channels | No `stateless`, `proc_affinity` or protocol field |
| Bridge journal | No request logging at all |

The two forwarded-command timestamps near the call cannot be tied to a method, so they say nothing
about the protocol. B2 stays unproven. Repeat the check with:

```sh
cd review/SF-010/chatgpt-events-20261030
TUNNEL_HEALTH_MCP="$(curl -fsS -m 5 http://127.0.0.1:8790/health/mcp)" \
  sh -c "curl -fsS -m 10 'http://127.0.0.1:8790/api/logs/export?minutes=120' | python3 -I tunnel-diagnostic-check.py"
```

It reads the export in memory, writes nothing, and prints allowlisted fields only. Its timestamp
window is fixed to this observation.

**Stage A2, minimal proposed diagnostic. Not applied, and it needs authorization.** Log one sanitized
line per MCP request from the factory at `bridge/src/server.ts:534`. The SDK already classifies the
request, so no body is parsed. An offline probe of the installed SDK reported `modern` with
`server/discover` and `2026-07-28` for a modern request, and `legacy` for `initialize`
(`era-diagnostic-probe.log`). The bridge has not been run with this change.

```ts
const LOGGED_METHODS = new Set(['initialize', 'server/discover', 'tools/list', 'tools/call', 'events/list', 'events/subscribe', 'events/unsubscribe']);
const mcpHandler = createMcpHandler((ctx) => {
  const method = ctx.requestInfo?.headers.get('mcp-method') ?? '';
  const protocol = ctx.requestInfo?.headers.get('mcp-protocol-version') ?? '';
  console.log(JSON.stringify({ at: new Date().toISOString(), era: ctx.era, method: LOGGED_METHODS.has(method) ? method : 'other', protocol: /^\d{4}-\d{2}-\d{2}$/.test(protocol) ? protocol : 'none' }));
  return createMcpServer(store, files, instructions, dispatches, execution);
});
```

- Required authorization: this source edit, a rebuild of canonical `bridge/dist`, and one restart of
  `sf-bridge.service`. No tunnel, profile, registration or policy change. Remove the line afterwards.
- Traffic: one ordinary read-only tool call from ChatGPT is enough.
- Read: `journalctl --user -u sf-bridge.service --since '-10min' --no-pager | grep '"era"'`
- Pass: `era: modern` with protocol `2026-07-28` on a request that came through the tunnel. B2's
  routing question is closed for this channel.
- Fail: a tunnel rejection of such a request, seen as a tunnel error with no bridge line.
- Inconclusive: only `era: legacy`. The running bridge does not advertise `events`, so ChatGPT has no
  reason to require the modern path, and legacy traffic does not show that the modern path fails.
  Go to Stage B.

Do not use `--log.http-raw-unsafe`: it logs headers and bodies, which are out of bounds here. Do not
raise the level through `/api/log-level`: it changes the running daemon, and nothing shows that
debug output contains these fields.

**Stage B, after A2 passes or is inconclusive.** An isolated instance serves the existing tools
unchanged, advertises `events` and lists one event, and answers every `events/subscribe` with
`-32024` Forbidden (the draft's code). It stores nothing and contacts no callback URL.

- Required, each to be authorized explicitly: running that build; pointing a tunnel channel at it,
  which is a tunnel or profile change; refreshing the connector if ChatGPT does not re-discover;
  and workspace permission for event-triggered tasks. The account needs Tunnels Use if it selects
  the tunnel in connector settings. Tunnel-client's documented permissions for this are Tunnels
  Read and Use on the runtime key; Manage is needed only for admin operations, and this check
  needs none. Roll back by restoring the previous channel target and refreshing.
- Pass: `events/list` reaches the instance, and ChatGPT offers the event in the Work chat.
- Fail: `events` is advertised, but `events/list` never arrives, or the tunnel rejects it.
- Record: what ChatGPT does on `-32024`, particularly whether it prompts for linking. That is the
  evidence for choosing an authentication design, and the guide does not predict it.

### Step 2: select an authentication design

Selection criterion, for any option: **existing tool behavior is preserved**, unless the operator
explicitly decides otherwise. Candidates, none shown to be compatible with this connector:

| Choice | Options | Open question |
| --- | --- | --- |
| Scope | Per-tool `securitySchemes`, with `noauth` and `oauth2` policies on the tools; or linking for the entire server | How either reaches `events/*`, for which the guide is silent |
| Client registration | CIMD (preferred by the guide), DCR, or a predefined client | What the chosen authorization server supports; the guide gives no detail on predefined clients |
| Authorization server | To be chosen | The tunnel does not carry it, so reachability must be established |
| Connector | Whether re-registration or a refresh is needed at all | Not stated; `sample_mcp_with_dcr` is one possible profile, not a requirement |

The guide's per-tool model needs both the metadata and the runtime `_meta["mcp/www_authenticate"]`
errors, and the server still verifies token, scopes and audience on every call. A hybrid design is
therefore a real option, and not yet a proven one here. If Stage B's evidence and the options above
do not settle it, ask OpenAI how `events/*` authentication works for a tunnelled connector.

### Step 3: reach and availability

If Stage A2 or B fails, the tunnel path is not established for events. That alone does not establish
that a public HTTPS endpoint is necessary: the cause could be the tunnel-client version, the channel
declaration or the consumer. Diagnose it first. A public endpoint would be a separate network
decision, taken only with evidence that nothing narrower works. Confirm Work chat and
event-triggered task availability alongside Stage B.

### Step 4: implement

Only then implement this job's step 2: an event opt-in separate from review delegation, discovery,
subscribe/unsubscribe, signed callback with verification, and B4's wiring.

## Deferred deliverables

Rollout commands, the live-test procedure and the two-subtask review-loop test are not
published: exact commands cannot be written for a design that depends on the steps above.
Filter, retry and test work from step 3 was not started.

Spec discrepancy for the later implementation: callback failure is `-32015` on the OpenAI page
and `-32027` in the draft. Use `-32015`, as ChatGPT is the client. Timestamp tolerance and retry
counts are not stated by OpenAI; the draft suggests 5 minutes and 3 to 5 attempts over at most
15 minutes.

## Evidence

`review/SF-010/chatgpt-events-20261030/`: `sdk-probe.mjs`, `sdk-probe.log`,
`tunnel-evidence.txt`, `tunnel-diagnostic-check.py`, `tunnel-diagnostics.log`,
`era-diagnostic-probe.mjs`, `era-diagnostic-probe.log`, `README.md`, `SHA256SUMS`.

Sources, read 2026-10-30, pages undated: OpenAI MCP Events, Secure MCP Tunnels, Authentication
(developers.openai.com, including the section Triggering authentication UI); dots (learn.chatgpt.com); the MCP Events design sketch, a draft in
`modelcontextprotocol/experimental-ext-triggers-events`. Parts of the longer draft and the dots
page were read through a summary rather than verbatim, including the handshake and retry
guidance. The B1 quotations came from verbatim text.
