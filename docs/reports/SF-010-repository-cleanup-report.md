# SF-010 report: repository cleanup and baseline commit preparation

Job: `sf010-repository-cleanup-20261031`, 2026-10-31. Evidence, manifests and the commit plan:
`review/SF-010/repository-cleanup-20261031/README.md`.

**Status:** cleanup done and awaiting independent review. Nothing was staged or committed. The
baseline commit is a separate operator step after acceptance and job closure.

## Changes

- **Removed:** `bridge/sf009-self-hosting-validation-dist/` (182 generated files). The canonical
  `bridge/dist` holds every path it held, and `scripts/sf009-executor.sh observe` works from it.
- **Ignored:** `/.software-factory/`, `/bridge/sf*-validation-dist/`, and `.env` files except
  `.env.example`. The application always leaves `.software-factory/` out of its own inspection, so
  this has no behavior effect.
- **Added:** `README.md`, `docs/README.md`, `docs/project/DECISIONS.md`, this report and its task.
- **Corrected:** the observer instructions in the SF-009 runbook and design, the current discovery
  status in the SF-010 probe runbook, and the ignored build output in the SF-010 reviewer runbook. An ignored
  validation build no longer counts toward the export bound of a managed session.

No source, dependency, service template or configuration changed. Nothing was archived. All task
documents, reports and scripts stayed, because each is referenced or is the only record of its task.

## Open for the operator commit

The content credential scan and the Git identity, signing and hook checks were refused in the managed
session. They run in the operator procedure before anything is staged.
