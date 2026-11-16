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
use the tools. The server's instructions are the Handbook's Quick start followed by a
`## Planning method` section: two lines on how to plan (look facts up yourself, write the Task file
only after the user confirms), then your installed grilling skill, as `sf serve` copied it at its
start into its skills snapshot (`<state dir>/skills/grilling/SKILL.md`, without its front matter;
an update reaches planning at the next start). `SF_PLAN_SKILL` names another skill
file, and an empty value turns the section off. A missing file leaves the Quick start alone, and
`sf serve` logs one warning at start.

| Tool | What it does |
| --- | --- |
| `guide` | Returns the whole [Handbook](../../factory/HANDBOOK.md): the cycle, the tools, the Task file format, the templates, the rules; it ends with the same Planning method. |
| `read_file(workspace, path, …)` | Reads a file of the workspace's checkout (paged; credential-like paths refused). |
| `search(workspace, query, mode, …)` | Finds files by path (`mode: "path"`) or lines by content (`mode: "content"`). |
| `write_task(workspace, ticket, content)` | Creates or replaces the Task file. Refused while a job of the ticket runs (a paused one aside). Schedules the automatic Task check. |
| `task_check(workspace, ticket)` | Reads the last Task check of the current Task file. |
| `read_attachment(workspace, ticket, name)` | Returns one image of the ticket. |
| `queue_list()` | Reads the run queue. |
| `queue_add(workspace, ticket, at?)` | Adds a written ticket to the queue. |
| `read_job(workspace, ticket, iteration?)` | Reads a job's state, its stop, and one iteration's Report and reviews, with the real paths replaced by `<worktree>` and `<checkout>`. |
| `suggest_changes(workspace, ticket, note)` | While the job waits for you, stores one note to the Implementer for you to send or dismiss on the dashboard. |

None of them starts, reviews, approves or pushes a job: those stay yours. `suggest_changes` only
proposes: the note reaches the Implementer only when you press Send.

## Back to the planner

When a job waits for you (`needs_human`, `ready_for_human_review`, `handed_over`), you can talk its
result over with the planner and send the Implementer the change you agree on.

- **Discuss the result ↗** on the job's page (in the composer) and on its card opens a new ChatGPT
  conversation prefilled with a message that has the planner read the Task file and the job's
  latest Report and reviews (`read_job`), sum them up, discuss what should change with you and
  propose it with `suggest_changes`. When Claude Code plans the ticket (or the link would be too
  long), the page offers the message to copy instead.
- **The planning chat link**: paste the link of the conversation the ticket was planned in into the
  field *Planning chat link* (the ticket's page, Planning conversation; or the job's page) and
  Save. Only a `https://chatgpt.com/` link is kept. Then *Open the planning chat ↗* on the ticket's
  page, the job's card and its page takes you back to it.
