# OpenClaw Dashboard on this host (SF-005-UI)

The OpenClaw 2026.10.7 Control UI ("Dashboard") at **http://127.0.0.1:18789/**, reachable only from this computer. Gateway token authentication and browser pairing stay required, and the Gateway container keeps the SF-004 isolation.

## How it works

```text
browser ──► 127.0.0.1:18789 (host)            scripts/openclaw/dashboard-forward.mjs
              │  one `docker compose exec -T gateway node -e <pipe>` per TCP connection
              ▼
        127.0.0.1:18789 inside the container   OpenClaw Gateway (network_mode: none)
```

- **Container: unchanged.**
  - `network_mode: none`, so no Docker network, no published port and no egress;
  - read-only root, all capabilities dropped, `no-new-privileges`;
  - only the named state volume mounted; same image, volume, token and automations.
- **Forwarder.** It listens on `127.0.0.1:18789` only and relays bytes unchanged, both HTTP and WebSocket. It allows at most 16 connections at once and logs only connection counts. It runs only while you keep it running. It uses Docker the same way the SF-005 bridge does.
- **Configuration.** The Dashboard profile (`config/openclaw/profiles/dashboard.json5`) adds two keys to the SF-004 offline profile: `gateway.controlUi.enabled: true` and `gateway.controlUi.automaticallyFetchFavicons: false`. The second stops the UI's link favicon and preview fetches; the Gateway has no egress anyway. Unchanged:
  - the Gateway still binds to its loopback with token auth;
  - operator terminal, CLI agents, HTTP model endpoints, plugins, hooks, browser automation and exec stay off;
  - no model provider is configured.

### Why not a published Docker port

Checked on this host with Docker Engine 29.1.3 and Compose 2.24.6 (`review/SF-005-UI/network-probe.sh`):

- **No ports on an internal network.** Docker does not publish ports from an `internal: true` network. `-p 127.0.0.1:…` creates no listener there.
- **Internal networks still reach the host.** A container on such a network has no internet or LAN route. It **does** reach the host through the network's bridge address, including host services bound to all interfaces. Here that is Samba on 139/445.
- **Bridge networks give egress.** A normal bridge network would allow publishing a loopback port, but it gives the container outbound internet and LAN access.

So every Docker-network variant either does not work or widens what the Gateway can reach. The forwarder keeps `network_mode: none`.

## Prerequisites

- The SF-004 container is running and healthy: `scripts/openclaw/sf004-docker.sh up`.
- Node.js 24 on the host (already used by the bridge), Docker access, and a normal desktop browser on this computer.

## Enable (once)

```bash
scripts/openclaw/sf005-dashboard.sh enable
```

1. It shows the plan and asks `y/N`.
2. It copies the live `openclaw.json` to `/home/node/.openclaw/backups/openclaw.json.<UTC>.pre-dashboard` inside the volume (0600). The config holds no secret; the token is a SecretRef to a separate file.
3. It runs `openclaw config set` for the two keys. OpenClaw 2026.10.7 applies them without a restart. If it does not, the script asks before restarting the container.
4. It checks that `GET /` serves the UI and that the live config matches the `dashboard` profile.

It does not rerun `init`, does not touch the token, and does not delete or replace the volume.

## Open and pair the Dashboard

1. **Terminal 1:** start the forwarder and keep it running.

   ```bash
   scripts/openclaw/sf005-dashboard.sh forward
   ```

2. **Terminal 2**, an interactive terminal on this computer, gets a one-time pairing link:

   ```bash
   scripts/openclaw/sf005-dashboard.sh pair
   ```

   - The link comes from `openclaw dashboard` and is printed to this terminal only. It is valid for 10 minutes and works once.
   - Copy it into the address bar of the browser profile you will keep using.
   - Do not paste it into chat, tickets or files. `pair` refuses to run without a terminal, so it cannot be piped into a log.
   - It is not handed to the browser as a command-line argument: other local users could see that in the process list.
3. The browser opens `http://127.0.0.1:18789/` and redeems the link. It is then **paired as an operator device** and removes the link from the address bar.
4. Later visits only need the forwarder running and `http://127.0.0.1:18789/` in the same browser profile. The browser keeps its own device credential.

Notes:
- **Profiles.** Private windows and profiles that clear site data lose the pairing and need a new link. Each browser profile is a separate device.
- **No link at hand.** Without a link the page shows *"This Gateway expects its token"*. Prefer a new link over pasting the long-lived Gateway token. If you must use the token, read it only in an interactive terminal:

  ```bash
  docker compose -f deploy/openclaw/compose.yaml -p software-factory-openclaw exec gateway cat /home/node/.openclaw/secrets/gateway-token
  ```

  This prints the token to that terminal only. Never put it in a log or a chat.
- **Managing paired browsers:**

  ```bash
  C="docker compose -f deploy/openclaw/compose.yaml -p software-factory-openclaw"
  $C exec gateway node openclaw.mjs devices list
  $C exec gateway node openclaw.mjs devices remove <deviceId>
  ```

- **Model setup.** The UI first opens *Settings → Model Setup*, because no model is configured. Leave it: adding a model or provider is outside this setup, the container has no network to reach one, and `verify` reports any such change.

## Verify

The forwarder must be running:

