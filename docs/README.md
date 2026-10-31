# Documentation

| Location | Contents |
| --- | --- |
| [project/DECISIONS.md](project/DECISIONS.md) | Approved project decisions |
| `tasks/` | Task definitions, one or more per SF number |
| `design/` | Designs: SF-007, SF-009, SF-010 reviewer |
| `runbooks/` | How to operate each component |
| `reports/` | Dated implementation reports. Historical: they are not updated to match later work |
| `../review/` | Evidence packages per job (local, ignored by Git, immutable) |

Older documents are partly in Bulgarian. Where a report and a runbook disagree, the runbook is
current and the report records what was true at its date.

## By task

| Task | Topic | Task document | Runbook | Report |
| --- | --- | --- | --- | --- |
| SF-001 | Bridge bootstrap | [task](tasks/SF-001-bootstrap.md), [review 01](tasks/SF-001-review-01.md) | [bridge](../bridge/README.md) | [report](reports/SF-001-report.md) |
| SF-002 | ChatGPT connection | [task](tasks/SF-002-connect-chatgpt.md) | [connection](runbooks/chatgpt-connection.md) | [report](reports/SF-002-report.md) |
| SF-003 | Reading files | [task](tasks/SF-003-read-files.md) | [bridge](../bridge/README.md) | [report](reports/SF-003-report.md) |
| SF-004 | OpenClaw gateway | [source](tasks/SF-004-openclaw.md), [task](tasks/SF-004-openclaw-bootstrap.md) | [docker](runbooks/openclaw-docker.md) | [report](reports/SF-004-report.md) |
| SF-005 | Dispatch | [source](tasks/SF-005-openclaw-dispatch.md), [task](tasks/SF-005-instruction-dispatch.md) | [dispatch](runbooks/openclaw-dispatch.md) | [report](reports/SF-005-report.md) |
| SF-005-UI | Dashboard | Instruction kept in `factory-data/` | [dashboard](runbooks/openclaw-dashboard.md) | [report](reports/SF-005-UI-report.md) |
| SF-006 | Claude execution | [task](tasks/SF-006-claude-execution.md) | [execution](runbooks/claude-execution.md) | [report](reports/SF-006-report.md) |
| SF-007 | Operator console | [task](tasks/SF-007-local-operator.md) | [operator](runbooks/SF-007-local-operator.md) | [report](reports/SF-007-report.md) |
| SF-009 | Supervisor and review loop | [task](tasks/SF-009-autonomous-session-loop.md) | [supervisor](runbooks/SF-009-autonomous-session-loop.md) | [report](reports/SF-009-report.md), [ack live](reports/SF-009-review-ack-live-20261030.md) |
| SF-010 | Review foundation | [task](tasks/SF-010-reviewer-foundation.md) | [reviewer](runbooks/SF-010-reviewer-foundation.md) | None |
| SF-010 | Events discovery | None | [probe](runbooks/SF-010-event-probe.md) | [report](reports/SF-010-chatgpt-events-report.md) |
| SF-010 | Repository cleanup | [task](tasks/SF-010-repository-cleanup.md) | None | [report](reports/SF-010-repository-cleanup-report.md) |

Design documents: [SF-007](design/SF-007-local-operator.md), [SF-009](design/SF-009-autonomous-session-loop.md),
[SF-010 reviewer](design/SF-010-reviewer-foundation.md).

## Known gaps

- **Setup:** no repository-owned bootstrap or common start command exists. Planned, not implemented
  (proposal `sf010-reproducible-setup-20261031`, deferred).
- **Callback:** the authenticated callback work is planned, not implemented.
- **Events:** catalog discovery passed once (2026-10-31, [probe runbook](runbooks/SF-010-event-probe.md))
  and the probe is stopped. The checkpoint's `discovery: "unverified"` is a hardcoded field, not the
  verdict. Authenticated subscriptions, callback delivery and automatic ChatGPT continuation remain
  unverified and unimplemented.
- **Review coordinator:** no real review provider exists and the supervisor does not wire its hooks.
- **Runtime lag:** `bridge/src/executor/supervisor.ts` is newer than `bridge/dist`. The accepted
  publication recovery is not in the running supervisor until a separate rebuild and restart.
- **Bridge README:** `bridge/README.md` documents the tools through SF-005 only. Later tools are in
  `bridge/src/server.ts` and the SF-009 runbook.
- **SF-008:** a job with this name exists in reports, but it has no document in this repository.
