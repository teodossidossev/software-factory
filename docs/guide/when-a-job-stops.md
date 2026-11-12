# When a job stops

This page lists every reason a job can stop and wait for you, in plain words, with what to do for
each: the button on the dashboard and the `sf` command.

## Reading a stop

A job that stops for you is in `needs_human` with a **code**; a job that could not even start is
`failed` with a code. You see the code:

- on the board: the card moves to **Your turn** with the reason in plain words, the code as a small
  tag and one button; a **decision** (the factory needs your choice; nothing failed) is never red,
  an **error** is;
- on the job's page: the stop block in the Stream ("Your decision" or "Stopped"), the sentence in
  the header, and the actions in the composer, the first one primary;
- in the terminal: `sf status` (the `ERROR` column) and `sf status my-app APP-12` (the message below
  the table); you also get a desktop or ntfy notification.

Always read the message first: it names the findings, the files, the limit or Git's own words.

One table in the factory decides each stop: its kind (decision or error), the codes that share it
(for example `mr_rebase_failed` is shown as `mr_failed`), and the actions it offers, each shown only
while it applies (Accept with a clean Claude review, Retry never after a conflict turn). The board,
the job's page, the stop's plain explanation and the factory's own checks all read it, so a button
you see is one the command takes; the factory still checks every action again when you press it.
A code the table does not know shows as "Stopped" with Send and Abort.

## The actions

| Action | Button | Command | What it does |
| --- | --- | --- | --- |
| Send a message | Send; *Tell it to go on* (sends "Go on." when the box is empty) | `sf say my-app APP-12 "<message>"` | A new Implementer turn in the same session; its iteration is reviewed as usual. Works on any `needs_human` stop. |
| Accept | Accept and prepare MR…; Skip (for the simplification pass) | `sf accept my-app APP-12` | Go on to MR preparation over a stopped gate, a ledger stop or a stop of the workspace's tests (`tests_failed`, `tests_unavailable`: without passing tests, and the MR text says so under `### Checks`) when the last Claude review of the iteration is clean, or when the job has no Claude review (the Codex gate alone reviews it, `SF_CLAUDE_REVIEW`); at the Fix round limit whatever the last verdict. The items not applied are recorded, shown on the Merge request screen and listed in the MR text (under "Accepted over a stop", with "No reviewer passed iteration N." when only the gate reviewed and it failed or ran out of budget), and the nits and the ledger's findings not fixed go into the MR text too. |
| Settle a finding | *Accept risk* / *Must fix* on the finding | `sf settle my-app APP-12 R7 accept\|fix [note…]` | Accept an escalated or contested finding as a risk, or decide that it must be fixed, at an `escalated`, `review_disputed` or `review_churn` stop. After the last one at `escalated` or `review_disputed` the job goes on by itself; at `review_churn` the decision is only recorded and the job waits for you. |
| Retry the review | Retry review | `sf review my-app APP-12` | Runs the failed Claude review again on the same iteration. |
| Retry MR preparation | Retry | `sf retry my-app APP-12` | MR preparation again, without a new review. |
| Simplify | Simplify… | `sf simplify my-app APP-12` | One Fix section "Simplify" from the simplification pass's suggestions. |
| Push again | Push again | `sf approve my-app APP-12` | The push again, after a failed push. |
| Restart | Restart… | `sf restart my-app APP-12 [--keep-files]` | A new job from the current Task file on a fresh worktree and branch. |
| Abort | Abort… | `sf abort my-app APP-12 [--discard]` | Ends the job; the branch and the worktree stay (`--discard` removes both). |
| Raise a limit | | edit `~/.config/software-factory/auth.env`, restart `sf serve`, then act | A stopped job's next runner starts with `sf serve`'s settings, so restart `sf serve` before you answer the job. |

## Decisions: the factory needs your choice

