# SF-005-UI report: local OpenClaw Dashboard

Instruction: `factory-data/apps/sf-pilot/jobs/sf005-ui-local-dashboard-20261026/instruction.md`, implemented with `/implement` on 2026-10-26. Runbook: `docs/runbooks/openclaw-dashboard.md`. Review package: `review/SF-005-UI/MANIFEST.md`.

**Status:** implemented and verified on this host. The Control UI is enabled at `http://127.0.0.1:18789/`, reachable while the forwarder runs. Token authentication and browser pairing work in a real (headless) Chrome. The Gateway container is unchanged: `network_mode: none`, no published port. The SF-005 bridge → OpenClaw dispatch path still works.

## Blocker found, and the alternative used

The instruction prefers a Docker-published loopback port on a network without egress. On this host's Docker Engine 29.1.3 and Compose 2.24.6 that does not work, and the variants that do work widen access. Evidence: `review/SF-005-UI/network-probe.sh` and `logs/network-probe.log`, with a throwaway network and container.

| Option | Result |
|---|---|
| `internal: true` network + `-p 127.0.0.1:…` | **No listener is created**; Docker does not publish ports from internal networks. Egress is blocked (internet/LAN `ENETUNREACH`, no DNS), **but the container reaches the host through the network's bridge address, including host Samba on 139/445** (reachable: `CONNECTED`) |
| Normal bridge network + `-p 127.0.0.1:…` | Publishing works, but the container gets outbound internet and LAN access. Not used, because the instruction forbids an unrestricted outbound network |
| Sidecar proxy on two networks | Needs a second container with egress, and the Gateway's internal network would still reach host Samba. Not used |

**Used instead:** the container stays at `network_mode: none`. `scripts/openclaw/dashboard-forward.mjs` on the host:
- listens on `127.0.0.1:18789` only;
- carries each TCP connection through one `docker compose exec -T gateway node -e <pipe>` to the Gateway's in-container loopback;
- passes the bytes through unchanged;
- allows at most 16 connections and logs only connection counts.

This needs no new network, port, mount or privilege: it uses the same Docker access as the SF-005 bridge. It is therefore within the instruction's safety gate. A Docker-network variant would require explicit approval and, on this host, would open a path to Samba.

## What changed

| Area | Change |
|---|---|
| OpenClaw config (volume) | Two keys via `openclaw config set`, applied live without a restart: `gateway.controlUi.enabled: true`, `gateway.controlUi.automaticallyFetchFavicons: false`. Backups before every change in `/home/node/.openclaw/backups/` (0600). Nothing else changed: no `init`, token, volume or container change |
| `config/openclaw/openclaw.json5` | Comment only; it remains the SF-004 offline profile |
| `config/openclaw/profiles/dashboard.json5` | New: the Dashboard profile overlay (the two keys above) |
| `scripts/openclaw/openclaw-config-check.cjs` | The portable checker from SF-005 Review 01 now knows profiles: `offline` (template) and `dashboard` (template + overlay). It requires the live config to match exactly one profile, or the named one; extra keys may only be doctor metadata. It prints problems only on failure |
| `scripts/openclaw/sf005-dispatch.sh` | `check_config` is profile-aware (either profile, or a required one); `audit_checks` is shared |
| `scripts/openclaw/sf005-dashboard.sh` | New steps: `enable`, `disable` (rollback), `forward`, `pair` (one-time link to an interactive terminal only), `verify`, `status` |
| `scripts/openclaw/dashboard-forward.mjs` | New host-loopback forwarder |
| `scripts/openclaw/dashboard-ws-check.mjs` | New Gateway WebSocket handshake probe; reports outcome codes only |
| `bridge/test/dashboard-forward.test.ts` | New, 5 tests |
| `docs/runbooks/openclaw-dashboard.md` | New operator runbook |
| `docs/runbooks/openclaw-docker.md` | A short pointer to the Dashboard profile; the SF-004 text is unchanged |

