# Runbook: ChatGPT and the local factory through the Secure MCP Tunnel

Verified with tunnel-client **v0.0.18** (`0.0.18+274a5588`) on Linux x86_64 and Node v24.17.0.
The first real ChatGPT probe passed on 2026-10-25 (`docs/reports/SF-002-report.md`, task
`docs/tasks/SF-002-connect-chatgpt.md`). SF-011 moved the endpoint from the old bridge to the
factory; the tunnel, the profile and the connector did not change.

No secrets here. The runtime key lives only in a 0600 file outside the repository.

## How a request travels

```
ChatGPT (Work chat, connector "Software Factory", No authentication)
  → OpenAI-hosted /v1/mcp/{tunnel_id}
  ← tunnel-client on this machine: outbound HTTPS to api.openai.com:443, long poll
  → http://127.0.0.1:8787/mcp   (sf serve, loopback only)
  → the registered workspaces
```

There is no inbound port, port forwarding or public listener.

Credentials sit on two layers:
- **Transport.** Only tunnel-client uses the runtime key (a `file:` reference in the profile).
- **MCP.** No OAuth: ChatGPT is set to *No authentication*. The factory listens on loopback only,
  checks Host and Origin, and is reachable only through the private tunnel (ADR-0002). Since
  SF-015 the factory can also require OAuth tokens from Auth0; see "OAuth with Auth0" below.

## Files and locations

| What | Where |
| --- | --- |
| tunnel-client | `~/.local/opt/tunnel-client/v0.0.18/` (with bundled `cloudflared`), symlink `~/.local/bin/tunnel-client` |
| Profile | `~/.config/tunnel-client/software-factory.yaml` (created by `scripts/sf-tunnel.sh init`) |
| Profile example | `config/tunnel-client/software-factory.example.yaml` |
| Runtime key | `~/.config/software-factory/tunnel-runtime.key` (0600, directory 0700) |
| Launcher | `scripts/sf-tunnel.sh` (`init`, `set-key`, `check`, `doctor`, `run`) |
| Factory | `factory/bin/sf serve` on `127.0.0.1:8787/mcp` |
| tunnel-client admin | `http://127.0.0.1:8790/ui`, `/healthz`, `/readyz` (loopback only) |

## Installing tunnel-client (done once)

Source: https://github.com/openai/tunnel-client/releases/latest (v0.0.18, flavor `client`).

```bash
d=$(mktemp -d) && cd "$d"
base=https://github.com/openai/tunnel-client/releases/download/v0.0.18
curl -fsSLO "$base/tunnel-client-v0.0.18-linux-amd64.zip"
curl -fsSLO "$base/SHA256SUMS.txt"
sha256sum -c --ignore-missing SHA256SUMS.txt     # expect: ...linux-amd64.zip: OK
mkdir -p ~/.local/opt/tunnel-client/v0.0.18 ~/.local/bin
unzip -oq tunnel-client-v0.0.18-linux-amd64.zip -d ~/.local/opt/tunnel-client/v0.0.18
ln -sfn ~/.local/opt/tunnel-client/v0.0.18/tunnel-client ~/.local/bin/tunnel-client
tunnel-client --version
```

Expected SHA256 of the zip: `3c82307316acd93c88a384b62af1d81d3f4cb0efa975f9c0bfaef922866a04c4`. It
matches `SHA256SUMS.txt` and the digest in the GitHub API. The Sigstore attestation was not
checked, because `gh` was not installed.

## Account steps (the user does these)

Never paste a key, password or cookie into a chat.

1. **Organization.** Open https://platform.openai.com and, top left, choose the personal Platform
   organization that owns the tunnel.
2. **Permissions.** In https://platform.openai.com/settings/organization/people/roles check that you
   have Tunnels **Read + Manage + Use**. Manage creates the tunnel; Use is needed for the runtime
   key and for choosing the tunnel in ChatGPT. A new role can take up to 30 minutes to apply.
3. **Tunnel.** In https://platform.openai.com/settings/organization/tunnels create a tunnel (for
   example `software-factory`).
   - Its associations must include this Platform organization and the target ChatGPT workspace.
   - Copy the `tunnel_id` (`tunnel_…`). It is an identifier, not a secret.
4. **Runtime key.** In https://platform.openai.com/settings/organization/api-keys create a key for
   the tunnel. Its principal needs Tunnels Read + Use. Store it at once, from the repository root:

   ```bash
   scripts/sf-tunnel.sh set-key      # hidden prompt; paste the key, Enter
   ```

   - This is a transport credential, not permission to use the model API.
   - `set-key` wants the runtime key (`sk-…`), not the `tunnel_id`. In SF-002 the `tunnel_id` was
     entered there once and the control plane answered 401 Unauthorized. `set-key` and `check` now
     refuse a value that starts with `tunnel_`.

