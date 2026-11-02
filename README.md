# Software Factory

A local process that lets a model you plan with (ChatGPT first) drive Claude Code through a
ticket without you having to notice when Claude has finished. The Context owner writes a Task
file, starts the job and reviews each iteration through MCP tools; the Implementer runs as a
headless Claude Code session in the work checkout; you read the branch in the IDE and approve in
the terminal or on the dashboard. How it works: [design](docs/design/SF-011-factory.md). How to use it as the Context
owner: [factory/HANDBOOK.md](factory/HANDBOOK.md).

## Components

| Component | Entry point | Documentation |
| --- | --- | --- |
| MCP server (loopback, port 8787) | `factory/src/server.ts` | [factory/README.md](factory/README.md) |
| `sf` command | `factory/src/cli.ts`, `factory/bin/sf` | [factory/README.md](factory/README.md) |
| Dashboard (port 8788: the live view, approve, abort and say) | `factory/src/dashboard.ts` | [factory/README.md](factory/README.md#dashboard) |
| ChatGPT tunnel wrapper | `scripts/sf-tunnel.sh` | [chatgpt-connection](docs/runbooks/chatgpt-connection.md) |

## Getting started

Requires Node.js 24 or later.

```bash
cd factory
npm install && npm run build
bin/sf workspace add <name> --read <path> [--work <path>]
bin/sf serve                     # MCP on 127.0.0.1:8787/mcp; prints the dashboard URL
```

In a second terminal, run the tunnel: `scripts/sf-tunnel.sh check`, then `scripts/sf-tunnel.sh
run`. In ChatGPT, use the "Software Factory" connector (no authentication). Both are described in
the [connection runbook](docs/runbooks/chatgpt-connection.md). The dashboard is at
`http://127.0.0.1:8788/d/<token>/`; `bin/sf dashboard` prints the full URL. It shows the jobs
live and takes your approve, abort and say, like `bin/sf approve|abort|say`.

## Local state outside version control

| Location | Contents |
| --- | --- |
| `~/.config/software-factory/` | Workspace registry and the tunnel runtime key |
| `~/.local/state/software-factory/` | Job state, Reports, Patches, the socket and the dashboard token |
| `.software-factory/` in each work checkout | Task files and MR texts, excluded from Git |

## More

- [CONTEXT.md](CONTEXT.md): the vocabulary.
- [factory/HANDBOOK.md](factory/HANDBOOK.md): how the Context owner works with the factory.
- [docs/README.md](docs/README.md): decisions, designs, ADRs, tasks and reports.
