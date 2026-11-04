# Software Factory

A local mediator that lets ChatGPT plan, Claude Code implement, Claude and Codex review, and the user accept,
without the user having to notice when Claude has finished. It exists to remove the Idle gap.

## Language

### Goal

**Idle gap**:
The time between Claude finishing a piece of work and someone acting on it. The factory exists to
make it zero. Every feature is judged by how much of it it removes.

### People and agents

**Context owner**:
ChatGPT, in the web conversation where a Ticket is planned. It plans only: it reads the Workspace,
discusses the Ticket with the User, writes the Task file with its Review brief and tells the User
it is ready. It does not start, review or approve Jobs.
_Avoid_: reviewer (ambiguous), planner, ChatGPT connector

**Implementer**:
The Claude Code session that executes a Task file in the work checkout.
_Avoid_: executor, agent, runner (the Runner is the process the session runs in)

**User**:
The one person who owns the machine, the Ticket, human review, approve, abort and the merge request.
_Avoid_: operator

**Factory**:
The local process (`sf serve`) that serves the planning tools to the Context owner, starts the
Jobs and their Runners, keeps job state, notifies the User and serves the Dashboard.
_Avoid_: bridge, mediator, supervisor

**Runner**:
The process of one Job (`sf run`), detached from the Factory, that runs the Job's Implementer
turns, its Reviews and the Gate and writes the Job's state, so a restart of the Factory leaves the
Job running. One per Job; it ends when the Job waits for the User or has ended.
_Avoid_: worker, daemon, job process

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
appended later, and a `## Review brief` for the Reviews. It is the complete instruction for the
Implementer and the complete brief for the Reviews.
_Avoid_: instruction, instruction.md, spec

**Ticket draft**:
A Task file as the Dashboard writes it from the User's request before the Context owner has
planned: the header, the request verbatim under `## Request`, and a `## Status: draft` line. The
Context owner replaces it with the Task format through `write_task`; the factory treats it as a
Task file otherwise.
_Avoid_: stub, placeholder task, request file

**Fix section**:
A `## Fix N` section appended to the Task file after a Review, by the factory from a verdict it
acts on as `fix`: the blocker and major items, then the Nits as optional. Appending one is the
request for the next Iteration.
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
be accepted by the deciding Review at Clean.
_Avoid_: protected file, system file

**Review**:
The check of one Iteration against its Task file, the repository standards and the Handbook's
review rules, by a fresh read-only Claude session the factory starts in the Worktree when the
Iteration is published. It ends with a verdict, `fix` or `clean`, and items with a Severity. The
factory acts on it as `fix` only with a blocker or major item (or an undeclared Sensitive path not
accepted): the items become the next Fix section. Otherwise it counts as `clean`, which, with the
Gate on, goes to the Gate. A failed Review hands the Job to the User.
_Avoid_: code review session, audit

**Severity**:
The weight of a Review item: `blocker` (the change is wrong, unsafe or breaks the Task's
acceptance), `major` (a real defect or a Task requirement not met, but contained) or `nit`.

**Nit**:
A Review item of Severity `nit`: style, naming, wording, a narrower variant of a risk already
accepted, a nice-to-have. A Nit never blocks; the Nits of the Iteration that reaches Clean go into
the MR text as `### Nits not applied`.
_Avoid_: minor, suggestion (for a Nit)

**Gate**:
The second, deciding Review of an Iteration that a Claude Review found clean, run by the Codex CLI
on the User's ChatGPT plan in a read-only sandbox in the Worktree. Its verdict, acted on by the
same rule as the Review's, is Clean or the next Fix section; it is limited in rounds and tokens per Job, and off when no Codex
is found. A failed Gate hands the Job to the User.
_Avoid_: OpenAI reviewer, second opinion

**Clean**:
The deciding Review's (the Gate's when it is on) verdict, as the factory acts on it, that the
Patch needs no further Fix section (no blocker or major item), with every undeclared Sensitive path acknowledged. It starts MR
preparation; it accepts nothing and pushes nothing.

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

### Rules and templates

**Git rules**:
The factory-owned rules for branch names, commit messages and when to rebase onto the target.
The same for every Workspace. The verifiable part is enforced by the factory before a push.

**Report template** and **MR template**:
Factory-owned formats the Implementer must follow for the Report and for the merge request
description.

**Handbook**:
The factory-owned document that tells any Context owner how to plan with the factory: the cycle,
the tools and their order, the Task file format with its Review brief, the review rules the Reviews
follow, the Git rules and the templates. One file, served as MCP server instructions at connect time, in full through the `guide`
tool, and readable in the repository. It describes how we work, never a particular Ticket.
_Avoid_: system prompt, onboarding, protocol doc