## Running locally

Two terminals, one per process.

One terminal does for both: `npm start` at the repository root (`sf up`) runs the factory, the
tunnel (`scripts/sf-tunnel.sh run`, its lines prefixed `tunnel | `) and opens the dashboard;
Ctrl+C stops both. When the profile or the key is missing it says so in one line and runs
without the tunnel. The two halves separately:

**Factory (terminal 1):**

```bash
cd factory
npm install && npm run build      # once, and after every change to factory/src
bin/sf serve                      # prints the MCP URL http://127.0.0.1:8787/mcp and the dashboard URL
```

**Tunnel (terminal 2), from the repository root:**

```bash
scripts/sf-tunnel.sh init tunnel_XXXXXXXX   # once, or when the tunnel changes
scripts/sf-tunnel.sh check                  # exit 0 = client, profile, key file and factory OK
scripts/sf-tunnel.sh doctor                 # tunnel-client doctor --explain
scripts/sf-tunnel.sh run                    # foreground daemon; keep it running
tunnel-client health --port 8790 --require-control-plane-poll   # from another shell
```

Stopping:
- `Ctrl+C` in its terminal. `run` hands the signal straight to tunnel-client through `exec`.
- For a background process: `kill -TERM <pid>`. Find the PID with
  `pgrep -f 'tunnel-client run --profile software-factory'` and `ss -ltnp | grep 8787`.
- Stop only these two processes.

Restart: stop the process and run the same command again. The tunnel does not support two active
clients at once, so stop the old one first. Restarting `sf serve` alone does not need a tunnel
restart; check the tunnel with `tunnel-client health --port 8790 --require-control-plane-poll`.

## The connector in ChatGPT (while `run` is healthy)

The connector is created once and stays the same.

1. Open https://chatgpt.com/plugins, press **+** and choose **Add custom MCP server**.
2. Name: `Software Factory`.
3. Connection: **Tunnel**. Choose the tunnel or enter the `tunnel_id`.
4. Authentication: **No authentication**. The runtime key is **not** entered here.
5. Read the warning, choose **I understand and want to continue**, then **Create as a plugin**.
6. In the plugin details check that the tools are `guide`, `read_file`, `search`, `write_task`,
   `start`, `check`, `request_fix` and `mark_clean`. Then press **Install**.

After a change to the tools (or after switching the endpoint from the old bridge to the factory):
restart `sf serve`, open the existing **Software Factory** plugin at https://chatgpt.com/plugins
(do not create a new one), press **Refresh** and check the tool list. Then open a **new** Work
chat; an old conversation does not pick up new tools by itself.

## OAuth with Auth0

Optional; without it everything above stays as it is. ChatGPT runs the OAuth 2.1 code flow with
PKCE against Auth0 and sends the access token to the factory, which only verifies it
(`factory/README.md`, section OAuth). ChatGPT is a Client ID Metadata Document client, so there
is no dynamic client registration and no client secret. Below, `<resource>` is the `https` URL
ChatGPT uses as the server's identifier, for example `https://sf.example.com/mcp`; it must be the
same string in Auth0, in the factory and in the metadata.

**In Auth0** (Dashboard of the tenant `https://<tenant>.<region>.auth0.com/`):

1. Applications → APIs → **Create API**: Identifier = `<resource>`, signing algorithm **RS256**.
2. Settings → General → API Authorization Settings: **Default Audience** = `<resource>`, so
   Auth0 issues JWT access tokens for this API.
3. Settings → Advanced: turn on **Client ID Metadata Document Registration**, **Resource
   Parameter Compatibility Profile** and **Include Issuer in Authorization Responses**.
4. Applications: import the ChatGPT CIMD client **from its URL** (the client metadata document
   URL ChatGPT names) and grant it access to the API of step 1 (its *APIs* tab, or the API's
   *Machine to Machine / Application Access* tab).
5. A user that may sign in (Database, Google or another connection enabled for that client).

