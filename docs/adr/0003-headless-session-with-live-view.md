---
status: accepted
date: 2026-11-01
---

# The Implementer is a headless Agent SDK session with a read-only live view

The Implementer runs through the Claude Agent SDK (`permissionMode: auto`, the User's own skills
and settings, Claude Code's built-in sandbox) rather than as an interactive terminal session,
because Fix sections must reach the session without the User, and an interactive session has no
message API. The terminal shows the session through `sf watch` (every message, tool call and
result, live), and `sf say` injects a User message into the same session. The earlier hand-written
stream-json driver, gate helper, process-identity and quiescence machinery of SF-009 are replaced
by the SDK.

## Consequences

- Session context is managed by the SDK (auto-compaction); there are no compact/reset tools for
  the Context owner. `sf reset` starts a fresh session on the same Task file.
- The sandbox covers Bash only (bubblewrap, network limited to the npm registry and the GitLab
  host). Read, Edit and Write stay under deny rules for `.env*` and `.git/**`. This is a recorded
  limitation, not something to compensate with detectors.
