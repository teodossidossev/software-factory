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
The model a Ticket is planned with: ChatGPT in its web conversation, or Claude Code (or another
MCP client) through the factory's MCP server. It plans only: it reads the Workspace,
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
A Task file as the Dashboard writes it for a new Ticket before the Context owner has planned: the
front matter, the title heading, a `## Status: waiting for the Context owner` line and a note (the
older marker `## Status: draft` counts the same). The User's request is not in it: it opens the
Context owner's conversation instead. The Context owner replaces it with the Task format through
`write_task`; until then it cannot be started or queued (`task_draft`).
_Avoid_: stub, placeholder task, request file

**Task check**:
The reading of a Task file before Start by a fresh read-only Claude session that sees only the
Task file, its images, the Task files of the Tickets it builds on (`builds_on`) and the repository
at the Task's base, in a checkout of its own: never the Context
owner's conversation, the Jobs or the Ledger. It paraphrases the Task first, then lists findings (a decision left to the Implementer, a
contradiction with the code, something missing, an overreach, an unclear passage), each with a
Severity, and the files it expects to change. It is `ready` without a blocker or major finding,
`not_ready` otherwise; a failed one is never ready. It is kept per version of the Task file, and
one of an earlier version is stale. It only advises: Start stays the User's call. `sf serve` runs it
by itself 60 s after the last change of a Task file that needs one (unless
`SF_TASK_CHECK_AUTO=off`), and the User runs it with Check on the board or `sf check-task`; the
Context owner reads it (`task_check`) and rewrites the
Task from it.
_Avoid_: plan review, lint, pre-review (for a Task check); Review (that is of an Iteration)

**Attachment**:
An image of a Ticket (PNG, JPEG, WebP or GIF) kept next to its Task file in
`.software-factory/<ticket>/`. Only the Attachments the Task file refers to as
`![alt](<ticket>/<name>)` count for a Job: it copies them at Start, Restart and Resume and gives
the same set, from its own copy, to the Implementer, the Reviews and the Gate; the Task check sees
them too.
_Avoid_: screenshot file, asset, upload (for an Attachment)

**Fix section**:
A `## Fix N` section appended to the Task file after a Review, by the factory from a verdict it
acts on as `fix`: the blocker and major items, then the Nits as optional, each with its Ledger id
(in a Joint round one section for both Reviews, each item naming who raised it).
Appending one is the request for the next Iteration.
_Avoid_: findings, review request, feedback

**Job**:
One Ticket being implemented in one Workspace on one Branch. Identified by the Branch name.
Its allowed state changes are the table `JOB_TRANSITIONS` in `factory/src/jobs.ts`.

**Paused**:
The state of a Job the User stopped with Pause: nothing of it runs (no Runner, no Implementer turn,
no Review, no Gate), and it keeps its Worktree, Branch, Implementer session, Iterations, Ledger and
events. A Review or Gate round it interrupted is thrown away, never a verdict. Resume goes on where
it stopped: the same session continues the turn, or the interrupted round runs again on the same
Iteration; a Task file changed meanwhile goes to the Implementer as its diff and to the Reviews as
the new file. A Paused Job does not count toward the run limit `max_running` of the Queue. Restart replaces it (or an aborted,
failed or needs_human Job) with a new Job from the current Task file on a fresh Worktree and Branch.
_Avoid_: suspended, on hold, stopped (for a Paused Job); aborted (that Job has ended)

**Queue**:
The one order of the planned Tickets of every Workspace that the factory starts by itself, and the
run limit `max_running`: how many Jobs may run at once (starting, working, awaiting review,
preparing the MR or Waiting for limits) in every Workspace together; the User sets it, `SF_MAX_JOBS` is only its
default. When a slot is free, `sf serve` starts the first queued Ticket whose Task check is
`ready` (or not needed, or forced with Start anyway), whose `lands_after` Tickets are all merged
and whose `builds_on` Ticket has a prepared commit or is merged; it never starts one twice. The
limit gates only these starts: a start by
hand always goes, and its Job counts as running. The User adds, removes, reorders, holds and
releases it (the board, `sf queue`); the Context owner reads it and adds to it.
_Avoid_: backlog, schedule, planned list (for the Queue); slots per workspace

