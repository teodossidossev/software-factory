# Software Factory

A local mediator between ChatGPT, OpenClaw and Claude Code. ChatGPT owns context and reviews
independently, OpenClaw is transport, Claude Code implements, and the user accepts results.

Start with [docs/README.md](docs/README.md) for tasks, designs, runbooks, reports and known gaps.

## Components

| Component | Entry point | Runbook |
| --- | --- | --- |
| MCP bridge (loopback only) | `bridge/src/main.ts`, tools in `bridge/src/server.ts` | [bridge/README.md](bridge/README.md) |
| ChatGPT tunnel wrapper | `scripts/sf-tunnel.sh` | [chatgpt-connection](docs/runbooks/chatgpt-connection.md) |
| OpenClaw gateway and dashboard | `deploy/openclaw/compose.yaml`, `scripts/openclaw/` | [openclaw-docker](docs/runbooks/openclaw-docker.md), [openclaw-dashboard](docs/runbooks/openclaw-dashboard.md) |
| Instruction dispatch | `scripts/openclaw/sf005-dispatch.sh`, `deploy/openclaw/sf-dispatch-receiver.mjs` | [openclaw-dispatch](docs/runbooks/openclaw-dispatch.md) |
| Host execution adapter | `scripts/sf006-execute.sh`, `bridge/src/execution/` | [claude-execution](docs/runbooks/claude-execution.md) |
| Operator console | `scripts/sf007-operator.sh`, `bridge/src/operator/` | [SF-007](docs/runbooks/SF-007-local-operator.md) |
| Execution supervisor | `scripts/sf009-executor.sh`, `bridge/src/executor/` | [SF-009](docs/runbooks/SF-009-autonomous-session-loop.md) |
| Review coordinator (offline, not active) | `scripts/sf010-reviewer.sh`, `bridge/src/reviewer/` | [SF-010 reviewer](docs/runbooks/SF-010-reviewer-foundation.md) |
| Events discovery probe (stopped, passed once) | `scripts/sf010-event-probe-live.sh`, `bridge/src/event-probe/` | [SF-010 probe](docs/runbooks/SF-010-event-probe.md) |

## Bridge development

Requires Node.js 24 or later. Run from `bridge/`:

```bash
npm ci
npm run typecheck
```

`bridge/dist` is the compiled runtime of the running services. Do not rebuild it during a job.
See the [SF-009 runbook](docs/runbooks/SF-009-autonomous-session-loop.md).

There is no common setup or start command yet; see [decisions](docs/project/DECISIONS.md).

## Local state outside version control

`factory-data/` (runtime data and private app configuration), `.software-factory/` (adapter
mirrors), `review/` (evidence packages), `bridge/dist/`, `bridge/node_modules/` and `.idea/` stay on
disk and are ignored. Do not delete them as clutter: services, jobs and reviews rely on them.