| Code | Card says | What it means | What to do |
| --- | --- | --- | --- |
| `escalated` | Question for you · Answer N questions | The Implementer answered a finding as `escalated`: it turns on something only you know. The questions are in the message and on each finding. | Settle each one: *Accept risk* (`sf settle … R7 accept`) or *Must fix* (`sf settle … R7 fix "use the UTC date"`). When nothing is left to settle the job goes on by itself (a Fix section for the "must fix" ones, else the review again). Or answer with Send. |
| `implementer_question` | Question for you before any change · Answer | The Implementer changed nothing and asks something: its Report's "Open questions" are in the message (at most 400 characters; the whole Report is on the job's page). The factory stops at MR preparation instead of looking for an MR text. | Read the question, answer with Send a message (`sf say`): the Implementer goes on with a new iteration. Or Abort. |
| `review_disputed` | A reviewer disputes a contest · Settle N findings | The Implementer contested a finding with evidence, and a reviewer raised it again. | Settle each disputed finding (*Accept risk* / *Must fix*); the job goes on by itself. With a clean Claude review you may instead Accept and prepare MR. |
| `review_churn` | Fixes keep making findings · Decide N findings | The loop no longer converges: a fixed finding was reopened a second time, or every blocker and major of a round was caused by earlier fixes. | One question, three answers: Accept and prepare MR (`sf accept`, with a clean Claude review), continue (`sf say` with the one thing worth fixing; a settlement here is only recorded), or back to planning (`sf abort`, rewrite the Task file, `sf restart`). |
| `gate_rounds` | Codex round limit reached · Decide N findings | The Codex gate asked for more fix rounds than `SF_GATE_MAX_ROUNDS` (default 5); the last fix was not applied. | If Claude is clean and Codex keeps finding ever narrower variants: send the one item worth fixing, or Accept and prepare MR. To allow more rounds, raise `SF_GATE_MAX_ROUNDS` and restart `sf serve`, then Send. |
| `gate_budget` | Codex token budget used up · Decide | The gate's tokens for this job reached `SF_GATE_MAX_TOKENS` (default 5,000,000). | Accept and prepare MR (with a clean Claude review), or raise `SF_GATE_MAX_TOKENS`, restart `sf serve` and Send. |
| `iteration_limit` | Fix round limit reached · Give a direction | The reviewers asked for a Fix section beyond `SF_MAX_ITERATIONS` (default 3). The refused findings stay open in the ledger; the stop lists the open blocker and major ones. | Accept and prepare MR takes the iteration as it is, whatever the last verdict: the open findings go unapplied and are listed in the MR text. Or send a direction (your message does not count as a Fix section), raise `SF_MAX_ITERATIONS` and restart `sf serve`, or Restart… with a better Task file. |
| `max_turns` | Turn limit reached · Tell it to go on | A turn used all `SF_MAX_TURNS` steps (default 150) without changing files, while repeating a call, or twice in a row. A turn that was making progress goes on by itself `SF_TURN_LIMIT_CONTINUES` times first. | *Tell it to go on* (`sf say … "Go on."`), or with a hint. For big tickets raise `SF_MAX_TURNS` (for example 300). |
| `tests_failed` | Tests keep failing · Decide | The workspace's `test_command` still failed after two Tests Fix rounds (the Implementer got the command and the end of its output each time). The message names the command and the exit code (or the timeout). | Accept and prepare MR (`sf accept`, with a clean Claude review, or on a job without the Claude review): the MR goes on without passing tests, and its `### Checks` says so. Or tell the Implementer what to do (Send): its iteration is reviewed and the tests run again. A Tests Fix does not count toward `SF_MAX_ITERATIONS`. |
| `simplify_offered` | Simplification offered · Simplify or skip | After a job with fix rounds was found clean, the simplification pass names what the fixes added that the Task does not need. | Simplify (`sf simplify`: one Fix section "Simplify", reviewed as usual) or Skip (`sf accept`: MR preparation, the suggestions listed in the MR text). `SF_SIMPLIFY=off` turns the pass off. |

## Errors of the Implementer's turn

