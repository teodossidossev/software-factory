# Runbook: ChatGPT and the local factory through the Secure MCP Tunnel

Verified with tunnel-client **v0.0.18** (`0.0.18+274a5588`) on Linux x86_64 and Node v24.17.0.
The first real ChatGPT probe passed on 2026-10-25 (SF-002). SF-011 moved the endpoint from the old bridge to the
factory; the tunnel, the profile and the connector did not change. Since SF-040 ChatGPT only plans
through it: it reads the repository, discusses the ticket with the user and writes the Task file;
the user starts the job on the dashboard, and the factory's own reviewers review it.

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
- **MCP.** No authentication: ChatGPT is set to *No authentication*. The factory listens on
  loopback only, checks Host and Origin, and is reachable only through the private tunnel
  (ADR-0005). Its tools only plan: `guide`, `read_file`, `search`, `write_task`, `task_check`,
  `read_attachment`, `queue_list` and `queue_add`. Nothing reached through them starts, reviews or
  approves a job; `queue_add` only puts a written ticket in the run queue.

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

One terminal does for both: `npm start` at the repository root (`sf up`) runs the factory, the
tunnel (`scripts/sf-tunnel.sh run`, its lines prefixed `tunnel | `) and opens the dashboard;
Ctrl+C stops both. When the profile or the key is missing it says so in one line and runs
without the tunnel. The two halves separately, in two terminals:

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
   `task_check`, `read_attachment`, `queue_list` and `queue_add`. Then press **Install**.

After a change to the tools (or after switching the endpoint from the old bridge to the factory):
restart `sf serve`, open the existing **Software Factory** plugin at https://chatgpt.com/plugins
(do not create a new one), press **Refresh** and check the tool list. Then open a **new** Work
chat; an old conversation does not pick up new tools by itself.

## Working in ChatGPT

From the dashboard (`npm start` at the repository root opens it; SF-025, SF-028): under **New
ticket** write the ticket key, a title and what you want in your words; the page creates an empty
skeleton of the Task file and keeps your words for the conversation. Its card appears in the
**Queue** column; a click opens the ticket's page, where **Open the ChatGPT conversation ↗** opens
ChatGPT in a new tab with the whole first message in the composer
(the connector, `guide`, your words, the instruction to investigate, discuss, write the Task
file with `write_task` with a `## Review brief`, and then tell you it is ready); press Enter if it
is not sent by itself. Discuss with ChatGPT there; when it says the Task file is ready, read it
and press **Start** on the ticket's Queue card (or **Start now** on its page, or run
`bin/sf start <workspace> <ticket>`), or add it to the queue. The manual path, step by step:

1. Open a Work chat, type `@` and choose **Software Factory**.
2. The first call is `guide`. It returns the Handbook (`factory/HANDBOOK.md`): the cycle, the
   tools, the Task file format and the templates. The connector also sends its Quick start as
   server instructions.
3. Plan the ticket and write the Task file with `write_task`, with a `## Review brief` for the
   reviewers; ChatGPT then tells you it is ready.
4. You start the job on the dashboard (or with `sf start`). From there the factory runs it: a
   fresh Claude review and the Codex gate review each iteration and turn their findings into Fix
   sections, and you approve or abort at the end. ChatGPT is not involved after planning.

`write_task` (the Task file) and `queue_add` (a written ticket into the run queue) are the only
write actions; ChatGPT may ask for confirmation.

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
- **Old tools in ChatGPT.** Press **Refresh** on the plugin and open a new chat. The list holds
  only the eight planning tools above (`guide`, `read_file`, `search`, `write_task`, `task_check`,
  `read_attachment`, `queue_list`, `queue_add`), and the plugin's
  Authentication must be *No authentication* (edit it, or create the plugin again).
