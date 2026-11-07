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
- In other workspaces (product repositories, for example the user's company repositories): never
  approve, push or open a merge request without the user's explicit go. Their code never goes into
  published artifacts or other external pages.

## Running tickets

- One ticket is one factory job (or, for work the factory cannot do, one fresh subagent). Every
  ticket starts with a clean context; never hand a ticket to a fork of the coordinator.
- Before delegating, the whole design goes into the Task file
  (`.software-factory/<ticket>.md`): goal, agreed decisions, behaviour, out of scope, tests, docs,
  acceptance, Review brief, and `lands_after` dependencies. Decisions the user must make are asked
  first; the Task file never leaves one open.
- **Lean Task files.** About 800 words for a change under 300 lines, 1,200 words up to 1,000
  lines; split anything larger. The content: goal and agreed basis, decisions, behaviour as
  outcomes, out of scope, tests as cases, acceptance, `scope:` and a Review brief. No pseudo-code:
  name the files and the interfaces the plan decides on, never the statements. Product tickets
  carry `check: required`. A small, scoped Task (up to 10 `scope:` paths without globs, no
  `lands_after` ticket of another workspace, at most 1,200 words) starts without a plan check;
  every other one is checked by itself after its write, and you fix what the check finds before
  Start. Check on the board or `sf check-task <ws> <ticket>` runs one in any case.
- **Reviewers (experiment from the merge of SF-131, two weeks).** The Codex gate is the main
  reviewer; the Claude review runs only on tickets with `review: claude` in the front matter
  (`SF_CLAUDE_REVIEW=ticket`), and fix rounds are capped at 3 (`SF_MAX_ITERATIONS`). Give
  `review: claude` to risky tickets: authentication, the sandbox, the state format, and the product
  tickets the user names. At the cap, Accept takes the iteration with its open findings listed in
  the MR text. After the two weeks, compare cost and findings with the user (SF-132's Stats) and
  decide whether it stays.
- **Placeholders.** No company or person names in this repository's Task files, MR texts and
  commits. Use placeholders: `product-frontend` for a repository, `ABC-n` for a ticket, "the user"
  for a person.
- Wait for jobs with a background watcher; do not poll. Read job results with short summaries
  (states, verdicts, counts), never whole logs or diffs.
- At most three jobs run at once (the user's plan allows it since 2026-11-05).
- The run queue starts tickets by itself (`sf queue add <ws> <ticket>`, `sf queue list`,
  `sf queue limit N`); it starts a ticket only when its plan check says ready or is not needed
  (`sf queue force` to override) and its `lands_after` tickets are merged.
- When a job of `software-factory` is ready for review (`ready_for_human_review`):
  1. Do not edit its `mr.md`: the push must carry exactly the prepared commit's message (SF-080).
  2. `sf mr create software-factory <ticket>`, then `sf mr merge software-factory <ticket>`.
  3. Only after the merge succeeded: reset the job, move its Task file to
     `.software-factory/archive/`, delete the remote branch, then `sf update`, which drains the
     running jobs, pulls, builds, typechecks, restarts the service and runs `sf smoke` (it must
     say `smoke: PASS`); a failed build rolls back by itself and says `update_failed`. Then run
     the full test suite (`npm test` in `factory/` of the coordinator's checkout of `main`) in the
     background; if it fails, hold the queue (`sf queue hold`) and tell the user.
- Add a new key to `workspaces.json` or `auth.env` only when no job that started before the install
  update is still running: a runner keeps the code it started with, and an unknown key stops it.
- A restart of `sf serve` leaves running jobs alone: each job runs in its own runner process
  (SF-042, checked live on 2026-11-05). `sf serve` runs as the systemd user service
  (`sf service status`; logs: `journalctl --user -u software-factory`).
- When a job stops (`needs_human`), read the reason first. A gate that keeps finding ever narrower
  items is churn: send the one item worth fixing as a message, then Accept; do not pay for more
  rounds. A turn that hits the turn limit while making progress is resumed with a message.
- Stop the queue when the user says so; start nothing new until the user says to go on.

## Reviewing a job locally

Since SF-073 the factory hands a finished job of a product workspace to the user's checkout by
itself (`handoff` per workspace in `workspaces.json`; it is `off` for `software-factory`): the job's
exact branch, its changes as uncommitted Local Changes, the commit message prefilled with the MR
text. The user reviews, edits, pushes and opens the MR from the IDE, or uses Ask for changes, Take it
back or I opened the MR myself on the board. Never take a job back from the user's checkout unless
the user asks; never discard their files.

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
