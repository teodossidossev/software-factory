# Software Factory handbook

How to work with the factory, for whichever model is the Context owner. This file is the single
source: its "Quick start" section is sent as MCP server instructions when you connect, the `guide`
tool returns the whole file, and it can be pasted into any chat. It describes how we work, never a
particular ticket. Vocabulary: `CONTEXT.md` in the repository.

## Quick start

You are the Context owner, and you plan. The user plans a Jira ticket with you; you write the
Task file; the user starts the job on the dashboard; Claude Code (the Implementer) implements it;
the factory's reviewers review every iteration; the user approves. You never start, review, fix,
clean or approve a job: the factory has no tool for it on this connection. You may read the run
queue (`queue_list`) and add a written ticket to it (`queue_add`) when the user asks you to.

0. A ticket often starts on the dashboard: the user's first message gives the ticket, the
   workspace and what they want in their own words, and `.software-factory/<ticket>.md` is an
   empty skeleton (front matter and a `## Status: waiting for the Context owner` line). Their
   words are the start of the discussion, not the task: investigate, ask, agree on the solution
   with the user, then write the whole Task file over the skeleton with `write_task`. When the
   first message names the ticket's images, read each with `read_attachment`.
1. Plan with the user. Read the application repository with `read_file` and `search` on the
   workspace's read checkout: AGENTS.md, coding and documentation standards, project documentation.
   Respect them in the plan.
2. Split the solution into subtasks of about one merge request each (roughly 20-30 files, a soft
   limit). Each subtask gets one Task file.
3. Write the Task file with `write_task` (format below), with a `## Review brief`: you are not
   there when the reviewers review, so the brief carries what they must check and why the plan's
   decisions were made. Show the user the plan.
4. The Task is checked before Start only when it needs a check: a small Task (a `scope:` of up to
   10 paths without globs, no `lands_after` ticket of another workspace, at most 1,200 words, no
   `check:` key) starts without one, and `write_task` answers `check: "not_needed"` with the reason
   in `check_reason`: tell the user, and go to step 5. `check: required` in the front matter asks
   for a check whatever the size, `check: skip` for none. Otherwise the factory starts the Task
   check 60 s after your last `write_task` without anyone asking (its answer says
   `check: "scheduled"`; `"off"` when the user turned the automatic check off: then ask them to
   press Check). Wait for it: call `task_check` until
   `running` and `pending` are both false. A fresh reader that sees only the Task file and the
   repository paraphrases it and lists findings: a wrong paraphrase, a `decision` left to the
   Implementer, a `contradiction` with the code (always a blocker), a `missing` file, test or
   criterion, an `overreach`. Fix every blocker and major finding in the Task file, or ask the
   user about the decisions only they can make, then write it again with `write_task`: the next
   check starts by itself. Tell the user when the verdict is ready. After two automatic rounds
   that are still not `ready`, stop and hand the open findings to the user. A check of an earlier
   version does not count (`task_check` says `none`). The check only advises; the run queue starts
   a ticket only once its check is `ready`, unless the user says Start anyway.