Preserved, with before/after evidence in `baseline/runtime-state.log` and `logs/`:
- pinned image and container settings;
- named volume and gateway token (mode 600, unchanged);
- receiver `d9a9fea5…` and the disabled `sf-dispatch-receiver` automation `f431a516…`;
- 7 accepted requests and the run history;
- bridge (PID 684811) and tunnel-client (PID 337046).

Historical SF-004 and SF-005 evidence was not modified.

## Verification

| Instruction item | Evidence | Result |
|---|---|---|
| Real container settings | `sf005-dashboard.sh verify`: pinned image; `network_mode: none`; no published ports; read-only root; `cap_drop ALL`; `no-new-privileges`; restart `no`; only the state volume | PASS |
| Outbound isolation | In-container connects to 1.1.1.1:443, 192.168.0.1:80 and 172.17.0.1:445 are all unreachable | PASS |
| `/healthz` and Dashboard HTTP | `/healthz` 200; `GET /` 200 with the `<openclaw-app>` shell, inside the container and on the host via 127.0.0.1:18789 | PASS |
| Loopback only | The only host listener is `127.0.0.1:18789`; not reachable via 192.168.0.127 or any Docker bridge address | PASS |
| Unauthenticated access rejected | `/control-ui-config.json` returns 401/403. WebSocket without credentials: `DEVICE_IDENTITY_REQUIRED`. Wrong token: `AUTH_TOKEN_MISMATCH`. In Chrome without credentials: the *"This Gateway expects its token"* screen, and no device paired | PASS |
| Authenticated WebSocket | With the Gateway token, read from the volume into memory only: `hello-ok`, role `operator` | PASS |
| Browser/device pairing | `review/SF-005-UI/browser-check.mjs`, headless Google Chrome 155 with a throwaway profile, run twice: <br>1. a one-time `openclaw dashboard` link, never printed, pairs the browser as `openclaw-control-ui`/`operator`; <br>2. the link fragment is cleared; <br>3. the UI shows no auth or pairing error; <br>4. reload reconnects without a new request; <br>5. the test device is removed | PASS |
| Configuration | Live config matches the `dashboard` profile. Operator terminal, CLI agents, HTTP model endpoints, plugins, hooks, cron, ACP and browser are off. Checker: 12 cases, including SF-004 state, terminal, hooks, `bind: lan`, model provider and stray keys | PASS |
| Security audit | `security audit`: 0 critical, 1 warn (`gateway.trusted_proxies_missing`; see trade-offs). `--deep`: 0 critical, plus the known SF-004 warn `gateway.probe_failed` | PASS (0 critical) |
| Dispatch still operational | `sf005-dispatch.sh verify` passes (receiver hash, one disabled automation, scheduler off, config profile, doctor, audit). An MCP replay of two accepted dispatches returns `accepted/replayed` with byte-identical records. An idle receiver run is `ok` (`{"sf_dispatch":"idle"}`). No new dispatch was created; 7 accepted requests before and after. `sf-tunnel.sh check` passes | PASS |
| Rollback | `disable` → `enable`, tested twice. After the corrected `disable`, `openclaw.json` is **byte-identical** to the SF-004 file (sha256 `364a7516…`), `GET /` is 404, `/healthz` 200, and the offline profile passes `sf005-dispatch.sh verify` | PASS |
| No credentials in artifacts | Gateway-token scan of all SF-005-UI logs, scripts, docs and screenshot strings, compared inside the container: `count=0`. Pairing links are never printed or written | PASS |
| Tests | `npm run smoke`: 35/35 (30 earlier + 5 forwarder) | PASS |

Not verified: pairing in the operator's own, non-headless browser. The steps are in the runbook (`forward`, then `pair`, then open the link). Real-browser behaviour was verified with headless Chrome only.

## Code review

