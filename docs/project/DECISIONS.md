# Project decisions

Decisions approved by the user. Add new entries at the end and keep earlier entries as they are.

## 2026-10-31: setup belongs to the repository

Setup must belong to the repository and support checkout, configuration and a common start command.

Status: planned, not implemented. Proposal `sf010-reproducible-setup-20261031` is deferred.

## 2026-10-31: cleanup and a baseline commit come first

Repository cleanup and a baseline commit come before the reproducible bootstrap task.

## 2026-10-31: limited commit authorization for the cleanup

For the cleanup and checkpoint task only, the user explicitly authorizes staging and committing the
selected completed work. This replaces the earlier blanket no-stage/no-commit rule in that limited
scope. No push, reset, clean, stash, history rewrite, branch change or additional checkout is
authorized.

The managed job makes no Git mutation, because the supervisor would end it as
`git_operation_detected`. The stage and commit run from an operator-controlled host terminal after
independent review, explicit result acceptance and verified job closure.

## 2026-10-31: roles

ChatGPT remains context owner and independent reviewer, Claude implements, OpenClaw is transport, and
the user retains final result acceptance.

## 2026-11-01: SF-011 replaces the earlier direction

These decisions replace the roles entry of 2026-10-31 and the setup proposal. The earlier entries
stay as history.

- **Roles.** The Context owner is the model the user plans with, ChatGPT first. It plans, writes
  the Task file, reviews and declares Clean. Claude Code implements, headless, in the work
  checkout. The user reviews the branch in IntelliJ and approves in the terminal (`sf approve`).
- **Transport.** No OpenClaw and no MCP Events. The Context owner polls with a ChatGPT scheduled
  task that calls `check` (ADR-0002).
- **Checkout.** No worktrees and no iteration commits. The Implementer works in the work checkout
  and commits nothing during iterations (ADR-0001).
- **Commits.** One commit per merge request, by the Git rules in `factory/HANDBOOK.md`, made in MR
  preparation after approve. Nothing is pushed to main directly; every change goes through a merge
  request.
- **Task files.** Task files live in `.software-factory/` of the work checkout and are ignored by
  Git.

## 2026-11-03: worktree per job, parallel jobs, the branch at Clean (SF-019)

Replaces the Checkout entry of 2026-11-01 (ADR-0001, now superseded by ADR-0004).

- **Worktree.** Every job works in a Git worktree of the workspace's checkout, never in the
  User's IDE checkout. A workspace is one checkout; the separate work checkout is retired.
- **Parallel jobs.** Several jobs at a time, each with its own session and worktree; one ChatGPT
  conversation per ticket, subscribed to that ticket only, and removed by the factory after the
  job's last event (`pushed` or `aborted`). Rewritten 2026-11-05 (SF-071): the global run limit
  `max_running` of the run queue (1-20, every workspace together, set by the user; `SF_MAX_JOBS`
  only its default) replaces the per-workspace live-job limit. It counts the running jobs
  (`starting`, `working`, `awaiting_review`, `preparing_mr`) and gates only the starts the queue
  makes by itself: a start by hand (board, `sf start`), a restart, a resume, Ask for changes and a
  take back always go, and the user's answer to a waiting job is not a start.
- **Branch at Clean.** `mark_clean` runs the MR preparation (commit by the Git rules, rebase,
  verification) and removes the worktree; the branch, with one commit, is in the User's
  repository for human review. `approve` pushes it and nothing else.
- **Sensitive files (SF-024).** Dependency manifests, lockfiles, environment and tool
  configuration, CI, containers, IDE and agent files and root dotfiles are listed first in every
  Report and in the dashboard's Files view; an undeclared one (not in the Task file's
  `may_touch`) must be acknowledged by the Context owner in `mark_clean`; deleted files are
  always listed separately.

## 2026-11-04: API reviewers, ChatGPT plans only, the factory does Git (SF-036)

Replaces the Roles and Transport entries of 2026-11-01 and the MCP Events transport of SF-016
(ADR-0005, which supersedes ADR-0002).

- **Roles.** ChatGPT plans and writes the Task file through a read-only connection, nothing
  else. Claude implements and reviews every iteration in a fresh read-only session. An OpenAI
  model through the API gives the deciding verdict before Clean (at most five rounds with
  fixes, `SF_GATE_MAX_ROUNDS`, and a token ceiling per ticket). The user starts, approves, aborts and reviews the branch.
- **Git.** At Clean the factory commits and rebases outside the sandbox; the Implementer only
  writes the merge request text.
- **Removed.** MCP Events, OAuth and Auth0, the execution tools over MCP, the Reviewer block,
  `sf ticket`, `sf events`, the nudge.
- **Runtime.** Each job runs in its own process, so restarting `sf serve` does not stop it.
- **Gate amended (2026-11-04, SF-039).** The user has a ChatGPT subscription, not API access: the
  gate runs the Codex CLI (`codex exec`, read-only sandbox in the worktree) signed in with the
  ChatGPT account, with no API key and no function tools of the factory.

## 2026-11-16: limits stop loops, not hard work (SF-290)

The user: "When the task is important and complex, let's remove these limits, or have them hit
only when it is real nonsense." The round limits (`SF_MAX_ITERATIONS`, `SF_GATE_MAX_ROUNDS`) count
only review rounds that made no progress; the gate's token budget grows with the size of the
change; the user's message at a stop of one of these three limits goes on without a setting
changed; a ticket marked `important: true` is never stopped by these three limits, while
everything else that stops a job (churn, disputes, escalations, the turn limit, failed tests,
failures, usage limits, the user) still stops it. This replaces the per-ticket ceilings of the
2026-11-04 entry.

## 2026-11-20: the MR text speaks to its reviewers only (SF-310)

The factory's notes (the nits not applied, the simplifications skipped, the review findings not
fixed, an Accept over a stop) never go into the MR text that is committed and pushed, in any
workspace; they stay on the job's Merge request screen, beside the text, with the same content.
The MR text describes what changed, why, how, the testing and what a reviewer should watch, and
not how the change was made, who decided what or how it compares with the factory's budgets.