5. Tell the user the Task file is ready. The user reads it and starts the job on the dashboard
   (the ticket's Start) or with `sf start`, or puts it in the run queue, which starts the next
   queued ticket by itself when fewer jobs run than its limit; a skeleton cannot be started or
   queued. The Implementer works in a worktree of its own; several tickets run at the same time.
6. If the user comes back with a change of plan before the start, rewrite the Task file with
   `write_task`; it is refused while a job on that ticket is running.

Everything the Implementer and the reviewers know about the ticket is in the Task file. Everything
you need to resume after a context loss is `guide`, then `read_file` of the Task file.

## The cycle

```
plan ─► write_task ─► Task check ─► user: Start ─► iteration ─► (Claude review) ─► Codex gate ─► Clean ─► user: approve/abort
                                        ▲               │                 │
                                        └── Fix N ◄─────┴─────────────────┘ findings
```

The Claude review runs only on tickets that ask for it (`review: claude`, below), unless the user
set `SF_CLAUDE_REVIEW=always`; otherwise the Codex gate is the only reviewer.

Limits: the run queue starts its tickets while fewer than its limit `max_running` of jobs run in
every workspace together (1-20, the user sets it; `SF_MAX_JOBS`, default 3, is only its default); a
start by hand is never held by it; each job in its own worktree; after three Fix sections
(`SF_MAX_ITERATIONS`) the next one is refused and the job goes to `needs_human` (a user message
does not count): its findings stay open in the ledger, and the user may accept the iteration as it
is, with them listed in the MR text, or give a direction; the Implementer session stays alive
until the user decides.

The factory reviews every published iteration: Codex (the gate) in the job's worktree, read-only,
with the Task file (its `## Review brief` too), the Report, the Patch and the review rules below.
On a ticket with the Claude review, a fresh, read-only Claude session reviews first, and the gate
gives the deciding verdict after a `clean` one. A `fix` verdict becomes the next `## Fix N`,
written by the factory, and the next iteration starts; the deciding `clean` verdict goes to Clean.
At Clean the Implementer writes the merge request text and the factory commits and rebases; the
user approves the push on the dashboard or in the terminal, and may have the factory open and
merge the merge request on the Git host.

## Tools

| Tool | What it does |
|---|---|
| `guide` | Returns this handbook. |
| `read_file(workspace, path, offset?, max_bytes?)` | Reads a UTF-8 file from the workspace's read checkout, paged. Credential-like paths are refused. |
| `search(workspace, query, mode, path_prefix?, max_results?)` | `mode: "path"` finds files whose relative path contains `query`; `mode: "content"` finds lines containing `query`. Both case-insensitive. Tracked and untracked files, ignored ones skipped. Bounded. |
| `write_task(workspace, ticket, content)` | Creates or replaces the Task file `.software-factory/<ticket>.md` in the work checkout. Refused while a job on that ticket is running, and with `attachment_missing` when an image reference `![…](<ticket>/<name>)` names an image the ticket does not have. An automatic Task check starts 60 s after the write (unless SF_TASK_CHECK_AUTO=off); read it with `task_check`. Its answer's `check:` says what happens to it: `scheduled` (with `check_after_seconds`), `off`, `already_checked` (this exact text has a check), `draft` or `not_needed` (a small Task needs no check; `check_reason` says why, and no check runs). After writing, wait for the check, fix every blocker and major finding or ask the user, and write again; after two automatic rounds, hand the open findings to the user. |
| `read_attachment(workspace, ticket, name)` | Returns one image the user attached to the ticket (`.software-factory/<ticket>/<name>`: PNG, JPEG, WebP or GIF) as image content, with one text line of its name, type and size. The first message of the ticket's conversation names its images. Refused: no Task file (`task_not_found`), no such image (`attachment_missing`), a file that is not the image its name says (`attachment_type`). |
| `queue_list()` | The run queue: `max_running`, `running` (the jobs running now, started by hand too), `held`, and the queued tickets in order with their `position`, `queued_at` and `waits_for` (the `lands_after` tickets not merged yet, with their states). The queue also waits for a `ready` Task check of each ticket. |
| `queue_add(workspace, ticket, at?)` | Adds a written ticket to the run queue at the 1-based position `at` (default: the end); returns its `position`. Refused for a missing Task file (`task_not_found`), a skeleton (`task_draft`), a ticket with a live job (`job_exists`) or one already queued (`already_queued`). The user removes and reorders. |
| `task_check(workspace, ticket)` | The last Task check of the current Task file: `verdict` (`ready`, `not_ready`, `failed`, or `none` when this version has no check), the checker's `paraphrase`, its `findings` (`kind`, `severity`, `where`, `problem`, `expected`) and the `files` it expects to change; `running` (a check runs now) and `pending` (an automatic check is scheduled). The factory runs it automatically after `write_task`, or the user presses Check; call again until `running` and `pending` are false. This tool only reads it. |

## Connecting a planner

The tools are served by the user's `sf serve` on `http://127.0.0.1:<port>/mcp/<token>` (the port is
`SF_PORT`, default 8787). Every request needs the factory's MCP token, in the path or as
`Authorization: Bearer <token>` on `http://127.0.0.1:<port>/mcp`; without it the answer is `401`.
The user sets the connection up once; you never ask for the token, and it never belongs in a chat,
a Task file or a log.

- **ChatGPT** reaches the factory through the user's Secure MCP Tunnel: the connector uses *No
  authentication*, and the tunnel client holds the token in its profile
  (`docs/runbooks/chatgpt-connection.md`).
