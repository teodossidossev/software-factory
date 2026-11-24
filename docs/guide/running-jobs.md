# Running jobs

This page covers starting a job, what happens in each iteration, the job's page, talking to a
running job, pause, resume, restart, abort and reset, running several jobs at once, and usage limits.

## Starting a job

A job needs a written Task file (not a skeleton) and a running `sf serve`. There are three ways to
start one.

**Start on the board.** On the ticket's Queue card press **Start** (or **Start now** on its page).
A confirmation names the workspace, the ticket and the base branch, and adds the Task check's note
when it is not ready ("Task check: not checked", "stale", "check failed", "not ready: N blocker,
M major") and the tickets it waits for that are not merged yet. Once confirmed, the job's card
appears under Implementing.

**The queue.** Press **Add to queue** on the card (or `sf queue add my-app APP-12 [--at N]`, or ask
the Context owner to `queue_add` it). `sf serve` starts the first queued ticket by itself when:

- fewer than `max_running` jobs run (all workspaces together; the board's "Run up to [− N +] jobs
  at once", `sf queue limit N`, default `SF_MAX_JOBS` = 3),
- its Task check is `ready`, or the Task needs none and has none
  ([Planning](planning.md#the-task-check)), or you pressed *Start anyway* (`sf queue force`),
- every ticket of its `lands_after` is merged, and the ticket of its `builds_on` has a prepared
  commit or is merged,
- the queue is not held (by you, or by a job parked on a usage limit).

It never starts a ticket twice. A start the queue could not make leaves the ticket out of the queue
with "Start failed: <message>" on its card, except one that could not fetch the base
(`fetch_failed`): the ticket keeps its place, and the queue tries again 5 minutes later, then 10,
then every 15 ("start failed (fetch_failed); next try HH:MM"). Reorder by dragging a queued card
(or Alt+↑/↓ while it is focused, `sf queue move my-app APP-12 1`); `sf queue list` shows the queue
with what each entry waits for.

**The command line.**

```sh
sf start my-app APP-12
```

A start by hand (Start, Start now, `sf start`) always goes, whatever the limit, the check or the
dependencies say, and its job counts as running. It is refused when the Task file is a skeleton
(`task_draft`) or a live job of the ticket exists (`job_exists`); the job ends `failed` at once
when the branch exists already (`branch_exists`), a worktree of the ticket is left over
(`worktree_exists`: `sf reset` the ticket) or the base cannot be fetched
([When a job stops](when-a-job-stops.md#jobs-that-could-not-start-failed)). A previous job of the ticket that ended (`failed`, `aborted`, `pushed`) is archived first.

## What happens in a job

1. **Start** (`starting`): the factory fetches `origin <base>`, creates the branch
   `APP-12-<slug of the title>` and its worktree under
   `~/.local/state/software-factory/worktrees/my-app/APP-12` (with submodules when the repository
   has them), copies the Task file and its images in, collects the coding rules once, and starts the
   job's **runner** (`sf run`), a process of its own: stopping or restarting `sf serve` leaves it
   running.
2. **The first turn** (`working`): the Implementer runs `/implement .software-factory/APP-12.md` in
   the worktree, inside Claude Code's sandbox, with the factory's rules (no Git commands, no edits to
   the Task file, the Report template) and the coding rules. A turn may use up to `SF_MAX_TURNS`
   steps; a turn that hits the limit while still changing files goes on by itself
   (`SF_TURN_LIMIT_CONTINUES`).
3. **Publish**: when the session is idle, the factory publishes the iteration: the Report (with the
   changed files, sensitive and out-of-scope paths first), the Patch (the uncommitted difference to
   the base, new files included), and the file list. State `awaiting_review`.
4. **Gate level**: as the round starts, before either review, the gate level is decided. A job
   without the Claude review gets `full` on every iteration: the gate is its only reviewer. On a
   job with the Claude review it comes from the job's whole change: `full` (sensitive or
   `may_touch` paths, security-relevant names, agents' instruction files, more than 400 changed
   lines or 12 files), `light` (the gate runs while it has asked for no fix yet), or `none`
   (documentation only). After a clean round, the level of a later round comes from its delta
   since that round, and a `light` delta runs the gate until the gate asks for a fix after it.
5. **The review round**: by default (`SF_CLAUDE_REVIEW=ticket`) the Codex CLI in a read-only
   sandbox (the gate) reviews the iteration alone. On a ticket whose Task file says
   `review: claude` (with `SF_CLAUDE_REVIEW=always`, every ticket but those that say
   `review: codex`) the round is joint: a fresh read-only Claude session (the Claude review)
   and, when the level says so, the gate review it at the same time. With the gate off
   (`SF_GATE=off`, or no Codex found) the Claude review reviews alone. Each reviewer reads the
   Task file, the Review brief, the rules and the ledger and returns `fix` or `clean` with items,
   each `blocker`, `major` or `nit`; in a joint round the iteration is clean only when both are.
   Once a round was clean, a later round (after your message, a Tests Fix, a fix round) is a
   delta round: the reviewers judge the delta since that clean round, the rest of the change counts
   as accepted, and an item on a file the delta leaves alone is dropped unless the delta breaks that
   code or a message of yours after the clean round asks for it.
6. **Fix**: a verdict of either with a blocker or major item makes one `## Fix N` in the Task
   file: a lead line per reviewer, then each item with its ledger id, `1. [R7, major] …`, and who
   raised it (an item both raised is one item), the nits last, as optional. The next turn runs
   `/implement .software-factory/APP-12.md Fix N` in the same session. The Implementer answers each
   item in its Report as `fixed`, `contested` (with evidence), `escalated` (a question for you) or
   `left` (nits only). Back to step 3.
7. **Clean**: no blocker or major left. For a job that had fix rounds, the simplification pass may
   offer to remove what the fixes added that the Task does not need (`needs_human`,
   `simplify_offered`: Simplify or Skip).
8. **MR preparation** (`preparing_mr`): the Implementer writes the MR text; the factory checks it,
   commits the whole change as one commit with it as the message, and rebases onto the base (a
   conflict goes to the Implementer, and the resolved change back to review).
9. **Ready**: the factory hands the job over to your checkout (`handed_over`), or leaves it in
   `ready_for_human_review`; you are notified. See [Review and merge](review-and-merge.md).

**How far a running job is.** At the start of every turn the Implementer writes its steps as a
checklist in `.software-factory/APP-12.steps.md` of the worktree (in a Fix turn, the fixes) and
ticks each one when it is done; the file never reaches the commit, the Patch or a review. A running
card (Implementing or Reviewing) shows, instead of a Now line: a ring with the steps done (`5/7`;
hover it for the tool calls so far), **Now** (or **Fix round N · now**, or the reviewer's name) with
the current step (the first not ticked) in words, the four phases as chips (Code, Claude, Codex, MR
text: done, now, ahead; Claude struck through on a job without the Claude review), **Ready around
15:04–15:28**, and **Show the N steps**, which opens the list in the card (done struck through, the
current one bold; it stays open until you reload the page). The range comes from the factory's own
history: the quartiles of a working turn and the medians of the reviews and the MR text of the
workspace's finished jobs (every workspace's while it has fewer than 10), with one more fix round on
the top while the job has had none; before the factory has any history of its own, it starts from
typical durations (a working turn 10 to 32 min, a review 2 min, the MR text 1 min). Without a steps
file the card still shows the phase and the range. The job's page shows the same block in its
header, the steps always open.

The limits stop a loop, not hard work: `SF_MAX_ITERATIONS` (3) and `SF_GATE_MAX_ROUNDS` (5, only
on a job with the Claude review) count only the review rounds that made no progress (the open
blocker and major findings did not fall below their lowest, or a fixed or left one came back; the
first round with a Fix sets the low and does not count), and the gate's tokens stop at
`SF_GATE_MAX_TOKENS` (5,000,000) for every started 2,000 changed lines. The ledger's own stops
(escalations, disputes, churn) catch the loops. At a limit stop, Tell it to go on starts the counts
again; a ticket with `important: true` is never stopped by these three limits. See
[When a job stops](when-a-job-stops.md).

## The job's page

A click on a job's card opens its page (the URL becomes `#my-app/APP-12`). The header has *← Board*,
the key, the title, the stop code while it waits on a stop, the switch between the three screens,
and one sentence of where the job is ("The Implementer is working on iteration 2", "Claude and
Codex are reviewing iteration 2", "Writing the MR text", "Reviews are clean and the MR text is
written. Push when you are happy"), the iteration, the estimated cost ("$1.23 so far (Claude,
est.)": an estimate of the API price, not a charge), the elapsed time and the branch with a button
that copies `git checkout <branch>`.

- **Stream** (`s`): one chronological list of everything: the prompts (with *Task* to see the Task
  file and its check), the Implementer's text and each tool call with its result (Enter or a click
  shows input and output), your messages, each Fix section, the Claude review's and the Codex gate's
  verdicts with their findings (ledger id, severity, path, problem, what is expected), the state
  changes, the end of each iteration with its files and its *Report*, and the factory's notes. New
  entries come in live. While the job waits on a stop, its **stop block** says what it waits on.
- **Changes** (`c`): the changed files as a tree (or flat list) on the left, the diff of the selected
  file on the right, per iteration; modified blue, added green, deleted grey. Every path in the
  Stream links here.
- **Merge request** (`m`): the branch, the base, the MR title and description, editable before the
  push; available once Clean wrote the MR text ([Review and merge](review-and-merge.md#editing-the-mr-text)).

At the bottom, the **composer**: the message box and the actions that apply now (the first one is
the primary action; one that is off says why when you hover it).

**Keys.**

| Where | Keys |
| --- | --- |
| Board | `j` / `k` move between cards, Enter opens; Alt+↑ / Alt+↓ move a focused queued card |
| Job page | `s` Stream, `c` Changes, `m` Merge request; Escape goes back (Changes or Merge request → Stream → board) |
| Stream | `j` / `k` select an entry, `G` the last one, Enter opens or closes it |
| Changes | `/` filters the tree, `n` / `p` (or F7 / Shift+F7) the next or previous file, arrows and Enter in the tree |
| Message box | Enter adds a line, Ctrl+Enter sends |
| Merge request, Task file editor | Ctrl+S saves |
| Any page | Shift+P point mode on or off; Escape leaves it |

In a terminal, `sf watch my-app APP-12` shows the same session live (Ctrl+C stops watching, not
the job); `--once` prints what is there and exits.

## Talking to a running job

Type in the composer and press **Send** (Ctrl+Enter), or:

```sh
sf say my-app APP-12 "Use the date helper in src/util/date.ts instead of a new one."
```

- In `working`, the message waits in the session and becomes the next turn.
- In `awaiting_review`, `needs_human` or `ready_for_human_review`, it starts a new turn right away
  (from `ready_for_human_review` the worktree is opened again from the branch, and the prepared
  commit is dropped: the change goes through review and Clean again). Its iteration is reviewed like
  any other, but it is not a Fix section and does not count toward `SF_MAX_ITERATIONS`; at a limit
  stop it starts the limits' counts again.
- In `handed_over` it is **Ask for changes**: your edits in the checkout go back into the job first
  ([Review and merge](review-and-merge.md#ask-for-changes)).
- In `preparing_mr` no message is taken; in `waiting_limit` it is refused (use Resume with a
  message); a paused job takes a message with Resume.
- *Tell it to go on* (on stops) sends the box's text, or "Go on." when it is empty.
- **Send** of a planner's suggestion (*Planner suggests changes* on the job's page, while the job
  waits for you; [Planning](planning.md#back-to-the-planner)) sends the planner's note as your own
  message, exactly as if you had typed it: the same turn, the same Ask for changes on a handed-over
  job, the same weight for the reviewers. Nothing is sent until you press it.
- Your messages (Send, Ask for changes, a Resume's message) are your decisions for the reviewers:
  both see every message up to the iteration they review. Where one differs from the Task file it
  wins, so a reviewer does not flag what you asked for. When a reviewer still raises it, the
  Implementer contests the item by quoting your message instead of asking you again.

## Pause, resume, restart, abort, reset

| Action | Button | Command | Takes | What it does |
| --- | --- | --- | --- | --- |
| Pause | Pause | `sf pause my-app APP-12` | `working`, `awaiting_review` | Stops the turn, review or gate at once (an interrupted review round is thrown away, never a verdict). Worktree, branch, session, iterations and ledger stay. A paused job does not count as running. |
| Resume | Resume | `sf resume my-app APP-12 [message…]` | `paused`, `waiting_limit` | Goes on where it stopped: the same session continues the turn (with your message, or "Continue where you stopped."), or the interrupted review round runs again (a message is refused then). A Task file you changed while paused goes to the Implementer as its diff and to the reviewers as the new file. |
| Restart | Restart… (with *Keep the files*) | `sf restart my-app APP-12 [--keep-files]` | `paused`, `waiting_limit`, `aborted`, `failed`, `needs_human` | A new job from the current Task file on a fresh worktree and branch; the old job is archived. Its branch is deleted only when it has no commits and was never pushed, else the restart is refused (`restart_refused`). `--keep-files` copies the old worktree's changed files into the new one first. |
| Abort | Abort… (with *Also discard*) | `sf abort my-app APP-12 [--discard]` | every state that has not ended | Ends the job (`aborted`). The branch and the worktree stay (its path is printed); `--discard` removes both. On a handed-over job only without `--discard`: your checkout stays as it is. |
| Reset | Archive on a Done card or a finished job's page (asks first; with an active Task file, it archives the Task file too) | `sf reset my-app APP-12` | every state but `handed_over` (Archive: `pushed`, `aborted`, `failed`) | Ends the session, removes the worktree and archives the job directory; the branch and its commits are not touched. Use it to clear a leftover worktree (`worktree_exists`). |

Pause, Resume, Restart and Ask for changes are your own actions: the queue's limit never holds
them. Notifications tell you when a job pauses, parks, stops, is ready or pushed.

## Several jobs at once

Each job has its own worktree, branch, session and runner, so several tickets run at the same time,
in one workspace or several. The queue's limit `max_running` (1 to 20) counts the running jobs of
every workspace together; it bounds only the queue's own starts. The workspace's Git operations
(fetch, worktree add and remove, the commit and rebase, the push) are serialized by a lock per
workspace; everything else runs in parallel. Your Claude and Codex plans' usage limits are shared by
all jobs: more parallel jobs reach them sooner.

## Usage limits and Waiting for limits

When a Claude session (the Implementer, the review, the simplification pass) or the Codex gate hits
your plan's usage limit ("You've hit your 5-hour limit · resets 3am"), the job does not fail: it is
**parked** in `waiting_limit` (board: "Waiting for limits · resets at 03:00", "Iteration N · parked,
holds its slot"). The interrupted turn or review round is thrown away and runs again later.

- A parked job keeps its slot in `max_running`, and while any job is parked **the queue starts
  nothing** (the board says "Queue held: usage limit, resets at 03:00"). Jobs already running go on.
- The reset time is read from the message; without one the queue tries again 30 minutes later.
- At the reset the queue's rule applies: `resume-then-queue` (default), `resume-only` or `wait`
  ([Configuration: queue settings](configuration.md#queue-settings)); set it with
  `sf queue on-limit <rule>` or the board's *Rules ▾*.
- You may resume a parked job at any time: *Resume now*, `sf resume my-app APP-12 [message]`
  (a message only when it was parked in a turn). Abort, reset and restart work as for a paused job;
  `sf say` and `sf pause` are refused.
- MR preparation and the Task check are not parked: they stop as usual (`session_failed` with the
  limit's message, or a failed check).

The details: [Jobs](../../factory/README.md#jobs),
[Pause, Resume and Restart](../../factory/README.md#pause-resume-and-restart),
[Usage limit](../../factory/README.md#usage-limit-waiting_limit),
[Run queue](../../factory/README.md#run-queue), [Dashboard](../../factory/README.md#dashboard).

Next: [Review and merge](review-and-merge.md).
