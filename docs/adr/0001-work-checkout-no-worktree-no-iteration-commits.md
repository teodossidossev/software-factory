---
status: accepted
date: 2026-11-01
---

# The Implementer works in a dedicated checkout, on a branch, without committing

The Implementer works directly in a registered work checkout (a separate clone when the User wants
the IDE checkout free), on a Branch created at Job start, and commits nothing until MR preparation.
We rejected Git worktrees because some projects use submodules and the User wants to check the
Branch out in IntelliJ and watch the work live; we rejected per-Iteration commits because they have
carried unwanted changes into history before. The Patch is therefore the uncommitted difference to
the base branch, and the last line of the `/implement` skill ("commit your work") is deliberately
denied during Iterations.

## Consequences

- Job start requires a clean work checkout (the `.software-factory/` folder excepted) and refuses
  otherwise; `sf abort` leaves changes in place unless `--discard` is given.
- One active Job per Workspace, because the checkout holds one Branch at a time.
- Rollback to an earlier Iteration is not a Git operation; the Patch of each Iteration is kept by
  the factory.
