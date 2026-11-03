# Software Factory

A local mediator that lets ChatGPT plan and review, Claude Code implement, and the user accept,
without the user having to notice when Claude has finished. It exists to remove the Idle gap.

## Language

### Goal

**Idle gap**:
The time between Claude finishing a piece of work and someone acting on it. The factory exists to
make it zero. Every feature is judged by how much of it it removes.

### People and agents

**Context owner**:
ChatGPT, in the web conversation where a Ticket was planned. It plans, writes the Task file,
checks progress, reviews and writes Fix sections.
_Avoid_: reviewer (ambiguous), planner, ChatGPT connector

**Implementer**:
The Claude Code session that executes a Task file in the work checkout.
_Avoid_: executor, agent, runner

**User**:
The one person who owns the machine, the Ticket, human review, approve, abort and the merge request.
_Avoid_: operator

**Factory**:
The single local process that serves tools to the Context owner, runs the Implementer, keeps job
state, notifies the User and later serves the Dashboard.
_Avoid_: bridge, mediator, supervisor

### Work

**Ticket**:
A Jira issue. Its key names the Task file and the Job.

**Workspace**:
A registered application repository: a name, a read checkout (the User's IDE checkout, used by the
Context owner for reading) and a work checkout (where the Implementer works). They may be the same
directory.
_Avoid_: app, app_id, project

**Task file**:
The one Markdown file per Ticket, `.software-factory/<ticket>.md` in the work checkout, excluded
from Git locally. It holds a short header (base branch, title), the task, and every Fix section
appended later. It is the complete instruction for the Implementer and the complete brief for the
Context owner.
_Avoid_: instruction, instruction.md, spec

**Ticket draft**:
A Task file as the Dashboard writes it from the User's request before the Context owner has
planned: the header, the request verbatim under `## Request`, and a `## Status: draft` line. The
Context owner replaces it with the Task format through `write_task`; the factory treats it as a
Task file otherwise.
_Avoid_: stub, placeholder task, request file

**Fix section**:
A `## Fix N` section the Context owner appends to the Task file after a review. Appending one is
the request for the next Iteration.
_Avoid_: findings, review request, feedback

**Job**:
One Ticket being implemented in one Workspace on one Branch. Identified by the Branch name.

**Branch**:
The Git branch created at Job start from the fetched base branch, in the work checkout. The User
checks it out in the IDE to watch the work.

**Iteration**:
One execution of one section of the Task file by the Implementer: the first runs the task, each
later one runs a Fix section. Produces a Report and a Patch.
_Avoid_: turn, run, attempt

**Report**:
The Implementer's account of an Iteration, in the factory's template: what was done, tests run and
their results, open questions, and what happened to each item of the Fix section it answered.

**Patch**:
The uncommitted difference between the work checkout and the base branch after an Iteration,
including new files, excluding ignored and credential-like files. Nothing is committed during
Iterations.
_Avoid_: snapshot, diff artifact, export

**Clean**:
The Context owner's verdict that the Patch needs no further Fix section. It moves the Job to human
review; it accepts nothing.

**Human review**:
The User reading the Branch in the IDE after Clean. It ends with approve or abort.

**Approve**:
The User's command that starts MR preparation. Given in the terminal (v1) or the Dashboard (v2).
_Avoid_: accept, acceptance

**MR preparation**:
The phase after Approve: the Implementer rebases onto the target branch, resolves conflicts, commits
by the Git rules and writes the merge request title and description; the factory verifies and
pushes. The User opens the merge request.

**Check**:
The Context owner's periodic question to the factory about a Job, made by a ChatGPT scheduled task,
not by the User.

### Rules and templates

**Git rules**:
The factory-owned rules for branch names, commit messages and when to rebase onto the target.
The same for every Workspace. The verifiable part is enforced by the factory before a push.

**Report template** and **MR template**:
Factory-owned formats the Implementer must follow for the Report and for the merge request
description.

**Handbook**:
The factory-owned document that tells any Context owner how to work with the factory: the cycle,
the tools and their order, the Task file format, Clean, the check intervals, the Git rules and the
templates. One file, served as MCP server instructions at connect time, in full through the `guide`
tool, and readable in the repository. It describes how we work, never a particular Ticket.
_Avoid_: system prompt, onboarding, protocol doc
