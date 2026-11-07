# Install

This page takes you from a machine without the factory to a running factory with your first
workspace registered and a passing `sf smoke`.

## Prerequisites

The factory is developed and run on Linux (`sf dashboard --open` uses `xdg-open`; the sandbox
lock check and the process checks read `/proc`). Other systems are not tested.

| What | Version | Needed for | How to check |
| --- | --- | --- | --- |
| **Node.js** | 24 or later (`engines` in both `package.json` files) | everything | `node --version` |
| **npm** | the one that comes with Node.js | install and build | `npm --version` |
| **Git** | a current Git with `git worktree` and `git switch` (2.23 or later) | every job: worktrees, the commit, the rebase, the push | `git --version` |
| **Git identity** | `user.name` and `user.email` set | the one commit at Clean (else `mr_commit_failed`) | `git config user.email` |
| **Git push access** | an SSH key or credential helper that can push to your repository's `origin` | Approve and the merge request actions; the factory runs `git push origin <branch>` with your own Git setup | `git push --dry-run` in your checkout |
| **Claude Code and its login** | the Agent SDK pinned in `factory/package.json` (`@anthropic-ai/claude-agent-sdk`) brings its own Claude Code binary; install the `claude` CLI to log in | the Implementer, the Claude review, the Task check | `claude` starts and is logged in (`/login` once) |
| **An `implement` skill in Claude Code** | | the Implementer's first prompt is `/implement .software-factory/<ticket>.md` (below) | `ls ~/.claude/skills/implement/SKILL.md` |
| **The sandbox's tools** | bubblewrap and socat (what Claude Code's sandbox needs on Linux) | every agent session (else `sandbox_unavailable`) | `bwrap --version`, `socat -V` |
| **Codex CLI and its login** | a current Codex CLI (`codex exec` with `--output-schema`) signed in with your ChatGPT account (`codex login`); no API key | the Codex gate; without it the gate is off and the Claude review decides | `codex --version`, `codex login status` |
| **GitHub or GitLab token** | optional | the factory opening and merging merge requests (`sf mr …`); not needed to push | [Configuration](configuration.md#push-and-merge-request-providers) |
| **tunnel-client** | v0.0.18 (OpenAI's Secure MCP Tunnel) | planning with ChatGPT only | `tunnel-client --version`; see the [connection runbook](../runbooks/chatgpt-connection.md) |
| **notify-send**, **xdg-open** | optional (`libnotify`, `xdg-utils`) | desktop notifications; opening the dashboard | `command -v notify-send xdg-open` |
| **Playwright's Chromium** | the Playwright pinned in `factory/package.json` | only the dashboard's browser tests (`npm run browsers` once) | |

### The `implement` skill

The factory does not ship the skill it calls: it starts every job with
`/implement .software-factory/<ticket>.md` and every fix round with
`/implement .software-factory/<ticket>.md Fix N`, and the Implementer's session loads your own
Claude Code settings (`~/.claude`) and the repository's. So Claude Code needs a skill or command
named `implement`, either your personal one (`~/.claude/skills/implement/SKILL.md`) or one in the
repository (`.claude/skills/implement/SKILL.md`). A minimal one:

```markdown
---
name: implement
description: Implement the work described in the given Task file.
---

Implement the work described in the Task file given as the argument (and, when a "Fix N" is
named, the items of that Fix section). Follow the repository's coding rules. Run the type checker
and the tests of the files you change while you work, and the full test suite once at the end.
```

The factory adds its own rules to every prompt (no Git commands, no edits to the Task file, the
Report template), so the skill can stay short. A last line such as "commit your work" is denied on
purpose: the factory makes the commit.

## Get the repository

```sh
git clone <repository URL> ~/work/software-factory
cd ~/work/software-factory
```

The repository has the factory's code in `factory/` (TypeScript, built into `factory/dist/`) and a
root `package.json` with the everyday commands.

## Two ways to run it

Both run `factory/bin/sf`, which runs the compiled `factory/dist/src/cli.js` of the clone it is in
(it resolves its own path, also through a symbolic link). All clones share the same state and
config directories, so run `sf serve` from one clone at a time.

### (a) From the clone you develop in

The simplest: one clone, used to change the factory and to run it.

```sh
cd ~/work/software-factory
npm run setup        # npm ci and npm run build in factory/; again after every pull or change
npm start            # sf up: sf serve, the ChatGPT tunnel (when set up) and the dashboard in the browser
```

`npm start` keeps running in the foreground; Ctrl+C stops `sf serve` and the tunnel (running jobs
keep running: each has its own runner process). The pieces separately:

```sh
npm run serve        # sf serve alone
npm run tunnel       # the ChatGPT tunnel alone (second terminal)
npm run dashboard    # open the dashboard again
npm run info         # version, directories, settings, sf serve and tunnel state, workspaces, jobs
npm run status       # the jobs
npm run sf -- <command…>   # any other sf command, e.g. npm run sf -- workspace list
```

The drawback: `npm run build` replaces `factory/dist/` under jobs that are running. A job's runner
keeps the code it loaded, but the next runner a job starts (after it waited for you) loads the new
build, and a build that fails half way leaves nothing to run.

### (b) A second clone used only to run the factory

How this repository develops itself ([coordinator runbook](../runbooks/coordinator.md)): one
clone to change the code, a second one, for example `~/.local/lib/software-factory`, only to run
it. Changes in the development clone never affect running jobs; you update the second clone
between tickets.

```sh
git clone <repository URL> ~/.local/lib/software-factory
cd ~/.local/lib/software-factory/factory
npm install && npm run build
cd ..
npm run serve        # or npm start for sf up with the tunnel and the browser
```

Put that clone's `sf` on your `PATH`, so `sf` in any terminal is the installed one:

```sh
mkdir -p ~/.local/bin
ln -sfn ~/.local/lib/software-factory/factory/bin/sf ~/.local/bin/sf
sf --help
```

To update it: `git pull`, `npm install` and `npm run build` in `factory/` (check that the build
passed), then restart `sf serve` from its root with `npm run serve`. See
[Operations: updating](operations.md#updating-the-factory) for what to watch.

In the rest of this guide, `sf` is whichever clone's `factory/bin/sf` you run (`npm run sf --` from
the root, `factory/bin/sf`, or `sf` on your `PATH`).

## Where the factory keeps things

| Location | Contents |
| --- | --- |
| `~/.config/software-factory/` (`SF_CONFIG_DIR`) | `workspaces.json` (the workspaces), `auth.env` (the settings), `rules/` (your coding rules), `tunnel-runtime.key` (the tunnel's key) |
| `~/.local/state/software-factory/` (`SF_STATE_DIR`) | `jobs/<workspace>/<ticket>/` (each job: `job.json`, `events.jsonl`, `iterations/`, `ledger.json`, `mr.md`, `runner.log`), archived jobs as `<ticket>.<stamp>/`, `queue.json`, `checks/` (Task checks), `tickets/` (ticket history), `requests/` (your New ticket words), `locks/`, `tmp/`, `sf.sock` (while `sf serve` runs), `dashboard-token` |
| `~/.local/state/software-factory/worktrees/<workspace>/<ticket>/` (`SF_WORKTREE_ROOT`) | each job's worktree, while the job needs it |
| `.software-factory/` in each workspace's checkout | the Task files `<ticket>.md`, their images `<ticket>/`, the MR texts, `archive/`; excluded from Git through `.git/info/exclude` |

The logs: `sf serve` writes to its terminal (stdout and stderr); each job's runner writes to
`runner.log` in the job's directory, and everything the job did is in its `events.jsonl` (read it
with `sf watch` or the job's Stream).

## The first start

1. **Settings (optional).** Create `~/.config/software-factory/auth.env` with the settings you want
   ([Configuration](configuration.md#the-environment-file-authenv)); without it every default
   applies.

2. **Start it.**

   ```sh
   npm start
   ```

   It prints, among others:

   ```
   software-factory dashboard http://127.0.0.1:8788/d/<token>/
   software-factory listening on http://127.0.0.1:8787/mcp/<token>
   software-factory socket /home/you/.local/state/software-factory/sf.sock
   ```

   and `tunnel | not started: …` (with the runbook's path) until the ChatGPT tunnel is set up;
   the dashboard works without it. With no Codex found it also prints
   `gate: off (…); the Claude review decides`.

3. **The dashboard URL.** `/d/<token>/`: the token is a random secret written to
   `~/.local/state/software-factory/dashboard-token` at the first start and kept across restarts,
   so a bookmark keeps working. `sf dashboard` prints the URL again (it works without `sf serve`),
   `sf dashboard --open` opens it, `sf info` shows it. Treat the URL as a password: anyone on your
   machine with it can start and push your jobs. `sf dashboard --rotate` makes the next `sf serve`
   create a new token. Both listeners are on `127.0.0.1` only.

   The MCP URL on the `listening on` line shows `<token>`: the planning endpoint needs a token of
   its own (`~/.local/state/software-factory/mcp-token`, made at the first start). `sf mcp-url`
   prints the full URL for an MCP client such as Claude Code ([Planning](planning.md)); the ChatGPT
   tunnel's script puts it into the tunnel's profile by itself.

4. **Register your repository** as a workspace: on the dashboard, **Workspaces** → a name
   (`my-app`) and the absolute path of your checkout (`/home/you/work/my-app`) → *Add workspace*;
   or in a terminal:

   ```sh
   sf workspace add my-app --read ~/work/my-app
   ```

   The path must be the root of a Git work tree (not a bare repository). It should have an
   `origin` the factory can fetch from and push to.

5. **Look at what the factory sees**:

   ```sh
   sf info
   sf rules my-app
   ```

   `sf info` shows the version, the directories, the env file, the model, the gate (`codex
   <version>` or `off (<reason>)`), the gate level, the notification channels, whether each Git
   host token is set, whether `sf serve` and the tunnel run, the workspaces and the jobs.
   `sf rules` lists the coding rules the agents will get.

6. **Plan and run your first ticket**: [Planning](planning.md), then [Running jobs](running-jobs.md).

## Check that it works

1. `sf info`: every row as you expect, `serve` running, `gate: codex …` (or `off` with the reason
   you expect).
2. `sf notify-test`: one test notification on every channel, and what each did.
3. `npm test` in the repository root: the factory's test suite with fakes (no model, no network);
   it should pass.
4. **`sf smoke`**: the live smoke test. Run it after the install and after every update:

   ```sh
   sf smoke
   ```

   It runs one tiny real job against the real Claude Code, the real Codex CLI and real Git: in a new
   temporary directory it creates a bare repository as `origin`, a clone with one file and the Task
   file `SMOKE-1` ("Add a second greeting line"), and runs its own `sf serve` on free ports with
   its own state. It never touches your state, config, workspaces, checkouts or remotes, and it
   needs no `sf serve` of yours. Your settings are not passed on, except `SF_CLAUDE`, `SF_CODEX`,
   `SF_GATE`, `SF_SANDBOX`, `SF_SANDBOX_DOMAINS` and `SF_GATE_TIMEOUT_MS`.

   - **Steps**: Setup, Task check, Start, Implementer turn, Sandbox, Claude review, Codex gate, MR text,
     Approve (the push to the throwaway `origin`), Dashboard (the page and six API answers),
     Cleanup. One line per step as it ends, then a table, then the last line.
   - **PASS** means every one of the eleven steps passed, each decided from what the factory wrote:
     the Task check ran (ready or not), the job started, iteration 1 was published, the
     Implementer's sandbox refused every probe of the run's secrets and control paths
     ([the trust model](trust-model.md)), the Claude
     review and the Codex gate each gave a verdict, the MR text passes the MR rules, the branch is
     on `origin` at the prepared commit, and the dashboard answered with its token. The last line
     is `smoke: PASS, cost <USD>, gate <N> tokens`; exit code 0. With `SF_SANDBOX=off` the Sandbox
     step is skipped and the last line says `smoke: PASS (sandbox not checked), …`.
   - **FAIL** names the step and the reason (`smoke: FAIL (<n> of 11 steps), …`, exit 1); the later
     steps are skipped, Cleanup always runs. A missing Codex fails the gate step but the run goes
     on.
   - **What it costs**: the Claude model is `SF_SMOKE_MODEL` (default `haiku`), with small limits;
     usually a small fraction of the default budget of 2 USD (an estimate of the API-equivalent
     price: on a Claude plan it uses your plan's quota) and a few minutes; the gate's tokens come
     from your Codex plan. `--budget-usd N` (default 2) and `--timeout-min N` (default 20) stop it
     when exceeded; `--keep` keeps the temporary directory to look at.

The details: [Live smoke test](../../factory/README.md#live-smoke-test).

Next: [Configuration](configuration.md).