| Code | Card says | What it means | What to do |
| --- | --- | --- | --- |
| `session_failed` | Implementer session failed (Usage limit reached when the message is a usage limit) | The Claude Code session errored or ended without a result. A usage limit normally parks the job instead (`waiting_limit`); during MR preparation it stops here. | Read the message; *Tell it to go on* (`sf say`), or Restart…. After a usage limit, wait for the reset and then tell it to go on. Check that `claude` is still logged in. |
| `turn_failed` | Implementer session failed | The turn ended with an error result other than the turn limit. | As `session_failed`. |
| `permission_mode_mismatch` | Implementer session failed | The session did not report permission mode `auto` (your Claude Code settings or version forbid it). | Check your Claude Code settings (`~/.claude/settings.json`, managed settings) and version, then *Tell it to go on* or Restart…. |
| `sandbox_unavailable` | Sandbox unavailable | Claude Code's sandbox could not start (on Linux it needs bubblewrap). | Install or fix the sandbox (see [Install](install.md#prerequisites)), then *Tell it to go on*. |
| `publish_failed` | Iteration not published | The factory could not write the iteration's Report and Patch (a disk or Git error). | Fix the cause in the message (disk space, permissions), then *Tell it to go on*. |
| `serve_restarted` | Interrupted by a restart | `sf serve` started while the job was `working` and its runner was gone (the machine rebooted, the runner was killed). The session is kept. | *Tell it to go on*, or Restart…. |
| `branch_in_checkout` | Stopped | A turn was refused because your checkout has the job's branch checked out (or the worktree could not be put back on it). | Switch your checkout to another branch, then Send. |

## Errors of the reviewers

| Code | Card says | What it means | What to do |
| --- | --- | --- | --- |
| `review_failed` | Claude review could not run · Retry review | The Claude review errored, ran out of its steps, or gave no valid verdict. | Retry review (`sf review`). Refused with `review_off` when `SF_REVIEW=off`. If it keeps failing, raise `SF_REVIEW_MAX_TURNS` and restart `sf serve`. |
| `gate_failed` | Codex gate gave no verdict · Decide | The Codex CLI exited with an error, timed out (`SF_GATE_TIMEOUT_MS`), or wrote no valid verdict. | Check `codex login` and the message; then *Tell it to go on* (the iteration is reviewed again), or Accept and prepare MR when Claude is clean. |

## Errors of MR preparation