**Waiting for limits**:
The state (`waiting_limit`) of a Job whose session hit the plan's usage limit (Claude's or Codex's):
it is parked as if Paused, the interrupted turn or Review round thrown away, never a verdict, and
it keeps its slot in the Queue's run limit. While any Job waits for limits the Queue starts
nothing. At the limit's reset the Queue applies its rule (resume the parked Jobs then go on, resume
them only, or wait for the User); the User may Resume one at any time, with a message after a turn.
_Avoid_: rate-limited, throttled, on hold (the Queue's hold by hand is another thing)

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
be accepted by the Reviews of the Round at Clean (in a Joint round by both).
_Avoid_: protected file, system file

**Review**:
The check of one Iteration against its Task file, the repository standards and the Handbook's
review rules, by a fresh read-only Claude session the factory starts in the Worktree when the
Iteration of a Job with the Claude Review is published: its Task file says `review: claude`, or
`SF_CLAUDE_REVIEW=always` and it does not say `review: codex`, or the Gate is off. On any other
Job the Gate alone reviews the Iteration. It ends with a verdict, `fix` or `clean`, and items with
a Severity. The
factory acts on it as `fix` only with a blocker or major item (or an undeclared Sensitive path not
accepted): the items become the next Fix section. Otherwise it counts as `clean`. With the Gate
on, it runs in a Joint round with the Gate. A failed Review hands the Job to the User.
_Avoid_: code review session, audit

**Severity**:
The weight of a Review item, or of a Task check finding: `blocker` (the change is wrong, unsafe or breaks the Task's
acceptance), `major` (a real defect or a Task requirement not met, but contained) or `nit`.

**Nit**:
A Review item of Severity `nit`: style, naming, wording, a narrower variant of a risk already
accepted, a nice-to-have. A Nit never blocks; the Nits of the Iteration that reaches Clean go into
the MR text as `### Nits not applied`.
_Avoid_: minor, suggestion (for a Nit)

**Ledger**:
The Job's record of every Review item that went into a Fix section (`ledger.json`), each with an
id (`R1`, `R2`, …), its Severity and how it stands: open, fixed, contested, escalated, left (a Nit
not done), accepted by the User as a risk, or to be fixed by the User's decision. The Implementer
answers each item by its id in the Report; the factory reads the answers, shows the Reviews every
Settled finding and applies the Ledger to their verdicts.
_Avoid_: findings list, issue tracker

**Settled finding**:
A Ledger entry that is not open. A Review does not raise it again, nor a narrower variant of it; it
reopens one only when the settlement is wrong by evidence in the Worktree, naming its id. An item
that reopens a risk the User accepted is dropped.
_Avoid_: closed item, resolved finding

**Contest**:
The Implementer's answer that an item is wrong, with evidence a Review can check without it: a
`path:line` in the Worktree, a test, or a section of the Task file. A wish to contest is not
evidence: without it the item stays open. A Review that reopens a Contest makes it a dispute, which
the User settles.
_Avoid_: rejection, pushback

**Escalation**:
The Implementer's answer that an item turns on something only the User knows (outside the
repository and the Task file), with the question. It stops the Job before the Review; the User
settles each one, accepting the risk or deciding the fix.
_Avoid_: question to the reviewer, blocker

**Churn**:
A review loop that no longer converges: a fix reopened a second time, or a round whose every
blocker and major item was caused by earlier fixes. It stops the Job with one question to the
User: accept and prepare the MR, continue, or go back to planning.
_Avoid_: loop, ping-pong

**Gate**:
The Codex Review of an Iteration. On a Job with the Claude Review it runs in the same Round as the
Claude Review, at the same time, and the Iteration is Clean only when both verdicts are clean. It
runs by the Codex CLI on the User's ChatGPT plan in a read-only sandbox in the Worktree; its
verdict is acted on by the same rule as the Review's; it is limited in rounds and tokens per Job,
and off when no Codex is found. Its Gate level decides whether it runs on an Iteration. A failed
Gate hands the Job to the User unless the Claude Review of the same Round gives a fix; the Gate
then runs again in the next Round.
_Avoid_: OpenAI reviewer, second opinion

**Gate level**:
How much of the Gate an Iteration gets: `full`, `light` (the Gate runs only while the Job has no
Fix from the Gate) or `none`; decided when the Round starts, before either Review. On a Job
without the Claude Review it is always `full`: the Gate is its only Review. On a Job with it, it is
decided from the risk of the Job's whole change at that Iteration: `full` for a change that
touches a
Sensitive path, a `may_touch` path, a security-relevant or agents' instructions file, is large or
cannot be known; `none` for documentation only. A Gate the level skips leaves the Claude Review to
decide, as with the Gate off.
_Avoid_: risk score, gate mode

**Round**:
The Review of one Iteration: the Claude Review, the Gate, or both in a Joint round. It ends in the
next Fix section, a stop for the User, or Clean.
_Avoid_: review cycle, pass

**Joint round**:
The Review of an Iteration of a Job with the Claude Review in which the Claude Review and the Gate
run at the same time; their fix items make one Fix section.
_Avoid_: parallel review, double review

**Gate yield**:
What the Gate's items were worth: the share of a Job's Gate items (each Ledger entry once, Nits
included) whose entry ended `fixed`, as `sf metrics` shows it per Job and in total. An item both
Reviews of a Joint round raised is one Ledger entry, the Claude Review's: the Gate yield counts
only the items the Gate alone raised, its marginal value.
_Avoid_: gate score, hit rate

**Clean**:
The Round's verdict (in a Joint round both Reviews', else the one that runs), as the factory acts on it, that the
Patch needs no further Fix section (no blocker or major item), with every undeclared Sensitive path acknowledged. It starts MR
preparation (after the Simplification pass, when one runs); it accepts nothing and pushes nothing.

**Simplification pass**:
One read-only Claude session per Job, after the Clean Round of a Job that had a Fix
section: it names what the review fixes added that the Task does not need, never what a fixed
blocker finding needed. Its suggestions go to the User: Simplify (one Fix section "Simplify",
reviewed as usual, the suggestions recorded in the Ledger as the User's choice) or Skip (MR
preparation, the suggestions listed in the MR text). It runs at most once per Job.
_Avoid_: cleanup review, zoom-out, third reviewer

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