**In ChatGPT:** the connector (https://chatgpt.com/plugins) with **Authentication: OAuth** and
**OIDC enabled unticked**. Edit the existing **Software Factory** plugin or create it as in "The
connector in ChatGPT" with OAuth instead of No authentication. ChatGPT reads the authorization
server from the factory's metadata and signs in through Auth0 on first use.

With *OIDC enabled* ticked, ChatGPT wants an ID token with the `openid` scopes before it contacts
the factory, and Auth0 does not grant those scopes to this kind of client (the exchange logs
`scope: null`): the sign-in and the code exchange succeed in Auth0's logs, the factory and the tunnel
see nothing, and ChatGPT shows "We couldn't connect this account" (its callback answers
`OAUTH_OWNER_PROFILE_ID_MISSING`, visible in the browser's network panel). Seen on 2026-11-03,
when the first day's token expired; the plugin had connected the day before with the same settings.

**The factory** (terminal 1, instead of the plain `bin/sf serve`):

```bash
cd factory
export SF_AUTH_ISSUER=https://<tenant>.<region>.auth0.com/   # exactly the token's iss, trailing slash included
export SF_AUTH_AUDIENCE=<resource>                         # the API identifier of step 1
# export SF_AUTH_RESOURCE=<resource>                       # only when it differs from the audience
bin/sf serve                                               # prints: auth: https://<tenant>... audience <resource>
curl -s http://127.0.0.1:8787/.well-known/oauth-protected-resource   # the metadata document
```

To check a token by hand, without the server: copy an access token issued for the API (for example
from the Auth0 API's *Test* tab) and pipe it in, so it never appears on the command line:
`xclip -o -selection clipboard | bin/sf auth-test`. It prints `valid: sub ...` or
`rejected: <reason>`.

**Check the tunnel** (terminal 2, from the repository root):

```bash
tunnel-client doctor --profile software-factory --explain   # oauth_metadata must pass
```

Then, in a new Work chat, call a tool: ChatGPT asks to sign in once, and `sf watch` shows
`start by <sub>` (and the same for `request_fix`, `mark_clean` and `write_task`) with the Auth0 user
id. A `401` in ChatGPT with `software-factory bearer token rejected: <reason>` in the `sf serve`
output names what to fix: `wrong_audience` (the Default Audience or the resource differs from
`SF_AUTH_AUDIENCE`), `wrong_issuer` (`SF_AUTH_ISSUER` without its trailing slash), `expired`
(the clock or an old token), `unknown_kid` (another tenant), `jwks_unavailable` (Auth0 not
reachable from this machine).

### Tunnel settings for OAuth

ChatGPT discovers the factory's OAuth metadata through the tunnel's *harpoon* channel, which
forwards plain HTTP requests to the loopback factory, and the tunnel client itself reads the
authorization server's metadata at start. `scripts/sf-tunnel.sh run` therefore sets, when
`~/.config/software-factory/auth.env` holds `SF_AUTH_ISSUER`:

- `HARPOON_ALLOW_PLAINTEXT_HTTP=true`, so `http://127.0.0.1:8787` can be a harpoon target;
- `MCP_OAUTH_TRUSTED_ORIGINS=<issuer origin>`, so the client may fetch the issuer's metadata.

Without them the tunnel logs `destination origin is not trusted` and
`dispatcher received unsupported channel "harpoon"`, and ChatGPT reports "Couldn't discover
OAuth settings". Restart the tunnel after enabling OAuth in the factory: discovery runs at start.

## MCP Events (event-triggered tasks)

Since SF-016 the factory tells ChatGPT when a job needs the Context owner, instead of an hourly
scheduled task (protocol, shapes and delivery rules: `factory/README.md`, section MCP Events).
Preconditions:

- **OAuth on** (section above). Subscriptions belong to the token's `sub`; with *No
  authentication* the event methods answer `unauthenticated` and no event-triggered task can be
  created. `SF_AUTH_OPEN_METHODS` must not list `events/*` (`sf serve` refuses it).
- **Outbound HTTPS from this machine** to the callback URL ChatGPT gives (an OpenAI host). The
  deliveries are ordinary outbound POSTs from `sf serve`, not through the tunnel; they follow no
  redirects and go only to public addresses.
- MCP Events must be available for the account (Work chats; workspace controls for plugins and
  event-triggered tasks apply). Otherwise the scheduled task below stays the way.

In ChatGPT:

1. After restarting `sf serve` with this version, open the **Software Factory** plugin at
   https://chatgpt.com/plugins and press **Refresh**: the plugin page lists the event
   `software_factory.job` next to the tools.
2. One conversation per ticket. On this machine run `bin/sf ticket <workspace> <ticket>`: it
   warns about subscriptions that would also match the ticket (a filter without `ticket` makes a
   second review), prints the two things to send in a new conversation of the workspace's project
   ("Call guide." and the instruction that creates the event-triggered task subscribed with the
   filter `{"workspace", "ticket"}`), waits for that subscription to appear and sends it a test
   event. ChatGPT creates the subscription with `events/subscribe` when the task is created; the
   factory verifies the callback with a signed challenge before accepting. The task runs in the
   conversation where it was created, so plan, `write_task` and `start` the ticket there.
3. By hand instead: `bin/sf events list` shows the subscriptions (id, principal, filter, callback
   host, expiry); `bin/sf events test <id>` sends one event with `state: "test"` and prints
   `status: 200` when ChatGPT accepted it. `bin/sf ticket ... --no-wait` only prints the
   instruction.
4. Or in the dashboard (`bin/sf dashboard --open`): the job's Reviewer block says whether the
   ticket is subscribed, shows the same two messages to copy when nobody reviews it, warns about a
   subscription without a ticket filter and sends the test event.

While a job runs, `sf watch` shows each delivery as `event to <id> attempt <n> delivered: 200` (or
`failed: <status>`; 5xx and timeouts are retried for about 1 h 13 min). A `410` from ChatGPT ends
the subscription (the task was deleted); create the task again. `bin/sf events remove <id>` stops
deliveries from this side. ChatGPT refreshes a subscription before its `refreshBefore` (7 days);
the subscriptions and pending deliveries survive a restart of `sf serve`.

## Working in ChatGPT

From the dashboard (`npm start` at the repository root opens it; SF-025, SF-028): under **New
ticket** write the ticket key, a title and what you want in your words; the page creates an empty
skeleton of the Task file and keeps your words for the conversation. Under **Tickets** press
**Open the conversation**: a new tab opens ChatGPT with the whole first message in the composer
(the connector, `guide`, your words, the instruction to investigate, discuss, write the Task
file with `write_task`, create the event-triggered task subscribed to this ticket, and to start
only on your word); press Enter if it is not sent by itself. Discuss with ChatGPT there; when the
Task file is written and you agree, say "start" in that conversation and ChatGPT calls `start`.
The manual path, step by step:

1. Open a Work chat, type `@` and choose **Software Factory**.
2. The first call is `guide`. It returns the Handbook (`factory/HANDBOOK.md`): the cycle, the
   tools, the Task file format and the templates. The connector also sends its Quick start as
   server instructions.
3. Plan the ticket, write the Task file with `write_task`, and call `start` when the user says so.
4. With MCP Events (section above): one event-triggered task on `software_factory.job` per
   ticket calls `check` for the ticket in each event's payload. It reads the Report and the Patch
   when the job is `awaiting_review` and answers with `request_fix` or `mark_clean` (naming every
   undeclared sensitive path it accepts); when the job ends (`pushed` or `aborted`) the factory
   removes the ticket's subscription after that last event, so the task never fires again; delete
   it from the Scheduled view when convenient. A `failed` start keeps it for the next start. Without events (fallback): `start` and `request_fix` return `check_after_minutes`;
   in the planning conversation, create one ChatGPT scheduled task that calls `check` for the ticket
   on that interval, and delete it when `check` says `pushed`, `aborted` or `failed`.

`write_task`, `start`, `request_fix` and `mark_clean` are write actions; ChatGPT may ask for
confirmation.

## Diagnostics

- `scripts/sf-tunnel.sh check` shows which local precondition is missing, including a factory that
  does not answer on 8787.
- `tunnel-client doctor --profile software-factory --explain` checks the profile and the connection
  to the control plane.
- `http://127.0.0.1:8790/ui` is the tunnel-client admin UI.
- **`poll failed … 401 Unauthorized` in the `run` log.** The key file does not hold a valid runtime
  key for this organization, or its principal lacks Tunnels Read + Use.
- **The tunnel is not visible in ChatGPT.** Check the associations to the workspace and the Use
  permission.
- **403 from the factory.** A Host or Origin header that is not loopback; see `factory/README.md`.
- **Old tools in ChatGPT.** Press **Refresh** on the plugin and open a new chat.
- **ChatGPT cannot create the subscription** (for example "Webhook connectors could not be
  validated before creation", without a reason). `serve.log` in the state directory has one line
  per `events/list`, `events/subscribe` and `events/unsubscribe`: the filter, the callback host and
  `ok` or `refused <reason> (<message>)`. No `events/subscribe` line means the call never reached
  the factory: refresh the plugin and look at the tunnel.
- **"We couldn't connect this account" at Connect or Reconnect**, with Success Login and Success
  Exchange in Auth0's logs and nothing in `serve.log` or `tunnel.log`: the plugin has *OIDC
  enabled* ticked (section OAuth with Auth0). Untick it, or create the plugin again without it.
- **A daily Reconnect.** Auth0's access token lives 24 h and ChatGPT holds no refresh token
  (`offline_access` is neither advertised nor allowed on the API). Until that changes, connect
  again when a call answers 401.
- **No events arrive.** `bin/sf events list` (is there a subscription for this workspace?), then
  `bin/sf events test <id>`: `blocked_address` or `connection_failed` means this machine cannot
  reach the callback; `410` means ChatGPT dropped the task. `sf watch` shows each attempt.