- **Planner suggests changes**: the note `suggest_changes` stored shows on the job's page with
  **Send** and **Dismiss**, and on its card clamped, with *Review the suggestion*. Send gives the
  note to the Implementer as your own message (on a handed-over job, as Ask for changes), only the
  note the page showed: if the planner replaced it meanwhile, nothing is sent and the page shows the
  new one. A note stops showing once the job moves to another iteration or stops waiting for you.

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
2. On the dashboard press **New ticket**: the workspace (`my-app`; the form starts on the one you
   last created a ticket in), the ticket key (`APP-12`), a one-line title, and what you want in
   your own words; paste screenshots into the form if they help (Ctrl+V, or drop the files). The
   Context owner is "ChatGPT, in the browser" (for Claude Code, see section 2). The short way:
   press **Create & plan**. It creates the ticket (step 3) and does step 4 for you: a new tab opens
   the ChatGPT conversation with the first message filled in, and the dashboard shows the ticket's
   page. (When the message is too long for a link, or the browser blocks the tab, the dashboard
   says so: open the conversation on the ticket's page, as in step 4.) The long way: press
   *Create the ticket*, then steps 3 and 4.
3. The factory writes a **skeleton**: `.software-factory/APP-12.md` with the front matter
   (`ticket`, `title`, `base`: the branch `origin/HEAD` points at, else `main`), a heading and
   `## Status: waiting for the Context owner`. Your words are kept apart (in the state directory)
   for the conversation, not written into the file. Its card appears in the Queue column marked
   `draft`.
4. Click the card: the planned ticket's page. Press **Open the ChatGPT conversation ↗**: a new tab
   opens ChatGPT with the first message filled in (the connector, `guide`, the ticket, the
   workspace, your words, the names of the images, and what to do). Press Enter if it is not sent
   by itself. (A message too long for a link is offered to copy.)
5. ChatGPT grills you on the ticket, by your installed grilling skill (the server's
   instructions carry it). It looks facts up itself in the repository (`read_file`, `search`) and
   the images (`read_attachment`), and asks you in rounds: numbered questions, each with its
   recommended answer ("yes" accepts it), only the decisions only you can make. When you confirm
   you agree, it writes the Task file over the skeleton with `write_task`. To skip the questions,
   say "just write it": it writes at once and lists the decisions it took without asking under
   "Decisions taken without asking" in the Task file. 60 seconds after its last write the factory
   runs the Task check by itself; ChatGPT reads it with `task_check`, fixes the blockers and
   majors, brings a `decision` finding back to you as one more round, and writes again (at most two
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

`sf planner setup <workspace>` does this for a planning copy: a clone of the workspace's repository
in `~/planning/<workspace>` (`SF_PLANNING_DIR`), with the server registered for that folder only,
the factory's planning skill and `.claude/planning-copy.md` (README, The planning copy). Open Claude
Code there once and accept its trust dialog. The copy is read-only to the planner: its shell
commands run in Claude Code's sandbox, and the factory's secrets are denied to every tool.

Then, with `sf serve` running, start from the dashboard:

1. **New ticket** (section 1, step 2) with the Context owner **Claude Code, in your terminal**. A
   ticket made with ChatGPT switches on its page: *Plan with: ChatGPT · Claude Code* in the
   Planning conversation card (you can switch back the same way, even after the Task file is
   written).
2. Click its card. The ticket's page has no ChatGPT link; the Planning conversation card says "Paste
   it into a Claude Code session that has the software-factory MCP server (see the planning
   guide)" and shows the first message: press **Copy**.
3. Paste it into a Claude Code session (any directory). The message starts "Use the
   software-factory MCP server. Call guide." and names the ticket, the workspace and your words,
   as ChatGPT's does; it also lets Claude Code build a throwaway prototype (the prototype skill)
   outside the factory's worktrees when a design question is best settled by seeing it. The
   Implementer cannot read that prototype, so what you chose (structure, names, states) goes into
   the Task file.
4. It grills you on the plan, as in section 1 step 5: it looks facts up itself with `read_file`
   and `search` (or with its own tools, if the session runs in your checkout), asks in rounds of
   numbered questions with its recommended answers, and writes the Task file with `write_task`
   once you confirm you agree, or at once, with "Decisions taken without asking", when you say
   "just write it".
5. It waits for the automatic Task check with `task_check`, fixes what it finds, and tells you the
   Task file is ready.
6. You start the job, or let it `queue_add` the ticket. The Task check, Start and the jobs are the
   same whoever planned the ticket. In a workspace with `"auto_queue": true`
   ([Configuration](configuration.md)) a Task whose check ends ready, or that needs no check, joins
   the run queue by itself (the parts of one ticket in the order of their numbers), and the session
   tells you it is queued.

Without the dashboard, ask a session yourself to call `guide` first and to plan ticket `APP-12` in
workspace `my-app` with you: "Use the software-factory MCP server. Call guide, then plan APP-12 in
workspace my-app with me: …".

A Claude Code session that runs in the workspace's checkout may also simply write
`.software-factory/APP-12.md` itself with its file tools: that is the same as writing it by hand
(below). This is how a coordinating session works ([Ways of working](ways-of-working.md#3-with-a-coordinating-claude-code-session)).

### The planning skill

The factory ships its planning method as a Claude Code skill, `factory/skills/planning-tasks`: it
grills you, cuts the work into slices by the slicing rules, has a sub-agent trace each slice
through the code before the slice's Task file is written, and fixes what the Task check finds
until the check is ready. To use it by hand:

1. Run `sf planner setup my-app`: it clones the repository into `~/planning/my-app`, registers the
   software-factory MCP server for that folder and installs the skill. Open Claude Code there once
   and accept its trust dialog.
2. Start Claude Code there and send `/planning-tasks workspace my-app, ticket APP-12`, followed by
   your words, or the first message the ticket's page offers.

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
  another workspace). The queue waits for them; when the ticket needs their code, give it
  `builds_on:` (a ticket of the same workspace) or wait for the merge.
- **Size**: cut a solution into slices by kind of change: mechanical, preparation, change (the
  thinnest working path, then one axis of widening per slice), the switch, cleanup. A change or
  switch slice stays within about 400 changed lines, tests included, and 10 files; the other kinds
  have no limit but hold only their kind. Prefer slices that start from the base branch and can
  merge in any order; use `builds_on:` and `lands_after` only when a slice needs another's code or
  must not merge first. Slices that need each other's code are built in a row, each with
  `builds_on:` naming the one before it, and submitted one at a time, each once the one before it
  is merged. The method is the Handbook's `## Slicing a solution`.
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
Task file, its images, the Task files of the tickets it builds on (`builds_on`) and the repository
at the Task's `base`, in a temporary checkout of its own: never your conversation, the jobs or any
other Task file. It only advises: Start always works.

**What it checks.** It first paraphrases the Task in its own words (read it: a wrong paraphrase is a
finding of its own), then lists findings, each with a kind and a severity:

| Kind | Meaning |
| --- | --- |
| `decision` | a choice the Implementer would have to make, or a product decision no decision document covers (below) |
| `contradiction` | a claim about the code that the code contradicts, with its `path:line`, or a contradiction with a decision document, with its `<path>#<heading>` and the sentence quoted (always a blocker) |
| `missing` | a file, test or acceptance criterion the goal needs and the Task does not name |
| `overreach` | a part the goal does not need |
| `unclear` | a passage that can be read two ways |

and the files it expects to change. With a `scope`, an expected file outside it is a `missing`
major finding, and a scope entry no expected file matches is an `overreach` nit.

**The size of a slice.** For a Task of `kind: change` (or no `kind`) or `kind: switch`, more
expected files than the workspace's `slice.change_max_files` in
[`norms.json`](configuration.md#norms-normsjson) (10 by default) is an `overreach` major at "slice
norm": cut the Task again along the next axis (the Handbook's *Slicing a solution*). When the
Task says under a `## Why whole` heading why it is only safe whole, it is a nit instead: get
your agreement to keep it whole. `mechanical`, `preparation` and `cleanup` Tasks have no limit.
A `part_of`, `slice` or `kind` value that is not valid is an `unclear` nit at "front matter".

**The decision documents.** What was decided about your product (its concepts, its domain rules,
its architecture) lives in documents the coding rules do not cover: the glossary, the decision
records (ADRs), the terminology and architecture pages. Which files those are is the
`decision_docs` list of `norms.json` in the configuration directory (`sf norms <workspace>` shows
it; [Configuration](configuration.md#norms-normsjson) describes the file). The rule is "cite or ask":

- The planner reads them with the project documentation and names in the Task the ones the plan
  relies on.
- The Task check gets their list (the tracked files that match, at the Task's base; paths and
  sizes, at most 60) and reads the glossary, the terminology pages and the records that bear on
  the Task. A Task that contradicts one is a `contradiction` blocker quoting the sentence; a Task
  that decides something of the product no document covers (a concept's name or meaning, a domain
  rule, what the user sees or may do) is a `decision` finding, which comes back to you.
- Both reviewers get the list as it is in the job's worktree. An item that conflicts with a
  document begins `Decision:` and quotes it; a product question no document answers is never a
  fix item: the verdict's summary carries it on a `For the user:` line, which you read in the
  review entry of the job page.

A workspace whose globs match no file gets none of this: its prompts are as they were.

**Verdicts.**

| Verdict | Meaning |
| --- | --- |
| `ready` | no blocker or major finding |
| `not_ready` | at least one blocker or major finding ("not ready: N blocker, M major") |
| `failed` | the check could not run or gave no valid answer; never counts as ready |
| `none` (MCP) / "not checked" | the current version of the Task file has no check |
| "check not needed" | the current version has no check, and the Task needs none (below) |

A check belongs to one version of the Task file (with its images and the Task files it builds
on): once the file changes, the old check is **stale** ("· stale" on the card).

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