```bash
scripts/openclaw/sf005-dashboard.sh verify     # Dashboard profile
scripts/openclaw/sf005-dispatch.sh verify      # SF-005 dispatch channel (works with either profile)
scripts/openclaw/sf005-dashboard.sh status     # read-only: profile, listeners, devices
```

`sf005-dashboard.sh verify` requires:

| Area | Checks |
|---|---|
| Container | Running, pinned image, `network_mode: none`, no published ports, read-only root, `cap_drop: ALL`, `no-new-privileges`, restart `no`, only the state volume; no route to the internet, LAN or Docker host addresses |
| Configuration | Live config matches the `dashboard` profile, with only doctor metadata as extra keys. Operator terminal, CLI agents, HTTP model endpoints, plugins and browser are off |
| HTTP | `/healthz` 200; `GET /` serves the Control UI (`<openclaw-app>`); `/control-ui-config.json` refuses unauthenticated requests |
| Host access | The only host listener on 18789 is `127.0.0.1`. The Dashboard answers there and on no other host address |
| WebSocket | Refused without credentials (`DEVICE_IDENTITY_REQUIRED`) and with a wrong token (`AUTH_TOKEN_MISMATCH`). With the Gateway token it passes token auth; the token goes from the volume into the probe's environment only |
| Audit | `security audit` and `--deep`: 0 critical |

The real-browser pairing check used for acceptance is `review/SF-005-UI/browser-check.mjs`:
1. headless Chrome with a throwaway profile opens the Dashboard without credentials, then with a one-time link it never prints;
2. it reloads;
3. it removes its test device.

## Rollback to the offline profile

```bash
# stop the forwarder first (Ctrl+C in its terminal)
scripts/openclaw/sf005-dashboard.sh disable
```

1. Backs up `openclaw.json` (`…pre-offline`).
2. Sets `gateway.controlUi.enabled false` and unsets `gateway.controlUi.automaticallyFetchFavicons`.
3. Checks that `GET /` is 404 and that the live config matches the `offline` profile, which is `config/openclaw/openclaw.json5` as in SF-004.

| Reverted | Kept |
|---|---|
| `gateway.controlUi.enabled` → `false` (UI and its HTTP routes return 404) | Image, Compose file, container settings (never changed) |
| `gateway.controlUi.automaticallyFetchFavicons` → removed | |
| Host listener on 127.0.0.1:18789 (when you stop the forwarder) | State volume and all its contents: gateway token, receiver, `sf-dispatch-receiver` automation, accepted requests, run history |
| | Config backups in `/home/node/.openclaw/backups/` |
| | Paired-device records. Remove them with `devices remove <deviceId>` if those browsers should not reconnect after a later `enable` |

Verified on this host: after `disable`, `openclaw.json` is byte-identical to the SF-004 file (sha256 `364a7516…`) and to the first backup. `openclaw config set` and `config unset` leave the rest of the file and its metadata alone.

If the live file was changed in other ways, for example through the Dashboard's Settings, restore a backup instead. Each `enable`/`disable` writes one, and the first `…pre-dashboard` backup is the SF-004 file:

```bash
C="docker compose -f deploy/openclaw/compose.yaml -p software-factory-openclaw"
$C exec gateway sh -c 'ls -l /home/node/.openclaw/backups/'
$C exec gateway sh -c 'cp /home/node/.openclaw/backups/<chosen backup> /home/node/.openclaw/openclaw.json'
$C restart gateway
scripts/openclaw/sf005-dispatch.sh verify
```

## Security trade-offs

- **The Dashboard is an administrator surface.** A paired browser holds an operator credential with admin scope (the `openclaw dashboard` handoff). In Settings it can change configuration: add a model, enable plugins, enable the operator terminal or exec.
  - The container still has no network, no host mounts and no Docker socket.
  - `verify` and `sf005-dispatch.sh verify` fail on any drift from the profile.
  - Treat paired browsers like the Gateway token.
- **Shared loopback and pairing.** `127.0.0.1:18789` is reachable by every local user of this computer while the forwarder runs. The Gateway token or a paired device credential is still required, and the token is 256 bits.
  - Through the forwarder the Gateway sees every connection as a loopback peer. That is OpenClaw's documented local-Dashboard mode, so loopback pairing auto-approval applies **after** token authentication.
  - Consequence: on this host **the Gateway token alone is enough**. A browser that presents the token gets paired without a separate approval step, and a client with the token but no device identity gets `operator.read` (verified).
  - Device pairing therefore does not add a second factor here. It only binds each browser to its own revocable device credential. Protect the token accordingly.
- **Plain HTTP.** Plain HTTP on loopback is OpenClaw's recommended local setup. It never leaves the host.
- **Docker access.** The forwarder uses Docker. Membership in the `docker` group is root-equivalent (see SF-004). The forwarder adds no new Docker privileges.
- **Accepted audit warning.** `security audit` reports `warn gateway.trusted_proxies_missing` while the UI is enabled. It does not apply: the forwarder is a byte relay that adds no forwarded headers, and the Gateway sees direct loopback peers. `--deep` also keeps the known SF-004 warning `gateway.probe_failed`.
- **No automatic start.** Nothing starts automatically after reboot. Start the container (SF-004) and the forwarder by hand.