Two reviewers ran in parallel: standards and spec. Fixed:
- **Rollback was not exact.** It left `automaticallyFetchFavicons: false` in the offline profile, so the original SF-004 config no longer passed. The key now lives only in the Dashboard overlay, `disable` unsets it, and the rollback is byte-exact.
- **`pair --open` removed.** It passed the one-time link to `xdg-open` and the browser as an argument, which other local users can see in the process list. The link is now printed only to an interactive terminal.
- **`set -e` in `enable` and `verify`.** A failing `docker exec` or probe could abort before the restart fallback or before `[FAIL]`.
- **WS probe.** A timeout now closes the socket and exits; malformed frames are ignored.
- **Forwarder close order.** Stdin EOF comes first and `kill` only after a grace period. That is the first half-close fix; the second, found by the tests, is `allowHalfOpen` on the server side. 0 pipe processes were left in the container after two browser runs.
- **Smaller fixes:**
  - `verify` also requires hooks, cron and ACP to stay off;
  - the security-audit checks are shared;
  - the checker output is quieter on success;
  - a misleading comment is fixed.

Found by the operator after delivery: `pair` printed no link. Plain `openclaw dashboard --no-open` only offers the link through a clipboard, which the container lacks. `pair` now reads `browserUrl` from `--json` and prints it to the interactive terminal only. The automated browser check had used `--json` directly, so it did not cover this step.

Accepted, documented:
- `sf005-dispatch.sh verify` accepts either profile; `sf005-dashboard.sh verify` requires `dashboard`.
- The two profile keys are also named in `enable`/`disable`; `check_config` then confirms the result against the overlay.

## Security trade-offs that remain

1. **The Gateway token alone is enough on this host.** Through the forwarder every connection is a loopback peer, so OpenClaw's loopback pairing auto-approval applies after token authentication. A token-only client without a device identity gets `operator.read`. Device pairing therefore binds each browser to a revocable device credential but is **not a second factor** here. The token is 256 bits and lives only in the volume.
2. **A paired Dashboard is an administrator surface.** The `openclaw dashboard` handoff gives the browser admin scope. In Settings it can change configuration: add a model provider, enable plugins, terminal or exec.
   - Both `verify` steps fail on any drift from the profile.
   - The container still has no network, no host mounts and no Docker socket.
   - Paired browsers should be treated like the token and removed with `devices remove` when not needed.
3. **Shared loopback.** While the forwarder runs, any local user of this computer can connect to `127.0.0.1:18789` and still needs the token or a paired credential. This is the same shared-loopback finding as SF-004.
4. **Docker access.** The forwarder, like the bridge, uses Docker. Membership in the `docker` group is root-equivalent. No new privilege was added.
5. **Accepted audit warn.** `gateway.trusted_proxies_missing` appears because the UI is enabled. It does not apply: the forwarder is a byte relay without forwarded headers, and no reverse proxy is configured.
6. **Unchanged from SF-004:**
   - the container runs as uid 1000 (= `teo`) without userns-remap, so isolation is **not guaranteed against a container escape**;
   - plain HTTP is used on loopback only.

## Current state (2026-10-26)

- **Container:** `software-factory-openclaw-gateway-1` healthy, Dashboard profile active, `network_mode: none`. It was not restarted by this task; config changes were applied live.
- **Forwarder:** running in the background of this session for verification (`logs/forwarder-run-2.log`). It stops with the session, or press Ctrl+C. The operator starts it with `scripts/openclaw/sf005-dashboard.sh forward`.
- **Bridge and tunnel:** bridge on `127.0.0.1:8787` (PID 684811) and tunnel-client (PID 337046), unchanged.
- **Dispatch:** 7 accepted requests; receiver and automation unchanged.
- **Paired devices:** none; the test device was removed.
- **Not configured:** automatic start, model, Samba, SSH, firewall, Docker daemon or home-permission changes.
- **Git:** index unchanged, `git-index-check.txt`. No staging, commit or push; Git is handled manually by the operator.

## Rollback

`scripts/openclaw/sf005-dashboard.sh disable`, after stopping the forwarder:
- **Reverts** `gateway.controlUi.enabled` and removes `gateway.controlUi.automaticallyFetchFavicons`; the file is byte-identical to SF-004.
- **Removes** the host listener once the forwarder is stopped.
- **Keeps** the volume and everything in it (token, receiver, automations, accepted requests, run history, config backups, paired-device records), the image, the Compose file and the container.

Details and the backup-restore path are in the runbook.