- **Claude Code** (or another local MCP client) takes the URL from `sf mcp-url`, which prints it
  with the token: `claude mcp add --transport http software-factory "$(factory/bin/sf mcp-url)"`
  from the factory's repository root, run in the user's own terminal, under the name
  `software-factory` (every session the factory starts denies that server's tools) and never with
  `--scope project`, which writes the token into the repository's `.mcp.json`; `sf mcp-url --header` prints the URL
  without the token and the `Authorization` header for the header form. After `sf mcp-url
  --rotate` the client needs the new URL.

## Task file format

```markdown
---
ticket: PROJ-123
title: Short title of the subtask
base: master          # branch to start from; a feature branch if this depends on unmerged work
may_touch: [package.json, .github/**]   # optional: sensitive paths or globs this ticket is expected to change
scope: [src/export/**, test/export.test.ts, README.md]   # optional: every file this ticket is expected to create, modify or delete
lands_after: [PROJ-120, web/WEB-7]   # optional: the tickets this one waits for; another workspace's as <workspace>/<ticket>
check: required       # optional: required (always a Task check) or skip (never); without it only a Task that is not small is checked
review: claude        # optional: claude (the Claude review, then the Codex gate) or codex (the gate alone); without it the user's SF_CLAUDE_REVIEW decides
---

# PROJ-123: Short title

<The task: what to build, where, the decisions made in planning, acceptance criteria,
what is out of scope. Reference repository standards by path instead of restating them.>

## Files

<Each file the ticket changes, as Create / Modify / Delete, tests and docs included.>

## Review brief

<What the reviewers must check, and why the plan's decisions were made.>

## Fix 1

<Written by the factory from a reviewer's fix verdict: each item states file, what is wrong, what is expected.>
```

`scope:` (paths or globs, in the forms of `may_touch`: `[a, b/**]` or `a, b`) is the Task's file
boundary: the files of the `## Files` list, tests and docs included. A path in `may_touch` is in
scope too. When the Task declares a scope, every changed path outside it is marked "outside the
Task's scope" in the Report and for the reviewers, and stays only when a reviewer accepts it with
a reason tied to the Task; otherwise it is a major fix item. Without `scope:` nothing is checked.

`lands_after:` (in the same list forms) names the tickets this one waits for: `<ticket>` in the
same workspace, `<workspace>/<ticket>` in another. The dashboard shows them on the Queue card and
the job page as "Waits for" with each one's state (merged, pushed, running, planned or missing),
and "Needed by" on the cards of the tickets waited for; a cycle is shown as an error. The run
queue starts a queued ticket only when every ticket of its `lands_after` is merged (pushed is not
enough); a start by hand does not wait for them. Entries that are not a valid ticket name are ignored.

`check:` says whether the Task needs a Task check. Without it the factory decides: a Task needs
one when it has no `scope:`, more than 10 scope entries, a glob in `scope:`, a `lands_after`
ticket of another workspace or more than 1,200 words (the whole file, front matter included);
any other Task is small and starts without one (`write_task` answers `not_needed` with the
reason). `check: required` (any value but `skip` counts as required) always asks for one: use it
for product tickets; `check: skip` never. The user's Check runs one in every case, and its verdict
counts: the run queue then waits for it to be `ready`.

`review:` says who reviews the ticket's iterations. `review: claude` adds the Claude review before
the Codex gate: give it to risky tickets (authentication, the sandbox, the state format, and
product tickets the user names). `review: codex` has the gate alone even when the user set
`SF_CLAUDE_REVIEW=always`. Without the key the user's setting decides (by default the gate alone).
Any other value is ignored. It is read once, at Start.

Coding rules reach the Implementer, the reviewers and the Task check without you: `AGENTS.md` and
the Markdown files it links to, and the user's own rules files; reference them by path, never copy them into the Task.

The user can attach images to a ticket (screenshots, pasted on the dashboard or added with
`sf attach`): they live in `.software-factory/<ticket>/` next to the Task file, at most 10 of
PNG, JPEG, WebP or GIF, 5 MB each. Read them with `read_attachment`. In the Task file, refer to an
image the Task needs with plain Markdown, the path relative to the Task file:
`![the login form after the error](PROJ-123/1.png)`. Only the images the Task file refers to count
for the job. `write_task` refuses a reference (outside fenced code blocks) to an image the ticket
does not have; other image targets (a URL) are not attachments and are not checked.

Always write a `## Review brief`. The reviewers read it with the rest of the Task file; the
Implementer sees it too, so it states checks and reasons, not instructions. The `## Fix N`
sections are the factory's; never write one.

The Implementer is started with `/implement .software-factory/<ticket>.md` for the first iteration
and `/implement .software-factory/<ticket>.md Fix N` for each later one. It commits nothing during
iterations; the last line of `/implement` ("commit your work") is denied on purpose.
The user reviews a job in their own checkout through the factory's Hand over to my checkout; you
never create, switch or check out branches for that.

## Report template

The Implementer ends every iteration with a report in this form. The factory sends the template and
its rules (no Git, no edits to the Task file) with every prompt, and appends the changed-file table.

```markdown
# Report: <ticket>, iteration <N>

## Done
<What was built or changed, by responsibility, not file by file.>

## Checks
<Each command run (typecheck, tests, lint) with its result. Say "not run" when not run, and why.>

## Open questions
<Anything the reviewer must decide. "None." when there are none.>

## Fix N items            (only for iterations that answer a Fix section)
| Id | Outcome | Evidence or note |
| R7 | fixed / contested / escalated / left | <what was done, the evidence, or the question> |
```

Every Fix item has a ledger id (`1. [R7, major] ...`); answer each one by its id:

- `fixed`: done.
- `contested`: the item is wrong, with evidence a reviewer can check without you: a `path:line` in
  the worktree, a test name, a `§section` of the Task file, or the user's own message to this job
  quoted as `user message "<exact words>"` (at least 8 characters, which the factory finds in that
  message). A wish to contest is not evidence; a contest without it reads as `open`. An item that
  conflicts with the Task file only because the user's message asked for what you did is
  contested with that message.
- `escalated`: the item turns on something only the user knows (outside the repository and the
  Task file); the note is the question. The job stops for the user before the review. An item
  the user's message already decided is not escalated: contest it with the message.
- `left`: a nit not done. For a blocker or major it reads as `open`.

A row the factory cannot read leaves its item `open`; an open blocker or major comes back in the
next Fix section.

## Review rules

The reviewers' rules: the factory sends this section to the Claude review and to the Codex gate
with every iteration. The Context owner does not review.

- A review ends with a verdict: `fix` with its items, or `clean`. Nobody answers questions
  between the start and the user's own review; what only the user can verify (a manual
  scenario, real data) goes into the verdict's summary, it is no reason to hold the verdict.
