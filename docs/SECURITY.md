# Security

The state of the factory's security in plain words: what is protected, what is not, and when it
was last checked. The mechanics are in the [trust model](guide/trust-model.md); the audits that
found the gaps are in [audits/](audits/README.md). Update this file whenever a change moves a line
between "protected" and "open", and after every audit.

Last checked: 2026-11-09, the [audit of 2026-11-09](audits/2026-11-09-audit.md) on `main` at
c4f6d33. It found two critical ways out of the sandbox, both closed by SF-159: a test run could
rewrite the worktree's `.git` so that the factory's next Git call ran a command as you, and a job
could write `.claude/settings.json` hooks (or `.mcp.json`, `.codex/`) that the next Claude session
in the worktree ran outside any sandbox. Its other findings are listed under "Open".
After its fixes (SF-159, SF-161 to SF-166): 2026-11-10, `sf smoke` PASS on `main` at 565d83e
(12 of 12 steps, every one of its 12 sandbox probes refused).
Before it: 2026-11-08, `sf smoke` PASS on `main` at aa1a9f1 (12 of 12 steps, every sandbox probe
refused), and the factory's test command passed in a sandbox without network on `main` at c66ab78.

## Protected

- **The agent that writes code works in a sandbox.**
  - It cannot read your home directory except the paths its tools need.
  - It cannot reach your keys, `auth.env`, SSH, the dashboard token, or other jobs.
  - It cannot reach the session bus, docker or the Tailscale daemon.
  - The agent sees no host `/tmp`: no other program's sockets, no other session's output.
  - It writes only in its own worktree. Its file tools write nothing in the worktree's `.git` or
    agent configuration (`.claude/`, `.mcp.json`, `.codex/`); its commands cannot write those that
    exist when the session starts, and Claude Code's own sandbox keeps them from a missing
    `.claude` configuration and `.mcp.json`.
  - Its sessions run no hook from a settings file, so a `.claude/settings.json` a job wrote runs
    nothing.
  - It has no WebFetch or WebSearch.
  - It cannot run a command outside the sandbox.
- **Sandboxes do not outlive their session.** Sandbox processes left behind by a finished session
  are ended.
- **Tests run before every merge request.** In the factory's own workspace, typecheck and the unit
  tests run in a sandbox without network before the MR text is written; a failure sends the job
  back to fix it. The test run cannot change the worktree's `.git`, and a run that changes
  `.claude`, `.mcp.json` or `.codex` fails; so does one where any of them is a link, before it
  starts. The merge runs them again, in the same sandbox, on the change merged into the base as
  it is now; a conflict or a failure refuses the merge, and nothing is merged.
- **The Codex gate runs in a read-denying wrapper.** It sees no secrets and no other jobs. Secrets
  in its findings are masked. The wrapper refuses new Unix sockets, so the gate cannot reach your
  X server, session bus or other local services through one.
- **ChatGPT reads no secret file of a workspace.** `read_file` refuses the files Git ignores
  (outside `.software-factory/`) and credential-like names tracked or not (`.env`, `.envrc`, `*.pem`,
  `*.key`, SSH keys, `credentials*.json`, `*.tfvars`), links resolved, as `search` already skipped
  them.
- **The read-only sessions load no MCP server.** The morning digest, which reads other people's
  commit messages, the reviews and the Task check start without your MCP servers and deny every
  MCP tool, so nothing they read can drive one.
- **Code from a repository never runs as you through Git.** The factory's Git commands run no hooks
  and no fsmonitor.
- **The GitLab token goes only to gitlab.com or the host of `SF_GITLAB_URL`.** A workspace on any
  other host that is not GitHub has its merge request actions off, and the hourly logins check
  leaves it out.
- **The dashboard:**
  - It listens on loopback only.
  - From another device it opens only through Tailscale, for the logins in
    `SF_DASHBOARD_REMOTE_LOGINS`.
  - Approve, Retry, Create merge request and Merge from there need the ticket typed again.
  - A foreign web page cannot act on it.
  - No token is written to a log.
- **What is published is checked.**
  - The guard refuses a push or an MR text that holds a secret, in every workspace.
  - In a workspace with `"guard": true`, it also refuses the names on your private list and the
    names of your other workspaces. It is on for the factory's own public repository. In the
    company repositories it checks secrets only, so issue keys and links stay allowed there.
  - Commit authors and committers are not checked.
  - Every file is scanned as text, whatever its attributes or bytes (a `-diff` or `binary`
    attribute, a NUL byte), and a workspace with `"guard": true` pushes no LFS files, whose content
    the guard cannot read.
- **Checked on every update.** `sf smoke` runs the sandbox and gate probes. A probe that gets
  through fails the smoke.

## Open

- **Found by the audit of 2026-11-09, being fixed:**
  - A link swapped between the file guard's check and the write can send a write out of the
    worktree.
- **LFS content is not scanned for secrets in a workspace without the guard flag.** The guard reads
  an LFS file's pointer only.
- **The network is open to the agents.** It has to be: Claude and Codex are remote models. The
  code a job works on goes to Anthropic and OpenAI; secrets do not.
- **The factory itself runs as you,** outside any sandbox: fetch, commit, push, the merge request.
  That is why every change goes through a pull or merge request, and product repositories are
  never pushed without your go.
- **The test command runs only where it is set.** The company workspaces have none yet, so their
  jobs reach the merge request without a test run.
- **Outside the home directory** a sandboxed command still reads what the system lets any user
  read (`/etc`, `/opt`).
- **A phone that is lost unlocked** opens the dashboard. The dangerous actions still need the
  ticket typed. Keep the QR code with the token private.

The full list of limits is in [The trust model: The limits](guide/trust-model.md#the-limits).
