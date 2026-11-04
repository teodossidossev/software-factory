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
A registered application repository: a name and its local checkout (the User's IDE checkout,
read by the Context owner, where the Task files live and from which every Job's Worktree is
created). The Implementer never works in it.
_Avoid_: app, app_id, project, work checkout

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
A `## Fix N` section appended to the Task file after a Review, by the factory from a `fix` verdict
or by the Context owner. Appending one is the request for the next Iteration.
_Avoid_: findings, review request, feedback

**Job**:
One Ticket being implemented in one Workspace on one Branch. Identified by the Branch name.

**Worktree**:
The Git worktree of one Job, created from the Workspace's checkout at start under the factory's
state directory, where the Implementer works. Removed at Clean (the Branch stays), at the end of
the Job and by reset; recreated from the Branch when a fix is asked after Clean.
_Avoid_: work checkout, sandbox directory

**Branch**:
The Git branch created at Job start from the fetched base branch, checked out in the Job's
Worktree. At Clean it receives the one commit of the change and the User checks it out in the
IDE for Human review.

**Iteration**:
One execution of one section of the Task file by the Implementer: the first runs the task, each
later one runs a Fix section. Produces a Report and a Patch.
_Avoid_: turn, run, attempt

**Report**:
The Implementer's account of an Iteration, in the factory's template: what was done, tests run and
their results, open questions, and what happened to each item of the Fix section it answered.

**Patch**:
The uncommitted difference between the Worktree and the base branch after an Iteration,
including new files, excluding ignored and credential-like files. Nothing is committed during
Iterations.
_Avoid_: snapshot, diff artifact, export

**Sensitive path**:
A changed file that is unusual for a Ticket to touch: dependency manifests and lockfiles,
environment and tool configuration, CI and container files, IDE and agent files, root dotfiles.
Declared when the Task file's `may_touch` names it, undeclared otherwise; an undeclared one must
be acknowledged by the Context owner at Clean.
_Avoid_: protected file, system file

**Review**:
The check of one Iteration against its Task file, the repository standards and the Handbook's
review rules, by a fresh read-only Claude session the factory starts in the Worktree when the
Iteration is published. It ends with a verdict: `fix` with items, which become the next Fix
section, or `clean`, which is Clean. A failed Review hands the Job to the User.
_Avoid_: code review session, audit

**Clean**:
The Review's or the Context owner's verdict that the Patch needs no further Fix section, with
every undeclared Sensitive path acknowledged. It starts MR preparation; it accepts nothing and
pushes nothing.

**Human review**:
The User reading the Branch in the IDE after Clean. It ends with approve, a further fix, or abort.

**Approve**:
The User's command that pushes the Branch prepared at Clean. Given in the terminal or the
Dashboard; refused when the Branch tip was edited by hand unless pushed as it is.
_Avoid_: accept, acceptance

**MR preparation**:
The phase that Clean starts: in the Worktree the Implementer writes the merge request title and
description; the factory, outside the sandbox, commits the reviewed change by the Git rules as one
commit and rebases it onto the target branch. On a conflict the Implementer resolves the files and
the change goes back to review. Then the factory removes the Worktree and leaves the Branch with
one commit for Human review. The User opens the merge request after Approve.

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
