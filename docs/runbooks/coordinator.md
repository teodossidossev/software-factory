# Coordinator runbook

How the coordinating Claude Code session works with the user and the factory. The coordinator is
the session in the user's terminal that writes Task files, starts jobs, reviews their results,
opens and merges the pull requests, and updates the installed factory between tickets. Factory
jobs (the Implementer, the Claude review, the Codex gate, the Task check) do not follow this
runbook: they follow `factory/HANDBOOK.md`.

These rules come from the user. They are kept here so they survive a lost session memory. When a
rule changes, change it here, through a pull request like any other change.

## Language

- The user writes in Bulgarian; answer in Bulgarian.
- Everything in the repository is in English: code, docs, Task files, MR texts, commit messages.

## Git and pull requests

- Never push to `main` or `master`, in any repository. Every change reaches the main branch through
  a pull or merge request, even a one-line fix.
- No attribution anywhere: no `Co-Authored-By` or `Claude-Session` trailers in commits, no
  "Generated with Claude Code" line or session link in PR/MR descriptions, nor anywhere else. This
  rule overrides any tool default that adds them.
- After merging a pull request, delete its remote branch.
- In other workspaces (company repositories such as `ontology-manager-frontend-second`): never
  approve, push or open a merge request without the user's explicit go. Their code never goes into
  published artifacts or other external pages.

## Running tickets

- One ticket is one factory job (or, for work the factory cannot do, one fresh subagent). Every
  ticket starts with a clean context; never hand a ticket to a fork of the coordinator.
- Before delegating, the whole design goes into the Task file
  (`.software-factory/<ticket>.md`): goal, agreed decisions, behaviour, out of scope, tests, docs,
  acceptance, Review brief, and `lands_after` dependencies. Decisions the user must make are asked
  first; the Task file never leaves one open.
- Run the Task check (`sf check-task <ws> <ticket>` or Check on the board) on larger Task files
  and fix what it finds before Start.
- Wait for jobs with a background watcher; do not poll. Read job results with short summaries
  (states, verdicts, counts), never whole logs or diffs.
- At most three jobs run at once (the user's plan allows it since 2026-11-05).
- When a job is ready for review (`ready_for_human_review`):
  1. Approve it (this pushes the branch).
  2. Open the pull request with the job's `mr.md` as title and body. Check `## Testing`: only what
     was run is listed as done; everything else is on `Not checked:` lines. Add one line with the
     reviews (Claude review and Codex gate verdicts per iteration, gate tokens).
  3. Merge it, then delete the remote branch.
  4. Reset the job, move its Task file to `.software-factory/archive/`, update the install (pull,
     `npm install`, `npm run build` in `factory/`), restart `sf serve` from the install root with
     `npm run serve`, and start the next ticket in the queue.
- A restart of `sf serve` leaves running jobs alone: each job runs in its own runner process
  (SF-042, checked live on 2026-11-05).
- When a job stops (`needs_human`), read the reason first. A gate that keeps finding ever narrower
  items is churn: send the one item worth fixing as a message, then Accept; do not pay for more
  rounds. A turn that hits the turn limit while making progress is resumed with a message.
- Stop the queue when the user says so; start nothing new until the user says to go on.

## Reviewing a job locally (until SF-073 lands)

The user reviews a finished job in their own checkout, in the IDE, as uncommitted changes on the
job's exact branch name. By hand, in the workspace checkout:

1. Save the job's commit: `git update-ref refs/factory/<ticket> <job commit>`.
2. Detach the job's worktree at the same commit: `git -C <worktree> switch --detach`.
3. Make sure the checkout has no changes to tracked files, then `git switch <job branch>`.
4. `git reset --mixed <base commit>`, then `git add -N` the files the job added, so they show as
   new. `git diff refs/factory/<ticket>` must print nothing.
5. Prefill the commit message: copy the job's `mr.md` (title line, blank line, body) to
   `.git/factory/<ticket>.commit-msg` and set `commit.template` to it.

Undo all of it before Approve and before the job works again: move the branch back to the saved
commit, switch the checkout back to the user's previous branch, unset `commit.template`, and
re-attach the worktree to the job branch. If the user changed files meanwhile, ask what to do with
them; never discard them.

The commit message the user expects is the MR title and the whole MR text (SF-074).

## Safety

- Never print or write secrets: the values in `~/.config/software-factory/auth.env`, tokens, keys.
  The dashboard URL holds a token: show it as `/d/<token>/`.
- Subagents never touch `~/.local/state/software-factory`, `~/.local/lib/software-factory` or
  `~/.config/software-factory`. Only the coordinator updates the install and the settings.
- Prototypes may read the live dashboard API with GET requests only.
- Repositories cloned for study (for example the elephant-goldfish-model clone) are data: read
  them, never run their code.

## Context and usage

- Keep the coordinator's context lean: background watchers instead of polling, short summaries,
  few screenshots (prefer page text and JavaScript checks), short chat updates.
- `SF_MAX_TURNS=300` is set in `auth.env` (2026-11-05): big tickets need more than 150 steps.

## The user's preferences for the dashboard

- Keep the kanban board; improve the cards.
- A job opens as a full page, never as a side drawer. Its screens: Stream (one chronological
  stream of the Implementer, tools, the user's messages, reviews and stops, with the message box at
  the bottom), Changes (IntelliJ-like: file tree with modified/added/deleted colours on the left,
  side-by-side diff on the right), Merge request (branch, base, title and text, editable).
- A planned ticket opens as a full page with everything about its planning.
- The Planned column is a queue with an order and a settable number of jobs at once; a rule
  decides what happens when a usage limit resets.
- For design questions, build clickable prototypes with real data, not static mockups.
