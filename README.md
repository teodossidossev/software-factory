# Software Factory

A local tool that takes a planned ticket through Claude Code without you having to watch it. You
plan the ticket into a Task file (with ChatGPT, with Claude Code, on the dashboard or by hand);
the factory runs Claude Code headless in a Git worktree of its own, has every iteration reviewed by
a fresh Claude session and the Codex CLI, turns their findings into fix rounds by itself, and when
both are clean writes the merge request text and makes one commit. You get the result in your own
checkout, or push it and open the merge request from the dashboard.

It runs on your machine, for one person: `sf serve` serves the planning tools (MCP, port 8787),
the dashboard (port 8788) and the run queue, and each job runs in a process of its own.

## Quick start

Requires Linux, Node.js 24 or later, Git, Claude Code logged in (with an `implement` skill), and,
for the deciding review, the Codex CLI logged in with your ChatGPT account. The full list:
[Install](docs/guide/install.md#prerequisites).

1. **Get it and build it**:

   ```sh
   git clone <repository URL> ~/work/software-factory && cd ~/work/software-factory
   npm run setup
   ```

2. **Start it**: `npm start` (`sf up`). It prints the dashboard URL,
   `http://127.0.0.1:8788/d/<token>/`, and opens it; `npm run dashboard` opens it again.
3. **Add your repository**: on the dashboard, **Workspaces** → a name (`my-app`) and the path of
   your checkout; or `npm run sf -- workspace add my-app --read ~/work/my-app`.
4. **Plan a ticket**: **New ticket**, then write the Task file on the ticket's page or plan it with
   ChatGPT through *Open the ChatGPT conversation ↗* ([Planning](docs/guide/planning.md)). Wait for
   the Task check to say `ready`.
5. **Run it**: press **Start**. When the reviews are clean the job's branch is in your checkout
   with its changes uncommitted and the commit message prefilled: review, commit and push from your
   IDE, or press Approve.

Then check the install end to end with `npm run sf -- smoke` ([what it does](docs/guide/install.md#check-that-it-works)).

## Everyday commands

```sh
npm start              # sf up: sf serve, the ChatGPT tunnel (when set up) and the dashboard
npm run serve          # sf serve alone; stopping it leaves running jobs running
npm run tunnel         # the ChatGPT tunnel alone
npm run dashboard      # open the dashboard
npm run info           # version, settings, sf serve and tunnel state, workspaces, jobs
npm run status         # the jobs
npm run sf -- <cmd>    # any sf command, e.g. npm run sf -- queue list
npm test               # the test suite; npm run typecheck, npm run build
```

## Documentation

- [The user guide](docs/guide/README.md): concepts, install, configuration, planning, running
  jobs, review and merge, when a job stops, operations, ways of working. Start here.
- [factory/README.md](factory/README.md): the reference: every command, setting, state and code.
- [factory/HANDBOOK.md](factory/HANDBOOK.md): what the planning model is told: the cycle, the
  tools, the Task file format, the review and Git rules, the templates.
- [CONTEXT.md](CONTEXT.md): the vocabulary.
- [docs/adr/](docs/adr/): the architecture decisions.
- [docs/README.md](docs/README.md): the index of everything under `docs/`.

## Repository layout

| Path | Contents |
| --- | --- |
| `factory/` | The factory: `src/` (TypeScript), `test/`, `static/` (the dashboard), `bin/sf`, `HANDBOOK.md`, `README.md` |
| `scripts/sf-tunnel.sh` | The ChatGPT tunnel wrapper ([connection runbook](docs/runbooks/chatgpt-connection.md)) |
| `config/tunnel-client/` | An example tunnel profile |
| `docs/` | The guide, ADRs, designs, runbooks |
| `package.json` | The everyday commands above; the code's own is `factory/package.json` |
