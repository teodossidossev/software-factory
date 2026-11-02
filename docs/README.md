# Documentation

| Location | Contents |
| --- | --- |
| [project/DECISIONS.md](project/DECISIONS.md) | Approved project decisions |
| `design/` | Designs: SF-007, SF-009, SF-010 reviewer (history), SF-011 (current) |
| `adr/` | Architecture decision records of SF-011 |
| `runbooks/` | [chatgpt-connection](runbooks/chatgpt-connection.md): the tunnel and the ChatGPT connector |
| `tasks/` | Task definitions of SF-001 to SF-010, one or more per SF number |
| `reports/` | Dated implementation reports. Historical: they are not updated to match later work |
| [../factory/README.md](../factory/README.md) | The factory: commands, environment, jobs, dashboard |
| [../factory/HANDBOOK.md](../factory/HANDBOOK.md) | How the Context owner works with the factory |

Older documents are partly in Bulgarian. Where a report and a current document disagree, the
current document wins and the report records what was true at its date.

## By task

The rows up to SF-010 are history. Their runtime was removed in SF-011; "retired" marks a runbook
that no longer exists.

| Task | Topic | Task document | Runbook | Report |
| --- | --- | --- | --- | --- |
| SF-001 | Bridge bootstrap | [task](tasks/SF-001-bootstrap.md), [review 01](tasks/SF-001-review-01.md) | retired | [report](reports/SF-001-report.md) |
| SF-002 | ChatGPT connection | [task](tasks/SF-002-connect-chatgpt.md) | [connection](runbooks/chatgpt-connection.md) | [report](reports/SF-002-report.md) |
| SF-003 | Reading files | [task](tasks/SF-003-read-files.md) | retired | [report](reports/SF-003-report.md) |
| SF-004 | OpenClaw gateway | [source](tasks/SF-004-openclaw.md), [task](tasks/SF-004-openclaw-bootstrap.md) | retired | [report](reports/SF-004-report.md) |
| SF-005 | Dispatch | [source](tasks/SF-005-openclaw-dispatch.md), [task](tasks/SF-005-instruction-dispatch.md) | retired | [report](reports/SF-005-report.md) |
| SF-005-UI | Dashboard | Instruction kept in `factory-data/` | retired | [report](reports/SF-005-UI-report.md) |
| SF-006 | Claude execution | [task](tasks/SF-006-claude-execution.md) | retired | [report](reports/SF-006-report.md) |
| SF-007 | Operator console | [task](tasks/SF-007-local-operator.md) | retired | [report](reports/SF-007-report.md) |
| SF-009 | Supervisor and review loop | [task](tasks/SF-009-autonomous-session-loop.md) | retired | [report](reports/SF-009-report.md), [ack live](reports/SF-009-review-ack-live-20261030.md) |
| SF-010 | Review foundation | [task](tasks/SF-010-reviewer-foundation.md) | retired | None |
| SF-010 | Events discovery | None | retired | [report](reports/SF-010-chatgpt-events-report.md) |
| SF-010 | Repository cleanup | [task](tasks/SF-010-repository-cleanup.md) | None | [report](reports/SF-010-repository-cleanup-report.md) |
| SF-011 | The factory | [design](design/SF-011-factory.md), ADRs [0001](adr/0001-work-checkout-no-worktree-no-iteration-commits.md), [0002](adr/0002-chatgpt-scheduled-task-instead-of-events.md), [0003](adr/0003-headless-session-with-live-view.md) | [connection](runbooks/chatgpt-connection.md) | Outside version control |

The Task files and Reports of SF-011 (subtasks `SF-011-a` to `SF-011-e`) live in the ignored
`.software-factory/` directory, not in version control.

Design documents: [SF-007](design/SF-007-local-operator.md), [SF-009](design/SF-009-autonomous-session-loop.md),
[SF-010 reviewer](design/SF-010-reviewer-foundation.md) (history), [SF-011](design/SF-011-factory.md) (current).

## Known gaps

- **Dashboard v2:** approve, abort and say from the dashboard are not implemented. They stay in
  the terminal.
- **Integrations:** Jira and Git host integrations are not implemented. The job records the ticket
  key, workspace and branch for them.
- **Concurrent jobs:** not implemented. One active job per machine.
- **Scheduled task context:** whether the ChatGPT scheduled task sees the planning conversation's
  context is verified in the pilot.
