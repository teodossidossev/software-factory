---
status: accepted
date: 2026-11-03
supersedes: 0001
---

# Every job works in its own worktree; the branch is committed at Clean; approve only pushes

The Implementer works in a Git worktree of the workspace's checkout, created at job start under
`SF_WORKTREE_ROOT` (`<state dir>/worktrees/<workspace>/<ticket>`), never in the User's IDE
checkout. Several jobs of one workspace run at the same time, up to `SF_MAX_JOBS`. When the
Context owner declares Clean, the factory runs the MR preparation at once (commit by the Git
rules, rebase onto the base, verification) in the worktree, removes the worktree, and leaves the
branch with exactly one commit in the User's repository. The User checks that branch out in the
IDE, runs it, and approves (the push) or asks for another fix, which reopens a worktree from the
branch and amends the commit at the next Clean.

This supersedes ADR-0001, which rejected worktrees because of submodules and the wish to watch
the work live in the IDE. Submodules are initialised in the worktree at start
(`git submodule update --init --recursive`). Watching the work live mattered less than the two
things the single checkout cost: one job at a time, and an IDE checkout the factory owned during
a job. The Patch of each iteration is still the uncommitted difference to the base in the
worktree; iterations still commit nothing.

## Consequences

- The registry's `work_checkout` is retired: a workspace is one checkout. `sf workspace add
  --work` is refused; an old entry's `work_checkout` is read and ignored with a warning.
- `checkout_dirty` is gone: the state of the checkout does not matter. `job_limit` replaces
  `job_active`: the limit is per workspace.
- `mark_clean` is the only way to a commit; `approve` from `awaiting_review` is gone. `approve`
  refuses a branch whose tip is not the prepared commit (`branch_changed`) unless `--as-is`.
- Every ticket has its own ChatGPT conversation, subscribed with the ticket filter; the factory
  removes that subscription after the job's last event (`pushed` or `aborted`), so a finished
  conversation never fires again; a `failed` start keeps it for the next start.
- The Task file still lives in `.software-factory/` of the checkout, where the Context owner and
  the User edit it; the factory copies it into the worktree before every Implementer turn.
- The checkout's Git operations of one workspace (fetch, worktree add and remove, branch delete,
  snapshot ref, push) are serialized; everything else runs concurrently.