| Code | Card says | What it means | What to do |
| --- | --- | --- | --- |
| `mr_text_missing` | MR text missing or invalid · Tell it to fix it | The Implementer wrote no `.software-factory/<ticket>.mr.md`, or an empty one. | Send ("Write the MR text."). |
| `mr_text_invalid` | MR text missing or invalid · Tell it to fix it | The MR text breaks the rules: over 64 KiB, a title that is not `<type>(<ticket>): <summary>` (at most 72 characters, no trailing period), a missing required heading, or a manual check claimed as run in `## Testing`. | Send with the rule from the message. |
| `mr_empty` | Nothing to commit · Tell it what is missing | The reviewed change has nothing to commit against the base. | Send what is missing, or Abort. |
| `mr_conflict` | Rebase conflict · Tell it how | The rebase onto the base conflicted and the Implementer's conflict turn failed, left markers, or the rebase would not continue. When the continue failed, the resolution is saved as `iterations/NNN/conflict-resolution.diff` (named in the message). | Send how to resolve it, or apply the saved patch by hand. Never retryable. |
| `mr_commit_failed` | MR preparation failed · Retry | `git commit` failed, for example without a Git identity (`user.name`, `user.email`) or with a signing problem. | Fix your Git configuration, then Retry (`sf retry`). |
| `mr_rebase_failed` | MR preparation failed · Retry | `git rebase` failed without conflicts; it was aborted. | Retry. |
| `mr_failed` | MR preparation failed · Retry | The factory failed during MR preparation. | Retry, or *Tell it to go on* (the iteration is reviewed again). |
| `mr_serve_restarted` | MR preparation interrupted · Retry | `sf serve` started while the job was `preparing_mr` and its runner was gone. | Retry. |
| `mr_interrupted` | MR preparation interrupted · Retry | You paused the job just as MR preparation began. | Retry. |
| `fetch_failed` | Fetch failed · Retry | `git fetch origin <base>` failed or took over 60 s (at Clean). | Check the network and your Git credentials, then Retry. |
| `guard_hit`, `guard_terms_invalid`, `guard_failed` | Guard stopped the MR · Retry | The guard found text that must not be published, or could not read its terms or `auth.env` ([Configuration: the guard](configuration.md#the-guard)). | Tell the Implementer how to word it (Send), or fix the file and Retry (`sf retry`). |
| `tests_unavailable` | Tests could not run · Retry | The workspace's `test_command` could not run: `bwrap` (bubblewrap) is missing or its sandbox did not start, or the command exited with 126 or 127 (not executable, not found). The reason is the message's first line. | Fix it on this machine (install bubblewrap, install the dependencies in the worktree, correct `test_command` in `workspaces.json`), then Retry (`sf retry`): the tests run again. Or Accept and prepare MR without tests, or Send. |

After a conflict turn there is no Retry (the resolution was not reviewed yet): use *Tell it to go
on*. Another stop's code with a failed MR text turn (`session_failed`, `max_turns`, …) is handled as
in the turn table above.

## Push errors

| Code | Card says | What it means | What to do |
| --- | --- | --- | --- |
| `mr_push_failed` | Push failed · Push again | `git push origin <branch>` failed or took over 120 s (credentials, network, a rejected push). The MR text stays editable. | Fix the cause in Git's message, then Push again (`sf approve`, or `sf retry`). |
| `mr_push_protected` | Push refused · Open the job | The branch is named `main`, `master` or like the job's base: the factory never pushes there. | On the Merge request screen rename the branch (or change the base), then Approve. |

A failed push of a **handed-over** job does not stop it: the job stays `handed_over` with the error
shown; Approve again, push from your IDE, or Take it back.

## Hand-over interruptions

| Code | Card says | What it means | What to do |
| --- | --- | --- | --- |
| `handover_interrupted` | Stopped | A hand-over was cut off (a crash, a restart) and could not be undone safely; the message says where the branch, the saved ref `refs/factory/<ticket>` and the worktree are. | Look at your checkout as the message says; restarting `sf serve` repairs what it safely can. Then Send or Abort. |
| `ask_interrupted` | Stopped | `sf serve` restarted during Ask for changes. Your edits are in the job's worktree (the snapshot is `refs/factory/<ticket>-ask`). | Send (`sf say`) to go on. |

## After a usage limit

A job whose session hits your plan's usage limit is not stopped but **parked** (`waiting_limit`,
"Waiting for limits · resets at 03:00"), and the queue resumes it at the reset by its rule
([Configuration: queue settings](configuration.md#queue-settings)). Two stops can follow:

| Code | What it means | What to do |
| --- | --- | --- |
| `worktree_missing` (or another code in the message) | The automatic resume at the reset failed, for example because the worktree is gone. | Restart… or Abort…. |
| `resume_failed` | The automatic resume failed for another reason (in the message). | Restart… or Abort…. |

Under the rule `wait`, a parked job shows "Limit reset: resume?" with *Resume*; nothing is stopped.

## Jobs that could not start (`failed`)

These codes end the job in `failed` while it was `starting`. The card goes back to the Queue
column with "last job failed"; its page has Restart… and Archive (which asks first). Fix the cause, then Restart…
(`sf restart`) or Start again.

| Code | What it means | What to do |
| --- | --- | --- |
| `base_not_found` | The Task file's `base` branch does not exist locally or on `origin`. | Fix `base:` in the Task file, then Start. |
| `fetch_failed` | `git fetch origin <base>` failed or took over 60 s. | Check the network and credentials, then Start. |
| `branch_exists` | The branch `<ticket>-<slug>` already exists in your checkout. | Delete or rename that branch (`git branch -D`), or change the title, then Start. |
| `worktree_exists` | A worktree directory or registration of the ticket is left over. | `sf reset my-app APP-12` removes it, then Start. |
| `invalid_ticket` | The branch name made from the ticket is not valid. | Change the ticket key. |
| `start_failed` | `git worktree add` or `git submodule update` failed. | Read Git's message; often a stale `.git/config.lock` or a submodule that cannot be fetched ([Troubleshooting](operations.md#troubleshooting)). |
| `rules_failed` | The coding rules could not be collected or stored (an unreadable rules file). | Fix the file (`sf rules my-app` shows the problem), then Restart…. |
| `serve_restarted` | `sf serve` restarted while the job was starting. | Restart…. |

An aborted job may carry `discard_failed`: `sf abort --discard` could not remove the worktree or
the branch. Remove them by hand (`git worktree remove`, `git branch -D`) or Archive the job (on its
Done card or its page), which removes the worktree and leaves the branch.

## When the hand-over did not happen

These are not stops: the job is `ready_for_human_review` and the reason shows next to *Hand over
to my checkout* (`handoff_skipped`). Fix the cause and press it (`sf handover my-app APP-12`), or
push from the dashboard instead.

| Code | What it means | What to do |
| --- | --- | --- |
| `handoff_sensitive` | The change touches files your IDE or tools may run by themselves (a Gradle or Maven build file, the Gradle or Maven wrapper, `.vscode/tasks.json`, `.claude/` settings, Git hooks such as `.husky/`; every path the [sensitive-path list](../../factory/README.md#marked-paths) and `SF_SENSITIVE_PATHS` name). The message names up to five of them. "could not list the change's files" means the factory could not tell, so it did not hand over either. | Read those files in the job's diff on the dashboard, then hand it over yourself (*Hand over to my checkout*, `sf handover`), or push from the Merge request screen. |
| `handoff_off` | Hand-over is off for the workspace (`handoff: "off"`) or by `SF_HANDOFF=off`. | Nothing; push from the Merge request screen, or hand it over by hand. |
| `checkout_dirty` | Your checkout has changes to tracked files. | Commit or stash your own work, then hand over. |
| `checkout_busy` | A rebase, merge, cherry-pick or revert is in progress in your checkout. | Finish or abort it. |
| `handover_refused` | A file in your checkout is in the way (also an ignored one), Git refused the switch, or the checkout is already on the job's branch. | Move the named files, then hand over. |
| `handover_mismatch` | After the hand-over the checkout did not hold the job's commit; everything was put back. | Hand over again; report it if it repeats. |
| `handover_failed` | A Git command failed, for example a `.git/config.lock` that is not the sandbox's leftover. | See Git's message; remove a stale lock by hand when no Git command runs. |
| `config_locked` | The sandbox's leftover `.git/config.lock` is there while another job of the workspace runs. | Nothing: the hand-over runs by itself when that job ends. |
| `handover_interrupted` | A cut-off hand-over was undone at `sf serve`'s start. | Hand over again. |

## Refusals of the merge request actions

Creating, merging or reading a merge request does not change the job's state when it fails: the
job stays `pushed` (or where it was) and the answer says why.

| Code | What it means | What to do |
| --- | --- | --- |
| `mr_token_missing` | No token for the workspace's host. | Set `SF_GITHUB_TOKEN` or `SF_GITLAB_TOKEN` in `auth.env`, restart `sf serve`. |
| `mr_host_unsupported` | `origin` names no GitHub or GitLab repository; or it is on a host other than `github.com` and `gitlab.com` while `SF_GITLAB_URL` is not set ("<host> is not GitHub or gitlab.com; if it is a GitLab, set SF_GITLAB_URL to its API (https://<host>/api/v4)"); or on a host other than `SF_GITLAB_URL`'s. No token is sent to that host. | For a self-hosted GitLab, set `SF_GITLAB_URL` to its API in `auth.env` and restart `sf serve`; otherwise open the merge request yourself, or fix `SF_GITLAB_URL`. |
| `mr_auth_failed` | The host refused the token (401). | Renew the token and its permissions. |
| `mr_host_error` | The host refused the request (its status and words), or redirected. | Read the host's words. |
| `mr_host_unreachable` | The host did not answer within 30 s. | Try again later. |
| `mr_not_mergeable` | The host cannot merge it: a draft, conflicts, failing required checks, missing approvals. | Fix it on the host, then Merge again. |
| `mr_not_open` | The merge request is already merged or closed. | Refresh MR status. |
| `mr_host_changed` | `origin` now points at another host than the job's merge request. | Restore `origin`, or work on the host directly. |
| `mr_text_invalid` | The saved MR text breaks the rules, or is not the prepared commit's message. | Fix it on the Merge request screen, or Reset to factory text. |
| `branch_changed` | The branch tip is not the commit the factory prepared (edited by hand). | Approve with "as it is" (`sf approve --as-is`), or reset the branch. |

## Why a queued ticket does not start

The queue never stops a job, but a queued ticket may wait. Its card says why:

| The card or `sf queue list` says | What to do |
| --- | --- |
| plan not ready: N blocker, M major | Fix the Task file (it is checked again after the save), or *Start anyway* (`sf queue force`). It is also checked again by itself when the base changes a file in its scope. |
| plan check failed | It is tried again by itself up to 3 times, 15 minutes apart; after that (the notification), read the error and press Check again. |
| plan being checked | Wait. |
| plan not checked | Press Check (`sf check-task`), or force it. With `SF_TASK_CHECK_AUTO=off` every ticket says this until checked. |
| Waits for `APP-11` (pushed, running, planned, missing) | Merge the tickets it waits for; the queue looks again every 5 minutes. Start by hand does not wait. |
| Queue held: `<reason>` | `sf queue release`, or the board. |
| Queue held: usage limit, resets at 03:00 | Wait, or resume or abort the parked jobs; `sf queue release` does not end this hold. |
| Queue held: usage limit reset, resume the parked jobs | Resume them (*Resume*), then release the queue. |
| N running · 0 slots free | Wait, or `sf queue limit <N>`. |
| Start failed: `<message>` | The queue's start was refused (`task_draft`, `branch_exists`, `base_not_found`, …); the ticket left the queue. Fix the cause and add it again. |

## Refusals you may meet

| Code | Meaning |
| --- | --- |
| `invalid_state` | The command does not apply to the job's state now (the message names the state and code). |
| `runner_active` | The job's runner is still busy (a message or fix waits); try again in a moment. |
| `turn_running` | A turn is running; wait for it. |
| `job_active` | The Task file or the images cannot change while a job of the ticket runs (pause it first, or wait). |
| `job_exists` | A live job of the ticket exists; a new one cannot start. |
| `task_draft` | The Task file is still a skeleton: plan it first. |
| `worktree_missing` | The job's worktree is gone; Restart…. |
| `handed_over` | The job is in your checkout: Take it back first. |
| `checkout_moved` | Ask for changes: your checkout is not on the job's branch any more; switch back, or Take it back. |
| `takeback_changed` | Take it back: your checkout changed since the hand-over; use Ask for changes, or undo your edits. |
| `not_pushed` | I opened the MR myself: `origin` does not have the branch with your changes; push first. If you merged it another way, use Merged another way (`sf handed-done --merged`). |
| `push_check_failed` | I opened the MR myself: `origin` did not answer. |
| `restart_refused` | Restart: the old branch has commits or was pushed; push or delete it by hand first. |
| `runner_timeout`, `runner_failed` | `sf serve` did not get an answer from the job's runner; see [Troubleshooting](operations.md#troubleshooting). |

Any other code shows as "Stopped" with *Open the job*; its message says what happened, and Send or
Abort applies. The reference has every code with its exact rule:
[Jobs](../../factory/README.md#jobs), [MR preparation](../../factory/README.md#mr-preparation),
[Hand-over](../../factory/README.md#hand-over-to-your-checkout),
[the stop table](../../factory/README.md#dashboard).

Next: [Operations](operations.md).
