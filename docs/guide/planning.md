# Planning a ticket

This page shows the four ways to write a Task file, what makes a good one, and the Task check that
reads it before anything is built.

Whatever way you choose, the result is the same file: `.software-factory/APP-12.md` in the
workspace's checkout (`~/work/my-app/.software-factory/APP-12.md`), ignored by Git. The factory
starts a job only from that file.

## The planning tools (MCP)

`sf serve` serves the planning tools on `http://127.0.0.1:8787/mcp/<token>` (the port is
`SF_PORT`; loopback only; Host and Origin are checked). Every request needs the factory's MCP
token, in the path or as `Authorization: Bearer <token>` on `/mcp`; without it the answer is
`401`. `sf mcp-url` prints the URL with the token (`sf mcp-url --header` the bearer form); every
other output shows `<token>`. The first `sf serve` makes the token (`mcp-token` in the state
directory, mode 0600); `sf mcp-url --rotate` makes a new one, which a running `sf serve` takes at
once ([Configuration](configuration.md#the-mcp-token-mcp-token)). Any MCP client with the URL can
use the tools; the server sends the Handbook's Quick start as its instructions.

| Tool | What it does |
| --- | --- |
| `guide` | Returns the whole [Handbook](../../factory/HANDBOOK.md): the cycle, the tools, the Task file format, the templates, the rules. |
| `read_file(workspace, path, …)` | Reads a file of the workspace's checkout (paged; credential-like paths refused). |
| `search(workspace, query, mode, …)` | Finds files by path (`mode: "path"`) or lines by content (`mode: "content"`). |
| `write_task(workspace, ticket, content)` | Creates or replaces the Task file. Refused while a job of the ticket runs (a paused one aside). Schedules the automatic Task check. |
| `task_check(workspace, ticket)` | Reads the last Task check of the current Task file. |
| `read_attachment(workspace, ticket, name)` | Returns one image of the ticket. |
| `queue_list()` | Reads the run queue. |
| `queue_add(workspace, ticket, at?)` | Adds a written ticket to the queue. |

None of them starts, reviews, approves or pushes a job: those stay yours.

## 1. With ChatGPT, through the tunnel

ChatGPT runs in the browser, so it reaches your local factory through OpenAI's Secure MCP Tunnel:
a `tunnel-client` on your machine connects out to OpenAI and forwards ChatGPT's tool calls to
`127.0.0.1:8787`. There is no inbound port. ChatGPT's connector holds no secret: the tunnel
client's profile holds the MCP token in its MCP `url`, which `scripts/sf-tunnel.sh` sets on every
`run` (and `init`) through `sf mcp-url --write-profile`; the script itself never reads the token,
and the tunnel client's output passes through a filter that shows it as `<token>`.

Once, set it up as the [connection runbook](../runbooks/chatgpt-connection.md) describes:

1. Install `tunnel-client` v0.0.18.
2. In the OpenAI Platform: the Tunnels permission, a tunnel, its `tunnel_id`, and a runtime key.
3. Start `sf serve` (or `npm start`) once, so the MCP token exists. In the repository root:
   `scripts/sf-tunnel.sh init tunnel_<your id>` and
   `scripts/sf-tunnel.sh set-key` (a hidden prompt; the key goes to
   `~/.config/software-factory/tunnel-runtime.key`, mode 0600).
4. `scripts/sf-tunnel.sh check`: exit 0 means the client, the profile, the key file and the
   factory are fine.
5. In ChatGPT: a custom MCP connector "Software Factory", connection **Tunnel**, authentication
   **No authentication** (the token is in the tunnel's profile, not in ChatGPT); check that it
   lists the eight tools above.

After `sf mcp-url --rotate`, restart the tunnel (`npm run tunnel` again, or `sf up`): its `run`
writes the new token into the profile.

Then, for every ticket:

1. Start the factory with `npm start` (`sf up`): it runs the tunnel too. Its lines start with
   `tunnel | `.
2. On the dashboard press **New ticket**: the workspace (`my-app`), the ticket key (`APP-12`), a
   one-line title, and what you want in your own words; paste screenshots into the form if they
   help (Ctrl+V, or drop the files). The Context owner is "ChatGPT, in the browser". Press
   *Create the ticket*.
3. The factory writes a **skeleton**: `.software-factory/APP-12.md` with the front matter
   (`ticket`, `title`, `base`: the branch `origin/HEAD` points at, else `main`), a heading and
   `## Status: waiting for the Context owner`. Your words are kept apart (in the state directory)
   for the conversation, not written into the file. Its card appears in the Queue column marked
   `draft`.
4. Click the card: the planned ticket's page. Press **Open the ChatGPT conversation ↗**: a new tab
   opens ChatGPT with the first message filled in (the connector, `guide`, the ticket, the
   workspace, your words, the names of the images, and what to do). Press Enter if it is not sent
   by itself. (A message too long for a link is offered to copy.)
5. Discuss the ticket with ChatGPT. It reads the repository (`read_file`, `search`), the images
   (`read_attachment`), proposes a plan, and writes the Task file over the skeleton with
   `write_task`. 60 seconds after its last write the factory runs the Task check by itself;
   ChatGPT reads it with `task_check`, fixes the blockers and majors, and writes again (at most two
   automatic rounds, then it hands the open findings to you).
6. When ChatGPT says the Task file is ready, read it on the ticket's page (*Preview*, or *Edit* to
   change it; *Save* or Ctrl+S) and start it ([Running jobs](running-jobs.md)), or ask ChatGPT to
   add it to the queue.

ChatGPT is not involved after planning: the factory's own reviewers review the job.

## 2. With Claude Code (or another MCP client) on the local server

A local MCP client reaches the factory directly with the URL from `sf mcp-url`; no tunnel is
needed. For Claude Code, register the server once, from the repository root, with `sf serve`
started once before (it makes the token):

```sh
claude mcp add --transport http software-factory "$(factory/bin/sf mcp-url)"
```

or, with the token in a header instead of the path:

```sh
factory/bin/sf mcp-url --header        # prints the URL without the token, then the Authorization line
claude mcp add --transport http software-factory http://127.0.0.1:8787/mcp --header "Authorization: Bearer <the token it printed>"
```

Claude Code keeps the URL (or the header) in its own MCP settings: after `sf mcp-url --rotate`,
remove the server (`claude mcp remove software-factory`) and add it again with the new URL. Those
settings are `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set, and its copies
in `backups/`) for the default (`local`) and the `user` scope, which every session the factory
starts may neither read nor write. Keep the name `software-factory`: every session the factory
starts denies the tools of the server of that name, so a server added in the `user` scope (which
loads into those sessions too) gives a job no way to the planning tools. Do not use
`--scope project`: it writes the URL with the token into `.mcp.json` of the current directory,
where a job working in that repository can read it. Run `sf mcp-url` and `claude mcp add` in your
own terminal, not through an agent's session, whose transcript would keep the URL.

Then, with `sf serve` running, in a Claude Code session (any directory):

1. Ask it to call `guide` first and to plan ticket `APP-12` in workspace `my-app` with you: "Use
   the software-factory MCP server. Call guide, then plan APP-12 in workspace my-app with me: …".
2. It reads the repository with `read_file` and `search` (or with its own tools, if the session
   runs in your checkout), discusses the plan, and writes the Task file with `write_task`.
3. It waits for the automatic Task check with `task_check`, fixes what it finds, and tells you the
   Task file is ready.
4. You start the job, or let it `queue_add` the ticket.

You can also create the ticket on the dashboard first (New ticket), so its card and page exist, and
then ask Claude Code to write the Task file over the skeleton. The New ticket form lists Claude Code
as a Context owner but keeps it disabled: its *Open the conversation* link is ChatGPT's only.

A Claude Code session that runs in the workspace's checkout may also simply write
`.software-factory/APP-12.md` itself with its file tools: that is the same as writing it by hand
(below). This is how a coordinating session works ([Ways of working](ways-of-working.md#3-with-a-coordinating-claude-code-session)).

## 3. New ticket on the dashboard, then plan on its page

New ticket (above, step 2 and 3) always writes the skeleton first. From the planned ticket's page
you can then:

- **paste images**: Ctrl+V anywhere on the page, or drop files on the Images card ("Paste an image
  here (Ctrl+V) or drop one."): PNG, JPEG, WebP or GIF, at most 5 MB each and 10 per ticket, named
  `1.png`, `2.png`, … They live in `.software-factory/APP-12/`. `sf attach my-app APP-12 shot.png`
  does the same from a terminal (`--remove 1.png` removes one);
- **write the Task file yourself**: *Edit*, replace the skeleton with the whole Task file (front
  matter included), *Save* (Ctrl+S). A save that would overwrite a newer version (ChatGPT wrote
  meanwhile) is refused with `task_changed` and your text is kept; *Reload* loads the file;
- **check the plan**: *Check the plan* (the Task check, below);
- **start it**: *Start now*.

Refer to an image the Task needs with plain Markdown, the path relative to the Task file:
`![the export dialog after the error](APP-12/1.png)`. Only the images the Task file refers to go to
the job; every agent of the job (Implementer, reviewers, Task check) sees them.

## 4. Writing the Task file by hand

The Task file is a plain Markdown file; write it with any editor, in the checkout:

```sh
mkdir -p ~/work/my-app/.software-factory
$EDITOR ~/work/my-app/.software-factory/APP-12.md
```

The factory adds `.software-factory/` to the checkout's `.git/info/exclude` when it first writes
there (on `write_task` or New ticket); when you create the folder yourself, add the line
`.software-factory/` to `.git/info/exclude` (or your `.gitignore`) so the Task files never show up
as changes. A file written outside the factory is checked by the automatic Task check too (`sf
serve` watches the folder) and shows on the board at the next refresh.

A complete example:

```markdown
---
ticket: APP-12
title: Export the report as CSV
base: main
scope: [src/export/**, src/report/ReportPage.tsx, test/export.test.ts, README.md]
lands_after: [APP-11]
---

# APP-12: Export the report as CSV

Add an "Export CSV" button to the report page that downloads the visible rows as CSV.

- Columns in the order of the table; header row with the column titles.
- Dates as ISO 8601 (`YYYY-MM-DD`), numbers without thousands separators.
- Use the existing `downloadFile` helper in `src/export/download.ts`; no new dependency.
- Out of scope: Excel export, server-side export.

Acceptance: the button downloads `report-<date>.csv`; `npm test` passes with the new tests.

## Files

- Create `src/export/csv.ts`: the row-to-CSV conversion (quoting per RFC 4180).
- Modify `src/report/ReportPage.tsx`: the button.
- Create `test/export.test.ts`: quoting, dates, empty table.
- Modify `README.md`: one line under Features.

## Review brief

Check the quoting of commas, quotes and newlines in cells against RFC 4180, and that the dates use
the report's time zone, not the browser's. We reuse `downloadFile` because it already handles the
Safari case; a new dependency would need a security review.
```

## What makes a good Task file

The Task file is everything the Implementer and the reviewers know about the ticket. Nobody can
ask you a question between Start and your own review, so leave no decision open.

- **The front matter** (all keys: [Configuration](configuration.md#the-task-files-front-matter)):
  `ticket`, `title` and `base` are required; `scope`, `may_touch`, `lands_after` and `check` are
  optional but worth it.
- **The task**: what to build, where, the decisions made in planning and why, the acceptance
  criteria, and what is out of scope. Reference the repository's standards by path instead of
  copying them; the coding rules reach the agents by themselves.
- **`## Files`**: each file the ticket creates, modifies or deletes, tests and docs included.
- **`scope:`**: the same files (or globs) in the front matter. A change outside it must be justified
  to a reviewer, or it becomes a fix item, so the job does not wander. Without `scope` nothing is
  checked.
- **`may_touch:`**: the sensitive files the ticket may change on purpose (`package.json`, a
  lockfile, CI configuration). Without it, a change to one must be accepted by a reviewer.
- **`## Review brief`**: what the reviewers must check and why the plan's decisions were made.
  You are not there when they review; the brief is your voice. The Implementer reads it too, so
  write checks and reasons, not instructions.
- **`lands_after:`**: the tickets this one needs merged first (`APP-11`, or `my-api/API-7` in
  another workspace). The queue waits for them; when the ticket needs their code, set `base` to
  their branch or wait for the merge.
- **Size**: about one merge request; roughly 20 to 30 files is a soft limit. Split bigger work into
  several Task files with `lands_after` between them.
- **Lean**: about 800 words for a change under 300 lines, 1,200 words up to 1,000 lines; split
  anything larger. A lean Task holds the goal and agreed basis, the decisions, the behaviour as
  outcomes, what is out of scope, the tests as cases, the acceptance, `scope:` and a Review brief.
  No pseudo-code: name the files and the interfaces the plan decides on, never the statements.
  Product tickets carry `check: required`.
- **Never write a `## Fix N` section**: those are the factory's.

## A follow-up to an open merge request

When a merge request is already open (review comments to address, a small extension) and the
follow-up belongs in it, not in a second merge request on top, set `base:` to the merge request's
target and `continues:` to its branch:

```markdown
---
ticket: APP-13
title: Address the review of the CSV export
base: main
continues: APP-12-export-the-report-as-csv
---
```

The job starts from `origin/APP-12-export-the-report-as-csv` on a branch of its own (your checkout
can keep that branch checked out). At Clean its commit is rebased onto the branch as origin has it
then, and Approve pushes it onto that branch, a fast-forward, never forced; the job's own branch is
not pushed. The same merge request shows the change, its title and description unchanged; `sf mr
create` reuses it. If someone pushed to the branch after the preparation, the push is refused
(`mr_push_failed`) and `sf retry` prepares the commit again on the new tip. `continues` must differ
from `base` and must not be `main` or `master`.

## The Task check

The Task check (`sf check-task`; on the dashboard *Check*, *Check the plan* and the **Plan check**
card) reads the Task file before Start with a fresh, read-only Claude session that sees only the
Task file, its images and the repository at the Task's `base`, in a temporary checkout of its own:
never your conversation, the jobs or other Task files. It only advises: Start always works.

**What it checks.** It first paraphrases the Task in its own words (read it: a wrong paraphrase is a
finding of its own), then lists findings, each with a kind and a severity:

| Kind | Meaning |
| --- | --- |
| `decision` | a choice the Implementer would have to make |
| `contradiction` | a claim about the code that the code contradicts, with its `path:line` (always a blocker) |
| `missing` | a file, test or acceptance criterion the goal needs and the Task does not name |
| `overreach` | a part the goal does not need |
| `unclear` | a passage that can be read two ways |

and the files it expects to change. With a `scope`, an expected file outside it is a `missing`
major finding, and a scope entry no expected file matches is an `overreach` nit.

**Verdicts.**

| Verdict | Meaning |
| --- | --- |
| `ready` | no blocker or major finding |
| `not_ready` | at least one blocker or major finding ("not ready: N blocker, M major") |
| `failed` | the check could not run or gave no valid answer; never counts as ready |
| `none` (MCP) / "not checked" | the current version of the Task file has no check |
| "check not needed" | the current version has no check, and the Task needs none (below) |

A check belongs to one version of the Task file (and its images): once the file changes, the old
check is **stale** ("· stale" on the card).

**Where it pays.** A small, well-scoped Task starts without a check. A Task needs one when its
front matter says `check: required` (any value but `skip` counts as required), when it has no
`scope`, more than 10 scope entries, a glob in `scope`, a `lands_after` ticket of another
workspace, or more than 1,200 words (the whole file, front matter included); `check: skip` never
needs one. Any other Task is not needed: `write_task` answers `not_needed` with the reason, the
card says "check not needed" (the reason on hover), the page "Plan check not needed: <reason>",
and the queue starts it without a check. Write lean Task files (above) and most tickets start this
way; product tickets carry `check: required`. Check by hand still runs, and its verdict counts.
The Plan check card shows the ticket's rounds and their cost ("N rounds · $X"), and Stats shows
them per job (the Plan column) and the rounds per ticket of the plan check.

**When it runs.** `sf serve` runs it by itself 60 seconds after the last change of a Task file
(written by `write_task`, saved on the page, or changed on disk), and when a ticket without a check
is added to the queue, unless `SF_TASK_CHECK_AUTO=off`. It does not run for a skeleton, for a Task
that needs no check (above), for a version that has a check already, or while a job of the
ticket runs. Two exceptions, for a ticket in the queue (not forced): a failed check is tried again
by itself every 15 minutes, up to 3 times, and notified only after the last; a `not_ready` check is
checked again when a commit on the base changes a path in its `scope` or `may_touch` (any path
without either), and that re-check, if still not ready, is not notified again. Outside the queue,
press Check to run a failed one again. `SF_TASK_CHECK_PARALLEL` (default 1) checks run at once. You can always run it:

```sh
sf check-task my-app APP-12   # prints the paraphrase, the findings by severity, the files, the verdict
```

or press *Check* in the card's ⋯ menu or *Check the plan* on the page. A check that ends
`not_ready` or `failed` by itself is notified ("APP-12: plan not ready"). It uses
`SF_REVIEW_MODEL` and at most `SF_TASK_CHECK_MAX_TURNS` steps; the page says "About $0.50".
`sf check-task` exits 0 when the check ran (ready or not) and 1 when it failed.

**How it gates the queue.** The queue starts a queued ticket only when the Task check of its
current Task file is `ready`, or when the Task needs no check and its current version has none (a
check you ran by hand counts, a `not_ready` one holds it). Otherwise the card says why ("plan not ready: 1 blocker, 2 major",
"plan check failed", "plan being checked", "plan not checked") and the queue tries the next entry.
To start it anyway:

```sh
sf queue force my-app APP-12
```

or *Start anyway* on the card: the entry starts whatever its check says, for any later version of
the Task file too, until it leaves the queue. Start by hand (the card's *Start*, *Start now*,
`sf start`) is never held by the check; its confirmation only says "Task check: not ready …".

The details: [Task check](../../factory/README.md#task-check) and
[Ticket images](../../factory/README.md#ticket-images).

Next: [Running jobs](running-jobs.md).