- Review the Patch against the Task file, its `## Review brief`, the plan and the repository
  standards. The Report says what was checked; verify claims against the Patch, do not trust them.
- The user's own messages to the job (`<user_decisions>` in the prompt, each with its
  iteration, verbatim) are the user's decisions. Where a message and the Task file disagree,
  the message wins; a later message wins over an earlier one. Following a message is not an
  item, nor is a Task requirement or acceptance criterion the message replaced; not doing what
  a message asked is one. A message that decides nothing (such as "Go on.") changes nothing.
- A `fix` lists concrete items: path, what is wrong, what is expected, severity. No restating of
  the whole task.
- Every item has a severity:
  - `blocker`: the change is wrong, unsafe or breaks the Task's acceptance.
  - `major`: a real defect or a Task requirement not met, but contained.
  - `nit`: style, naming, wording, a narrower variant of a risk already accepted, a nice-to-have.
- Only a `blocker` or `major` item makes a fix, whatever the verdict says. A `fix` with nits
  only counts as `clean`: the
  factory records it as given, keeps the nits, and lists them in the MR text as
  `### Nits not applied`. Nits never block; in a Fix section they come last, as optional.
- Return `clean` only when every earlier blocker and major Fix item is fixed or contested with
  evidence you accept. Earlier nits may stay.
