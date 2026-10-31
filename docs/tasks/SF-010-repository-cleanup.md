# SF-010: repository cleanup and baseline commit preparation

Job: `sf010-repository-cleanup-20261031` (app `sf009-self-fix`).

Clean unnecessary repository files, make status and ignore rules usable, add navigation and the
decision record, and prepare one baseline commit of all intended source work. The managed job makes
no Git mutation. The commit runs from an operator terminal after review, acceptance and job closure.

This is not a functional change, and the reproducible bootstrap stays deferred. Criteria CLEAN-01 to
CLEAN-08 are in the job instruction, `.software-factory/jobs/sf010-repository-cleanup-20261031/instruction.md`.

Report: [SF-010-repository-cleanup-report.md](../reports/SF-010-repository-cleanup-report.md).
