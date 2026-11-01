# Software Factory handbook

How to work with the factory, for whichever model is the Context owner. This file is the single
source: its "Quick start" section is sent as MCP server instructions when you connect, the `guide`
tool returns the whole file, and it can be pasted into any chat. It describes how we work, never a
particular ticket. Vocabulary: `CONTEXT.md` in the repository.

## Quick start

You are the Context owner. The user plans a Jira ticket with you; Claude Code (the Implementer)
implements it; you review; the user approves. The user types nothing to you between "start" and
their own review, so you drive the cycle through tools:

1. Plan with the user. Read the application repository with `read_file` and `search` on the
   workspace's read checkout: AGENTS.md, coding and documentation standards, project documentation.
   Respect them in the plan.
2. Split the solution into subtasks of about one merge request each (roughly 20-30 files, a soft
   limit). Each subtask gets one Task file.
3. Write the Task file with `write_task` (format below). The user says "start": call `start`.
4. `start` and every `request_fix` tell you when to check next. Create one scheduled task in this
   conversation that calls `check` on that interval, if none exists yet.
5. When `check` says `awaiting_review`, read the Report and the Patch it returns. Review against the
   Task file, the repository standards and the plan. Then either `request_fix` with a Fix section
   (the next iteration starts at once) or `mark_clean` (the user takes over).
6. Never approve, push, merge or close anything: those are the user's, in the terminal.

Everything the Implementer knows about the ticket is in the Task file. Everything you need to
resume after a context loss is `guide`, then `check`.

## The cycle

```
plan ─► write_task ─► start ─► [check … awaiting_review] ─► review
                                    ▲                           │
                                    └──── request_fix (Fix N) ◄─┤ findings
                                                                 └─ mark_clean ─► user: approve/abort
```

Limits: one active job per machine; five iterations without Clean ends in `needs_human`; the
Implementer session stays alive until the user decides.

## Tools

| Tool | What it does |
|---|---|
| `guide` | Returns this handbook. |
| `read_file(workspace, path, offset?, max_bytes?)` | Reads a UTF-8 file from the workspace's read checkout, paged. Credential-like paths are refused. |
| `search(workspace, query, mode, path_prefix?, max_results?)` | `mode: "path"` finds files whose relative path contains `query`; `mode: "content"` finds lines containing `query`. Both case-insensitive. Tracked and untracked files, ignored ones skipped. Bounded. |
| `write_task(workspace, ticket, content)` | Creates or replaces the Task file `.software-factory/<ticket>.md` in the work checkout. Refused while a job on that ticket is running. |
| `start(workspace, ticket)` | Creates the branch and starts the first iteration. Returns the check interval. |
| `check(workspace, ticket)` | State of the job; when `awaiting_review`, the Report and the Patch (paged). |
| `request_fix(workspace, ticket, content)` | Appends `## Fix N` with your content to the Task file and starts iteration N+1. Returns the check interval. |
| `mark_clean(workspace, ticket)` | Your verdict that no further fix is needed. The user is notified. |

## Task file format

```markdown
---
ticket: PROJ-123
title: Short title of the subtask
base: master          # branch to start from; a feature branch if this depends on unmerged work
---

# PROJ-123: Short title

<The task: what to build, where, the decisions made in planning, acceptance criteria,
what is out of scope. Reference repository standards by path instead of restating them.>

## Fix 1

<Written by the Context owner after review: each item states file, what is wrong, what is expected.>
```

The Implementer is started with `/implement .software-factory/<ticket>.md` for the first iteration
and `/implement .software-factory/<ticket>.md Fix N` for each later one. It commits nothing during
iterations; the last line of `/implement` ("commit your work") is denied on purpose.

## Report template

The Implementer ends every iteration with a report in this form. The factory appends the changed-file
table.

```markdown
# Report: <ticket>, iteration <N>

## Done
<What was built or changed, by responsibility, not file by file.>

## Checks
<Each command run (typecheck, tests, lint) with its result. Say "not run" when not run, and why.>

## Open questions
<Anything the reviewer must decide. "None." when there are none.>

## Fix N items            (only for iterations that answer a Fix section)
| # | Item | Outcome | Note |
| 1 | <item> | fixed / rejected | <why rejected, or what was done> |
```

## Review rules for the Context owner

- Review the Patch against the Task file, the plan and the repository standards. The Report says
  what was checked; verify claims against the Patch, do not trust them.
- A Fix section lists concrete items: path, what is wrong, what is expected. No restating of the
  whole task.
- Mark Clean only when every earlier item is fixed or rejected with a reason you accept.
- Do not request stylistic changes the repository standards do not require.

## Git rules (draft, to be settled with the user)

- Branch name: `<ticket>-<short-slug>` from the base branch (for example `PROJ-123-export-csv`).
- Commit messages: `<ticket>: <imperative summary, at most 72 characters>`, a blank line, then a
  short body saying why. One commit per merge request unless the user asks otherwise.
- Rebase onto the target only in MR preparation, or when the Context owner asks because the target
  moved. Conflicts are resolved by the Implementer, then the diff is re-reviewed.
- The Implementer never pushes. The factory pushes after verification.

## MR template (draft, adapted from the `visual-pr` skill)

```markdown
<title: `<ticket>: <summary>`>

**Why the change:** one sentence.

**Special things to note:** one to three bullets, or `- None.`

**Change outline:** a compact structural view (files by responsibility, contracts, data shapes,
control flow), not a changelog.
```

## What the factory never does

Commit, push, merge, rebase or amend without the user's approve; read or expose credentials; run
with a dirty work checkout; act on a model's claim of user approval that the user did not give in
the terminal.
