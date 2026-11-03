# Software Factory

A local process that lets a model you plan with (ChatGPT first) drive Claude Code through a
ticket without you having to notice when Claude has finished. The Context owner writes a Task
file, reviews each iteration through MCP tools and asks for fixes; the Implementer runs as a
headless Claude Code session in a worktree of its own, several tickets at a time; when the
reviewer declares Clean the factory commits and rebases, and you check the branch out in the
IDE, run it, and approve (the push) in the terminal or on the dashboard. How it works: [design](docs/design/SF-011-factory.md). How to use it as the Context
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
2. **New ticket**: the workspace, the ticket key, a title and what you want, in your words.
   The page creates an empty skeleton, `.software-factory/<ticket>.md`; your words are not
   written into it.
3. **Tickets**: *Open the conversation* opens ChatGPT in a new tab with your words as the first
   message (press Enter if it is not sent by itself). There the LLM investigates, discusses the
   ticket with you, writes the Task file and subscribes to the ticket's events. When you agree,
   say "start" (or "давай") in that conversation and the LLM starts the job; there is no Start
   button in the page.
4. The job appears under Jobs: the Implementer works in a worktree, ChatGPT reviews each
   iteration (the Files view lists every changed file, sensitive and deleted ones first), and
   when it declares Clean the factory makes the one commit and the branch is in your checkout:
   `git checkout <branch>` in the IDE, run it, then approve (push) or abort, here or in the
   terminal, or ask ChatGPT for another fix.

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
| `.software-factory/` in each checkout | Task files and MR texts, excluded from Git |
| `~/.local/state/software-factory/worktrees/` | One Git worktree per running job |

## More

- [CONTEXT.md](CONTEXT.md): the vocabulary.
- [factory/HANDBOOK.md](factory/HANDBOOK.md): how the Context owner works with the factory.
- [docs/README.md](docs/README.md): decisions, designs, ADRs, tasks and reports.