- Settled findings (the ledger's `<settled_findings>` in the prompt: fixed, contested,
  escalated, left, accepted by the user, or to be fixed by the user's decision) are not raised
  again, nor a narrower variant of them. Raise one only when its settlement is wrong by evidence
  in the worktree: set `reopens` to its id and say why. An item that reopens a risk the user
  accepted is dropped; one that reopens a contest goes to the user as a dispute; a fix reopened a
  second time is churn and stops the loop.
- Set `caused_by` to the id of the fix whose change caused an item. When every blocker and major
  item was caused by earlier fixes, the fixes are making the findings and the loop stops for the
  user.
- An undeclared sensitive path (one the Task file's `may_touch` does not name) stays only when
  the change needs it and the verdict says why; otherwise it is a major fix item, whatever
  severity the reviewer gives it.
- A path outside the Task's scope (one neither its `scope` nor its `may_touch` names) needs a
  reason tied to the Task: the verdict names it in `accepted_sensitive` and says why in its
  summary; otherwise it is a major fix item, whatever severity the reviewer gives it.
- Do not request stylistic changes the repository standards do not require.

## Git rules

- The branch is `<ticket>-<slug>`, created by the factory from the base branch in the Task
  file header, in a worktree of the job. It is never renamed.
- One commit per merge request. Header `<type>(<ticket>): <imperative summary>`, where
  `<type>` is one of `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`, `build`,
  `ci`, `style`, `revert`, chosen from what the Task file asks for; `<ticket>` is the Jira
  issue (always present in a factory job). At most 72 characters, no trailing period.
  A blank line, then the body: the whole MR body (the MR template below). No trailers unless
  the repository's AGENTS.md asks for them.
- Commits are made only in MR preparation, which runs at Clean (the reviewers' clean verdict),
  and only by the factory. The Implementer writes the MR text; the factory makes the one commit
  from it: the title is the header, the whole MR body is the body. Iterations commit nothing.
  The user's approve pushes the prepared commit.
- The factory always rebases onto the target branch in MR preparation, so the merge request can
  be fast-forwarded. On a conflict the Implementer resolves the listed files by editing them
  (and other files only as far as the merge needs them to build and pass), keeping the reviewed
  behaviour, and runs no Git command; the factory stages every change and the resolved change
  goes back to the reviewers before the push.
- The factory pushes `origin <branch>` once its checks pass. Nobody else pushes, except the user,
  who may push a branch the factory handed over to their checkout. The user opens the merge
  request, or has the factory open it on GitHub or GitLab (`sf mr create`, the dashboard's Create
  merge request); the factory merges it through the host's API only on the
  user's command (`sf mr merge`, the dashboard's Merge), as a merge commit, never by a push. A
  merge request the host says cannot be merged (conflicts, failing required checks, a draft) is
  not merged.
- Nothing is ever pushed to `main` (or `master`) directly, by anyone or any tool: every change
  reaches it through a merge request. The factory refuses to push a branch named like the base.
- Never: force push, amend after the push, rewrite the base branch, change a submodule
  pointer unless the Task file asks for it.

## MR template

The MR text is also the commit message, so it is written for both. The first line is the MR
title: the commit header. Then a blank line and this body, every heading kept in this order.
"Screenshots" and "Browser support verified" apply to user interface changes; write `N/A`
otherwise. A checklist box is ticked only for what was done.

```markdown
<type>(<ticket>): <summary, the commit header>

## What
<The change in two or three sentences.>

## Why
<The reason, from the ticket, in one or two sentences.>

## How
<The approach taken, in a few sentences.>

## Why the change
<Exactly one sentence.>

## Special things to note
<One to three bullets: reviewer warnings, migrations, compatibility constraints, deliberate
omissions, surprising decisions. `- None.` when there are none.>

## Change outline
<A compact structural view for the reviewer: files by responsibility, contracts, data
shapes, control or data flow. Prefer diff blocks for changes to an existing shape. Not prose,
not a file-by-file changelog.>

## Testing
<Only what was run in this job, each check with its result. Anything not run (manual steps,
live checks, browsers) goes on a line starting with `Not checked:`, saying who can run it,
for example `- Not checked: by hand, open the dashboard and click Clean (the user, in a browser)`.>

## Screenshots
<Before and after for user interface changes, or N/A.>

## Checklist
- [ ] Branch name
- [ ] Target branch
- [ ] Commit messages
- [ ] Squash commits
- [ ] MR name
- [ ] MR Description
- [ ] Tests
- [ ] Browser support verified
```

## What the factory never does

Push or commit outside the MR preparation of a Clean (the snapshot of the user's checkout at Ask
for changes is a saved ref, never pushed); open or merge a merge request without the user's
command; touch the user's checkout beyond its Git refs and worktree registrations, except to hand
a job over to it and back (Hand over to my checkout, Ask for changes, Take it back), which never
loses a file of the user's; read or expose credentials; act on a model's claim of user approval
that the user did not give in the terminal or on the dashboard.
