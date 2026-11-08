# Documentation

The index of `docs/`. Start with the [user guide](guide/README.md).

| Location | Contents |
| --- | --- |
| [guide/](guide/README.md) | The user guide: concepts, install, configuration, planning, running jobs, review and merge, stops, operations, ways of working |
| [adr/](adr/) | Architecture decision records since SF-011; each one's `status` says whether it still holds |
| [design/SF-011-factory.md](design/SF-011-factory.md) | The SF-011 design of the factory (historical) |
| [design/SF-036-reviewers.md](design/SF-036-reviewers.md) | The SF-036 design of the reviewers and factory-owned Git (historical) |
| [design/dashboard-v3/](design/dashboard-v3/README.md) | The dashboard's design reference: the prototype every dashboard ticket implements |
| [SECURITY.md](SECURITY.md) | The state of security in plain words: what is protected, what is open, when it was last checked |
| [audits/](audits/README.md) | The independent audits of the factory and what came of each |
| [runbooks/chatgpt-connection.md](runbooks/chatgpt-connection.md) | The tunnel and the ChatGPT connector for planning |
| [runbooks/coordinator.md](runbooks/coordinator.md) | The user's rules for the coordinating Claude Code session |
| [project/DECISIONS.md](project/DECISIONS.md) | Decisions the user approved, in date order (history; the ADRs and the reference hold the current state) |
| [../factory/README.md](../factory/README.md) | The reference: commands, environment, jobs, dashboard, every code |
| [../factory/HANDBOOK.md](../factory/HANDBOOK.md) | What the Context owner is told: the cycle, the tools, the Task file format, the review and Git rules, the templates |
| [../CONTEXT.md](../CONTEXT.md) | The vocabulary |

## Architecture decisions

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](adr/0001-work-checkout-no-worktree-no-iteration-commits.md) | The Implementer works in a dedicated checkout, without committing | superseded by 0004 |
| [0002](adr/0002-chatgpt-scheduled-task-instead-of-events.md) | The Context owner polls through a ChatGPT scheduled task | superseded by 0005 |
| [0003](adr/0003-headless-session-with-live-view.md) | The Implementer is a headless Agent SDK session with a read-only live view | accepted, amended by 0005 |
| [0004](adr/0004-worktree-per-job-branch-at-clean.md) | Every job works in its own worktree; the branch is committed at Clean | accepted, amended by 0005 |
| [0005](adr/0005-api-reviewers-and-factory-git.md) | Claude and Codex review; ChatGPT only plans; the factory does Git | accepted |

## History

The work before SF-011 (SF-001 to SF-010: the bridge, the OpenClaw gateway, the file-based
supervisor) was removed from the code in SF-011, and its reports and designs from this folder in
SF-096; Git history keeps them. The Task files and Reports of the factory's own tickets live in the
ignored `.software-factory/` directory, not in version control.

## Known gaps

- **Jira:** not integrated. The ticket key names the Task file, the job and the branch, nothing
  more.
- **Git hosts:** GitHub and GitLab only, for the merge request actions (`sf mr create`,
  `sf mr merge`, `sf mr status`); on any other host the factory only pushes, and you open the
  merge request yourself.
