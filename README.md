# Software Factory

A local process that lets a model you plan with (ChatGPT first) drive Claude Code through a
ticket without you having to notice when Claude has finished. The Context owner writes a Task
file, reviews each iteration through MCP tools and asks for fixes; the Implementer runs as a
headless Claude Code session in the work checkout; you start the job from the dashboard, read
the branch in the IDE and approve in the terminal or on the dashboard. How it works: [design](docs/design/SF-011-factory.md). How to use it as the Context
owner: [factory/HANDBOOK.md](factory/HANDBOOK.md).

## Components

| Component | Entry point | Documentation |
| --- | --- | --- |
| MCP server (loopback, port 8787) | `factory/src/server.ts` | [factory/README.md](factory/README.md) |
| `sf` command | `factory/src/cli.ts`, `factory/bin/sf` | [factory/README.md](factory/README.md) |
| Dashboard (port 8788: the start screen, the live view, start, approve, abort and say) | `factory/src/dashboard.ts`, `factory/src/setup.ts` | [factory/README.md](factory/README.md#dashboard) |
| ChatGPT tunnel wrapper | `scripts/sf-tunnel.sh` | [chatgpt-connection](docs/runbooks/chatgpt-connection.md) |

## Getting started

Requires Node.js 24 or later. The root `package.json` holds the everyday commands; the code and
its own `package.json` are in `factory/`.

```bash
npm run setup                    # once, and after every update: install and build factory/
npm start                        # sf up: serve (MCP on 127.0.0.1:8787/mcp and the dashboard), the ChatGPT tunnel, the dashboard in the browser; Ctrl+C stops all
```

Then, in the dashboard (`http://127.0.0.1:8788/d/<token>/`, opened for you; `npm run dashboard`
opens it again):

1. **Workspaces**: add the local checkout of the repository to work in (a name and its path).
2. **New ticket**: the workspace, the ticket key, a title and what to implement, in your words.
   The page writes a ticket draft, `.software-factory/<ticket>.md` in that checkout.
3. **Tickets**: *Open the conversation* opens ChatGPT in a new tab with the message that makes
   it read the draft, plan with you, rewrite the Task file and subscribe to the ticket's events
   (press Enter if the message is not sent by itself). When ChatGPT has planned the ticket and
   you have said "start" to it, the ticket's line reads `Reviewer: subscribed`; press
   **Start…**.
4. The job appears under Jobs: the Implementer works, ChatGPT reviews each iteration, and when it
   declares Clean you read the branch in the IDE and approve (push) or abort, here or in the
   terminal.

The pieces separately, when wanted:

```bash
npm run serve                    # sf serve alone (foreground)
npm run tunnel                   # the ChatGPT tunnel alone (second terminal)
npm run dashboard                # open the dashboard in the browser
npm run info                     # version, settings, whether serve and the tunnel run, workspaces, jobs, subscriptions
npm run status                   # the jobs
npm run ticket -- <workspace> <ticket>   # the ChatGPT conversation of one ticket, from the terminal
npm run events                   # the MCP event subscriptions
npm run sf -- <command...>       # any other sf command, e.g. npm run sf -- workspace add app --read /path
npm test                         # the factory's test suite; npm run typecheck, npm run build
```

Settings such as `SF_AUTH_*`, `SF_MODEL` and `SF_NOTIFY_ITERATIONS` live in
`~/.config/software-factory/auth.env`, which every `sf` command reads (`SF_ENV_FILE` to change
it). The tunnel needs its profile and key once (`scripts/sf-tunnel.sh init`, `set-key`) and the
"Software Factory" connector in ChatGPT; both are described in the
[connection runbook](docs/runbooks/chatgpt-connection.md). Without them `npm start` says so in
one line and runs without the tunnel.

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
