---
name: planning-tasks
description: Plan a Software Factory ticket into Task files whose Task check is green. Use to plan, cut or re-plan a ticket, or to fix Task check findings, with the software-factory tools.
---

Turn a ticket into Task files an Implementer builds with **zero decisions**. The factory's `guide`
is the law: the cycle, the slicing method, the Task file format. This skill is the craft that gets
a Task **green** (its Task check `ready`) at the first check.

The Task check is a fresh reader with the repository open. It searches for every file your change
touches that the Task did not name, every claim the code contradicts, and every choice you left
open. Do that legwork before it does.

The workspace and the ticket are in the user's message.

## 1. Ground

1. Note the base branch's commit: the plan is against it. In a planning copy the factory fetched
   and fast-forwarded it when it set the copy up (the copy's commands reach no network); elsewhere,
   `git fetch origin` and fast-forward it first.
2. Call `guide`. In a planning copy, read `.claude/planning-copy.md` and every file it names for
   this ticket: the user's request, the user's rules for the workspace, the product vision.
   Elsewhere, the user's request is in their message.
3. Read the ticket's Task file and each of its images with `read_attachment`. A Task file that
   already holds a delivery plan means a planning in progress: resume from its status line.
4. Read what binds the ticket in the repository: its agent and convention documents (testing
   first), and the decision documents of the area you will change (specs, decision records,
   glossary).

Done when you can name the base commit and every binding document, each one read.

## 2. Grill

Invoke `grilling` on the user's request. Facts are yours to find, through sub-agents; the user
decides only what only they can decide.

Done when the frontier is empty and the user confirmed. Then write the **delivery plan**
([ANATOMY.md](ANATOMY.md)) over the ticket's Task file with `write_task`: from here on, nothing
lives only in this chat.

## 3. Cut

Cut by the guide's `## Slicing a solution`. Show the cut as a table (slice, kind, what, size,
depends on) and name the slices that can go in parallel. Ask whether the slices get the tracker's
sub-task keys or `<ticket>-<n>`. When the user proposes another cut, check it against the slicing
rules and say what it breaks before following it.

Done when the user approved the cut. Record it in the delivery plan.

## 4. Tracer

Take one slice to green before writing the others: the independent slice with the widest
**blast radius**. Trace it, write it, green it (the three moves below). What its check finds is
what this repository's checker demands: write each finding class you had not foreseen into the
delivery plan's **lessons**, as a rule for the remaining slices.

## 5. The rest

Take the remaining slices in dependency order, up to four traces at a time, the lessons added to
each brief. A slice is traced only after the slices it builds on are green: a check can still
change a name, and a later slice's check goes out of date when a Task it builds on changes. Their
Task files go into its brief, and it uses the exact names they introduce. The delivery plan's
contracts table is the single source of those names; fill a slice's row as soon as its Task is
green.

## The three moves

**Trace.** Dispatch a sub-agent whose brief is [TRACE.md](TRACE.md) (give it the path), the
slice's row of the cut and the decisions it rests on. It returns the slice's surface, its
consumers, its walk through the code, its files and the decisions still open. Then:

- A trace that puts the slice over the slicing norm is a finding about the cut. Re-cut, show the
  user what changed and why, and trace the new slices. The usual cures: a preparation slice that
  gathers the consumers behind one helper, or a split along the trace's file groups.
- Settle the open decisions: the ones the code answers, yourself; the others, with the user, as a
  grilling round.

**Write.** By [ANATOMY.md](ANATOMY.md), only when the trace is back and its decisions are settled.
When the base moved since the trace, fetch it and re-read every `path:line` the draft cites: the
check reads the base as it is now. Then `write_task`.

**Green.** `write_task` schedules the check; wait for it with `task_check`. For each blocker and
major:

- Name the legwork that would have caught it (a consumer not traced, a claim not walked, a
  decision not closed, a convention not read). Redo that legwork for this slice **and** for every
  slice not yet green: a finding is a class, not a sentence.
- A `decision` only the user can make goes to the user as a grilling round, with your
  recommendation.
- A finding the code refutes is answered in the Task: state the fact with its `path:line`, so the
  next check finds the proof.

A slice is done when its check is `ready`. After two rounds that are not, follow the guide: stop
and hand the open findings to the user.

## 6. Hand over

Report one table: slice, kind, size, depends on, check rounds. List the decisions taken without
asking and the risks left. Set the delivery plan's status to `planned`. Ask whether to queue; on
yes, `queue_add` the slices in dependency order.
