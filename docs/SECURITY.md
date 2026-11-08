# Security

The state of the factory's security in plain words: what is protected, what is not, and when it
was last checked. The mechanics are in the [trust model](guide/trust-model.md); the audits that
found the gaps are in [audits/](audits/README.md). Update this file whenever a change moves a line
between "protected" and "open", and after every audit.

Last checked: 2026-11-08, `sf smoke` PASS on `main` at 9f83d39 (12 of 12 steps, every sandbox probe
refused).

## Protected

- **The agent that writes code works in a sandbox.**
  - It cannot read your home directory except the paths its tools need.
  - It cannot reach your keys, `auth.env`, SSH, the dashboard token, or other jobs.
  - It cannot reach the session bus, docker or the Tailscale daemon.
  - It writes only in its own worktree.
  - It has no WebFetch or WebSearch.
  - It cannot run a command outside the sandbox.
- **The Codex gate runs in a read-denying wrapper.** It sees no secrets and no other jobs. Secrets
  in its findings are masked.
- **Code from a repository never runs as you through Git.** The factory's Git commands run no hooks
  and no fsmonitor.
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
    names of your other workspaces.
- **Checked on every update.** `sf smoke` runs the sandbox and gate probes. A probe that gets
  through fails the smoke.

## Open

- **The network is open to the agents.** It has to be: Claude and Codex are remote models. The
  code a job works on goes to Anthropic and OpenAI; secrets do not.
- **The factory itself runs as you,** outside any sandbox: fetch, commit, push, the merge request.
  That is why every change goes through a pull or merge request, and product repositories are
  never pushed without your go.
- **Orphaned sandbox processes** of finished sessions are not ended yet (SF-141).
- **Not yet switched on for the factory's own workspace:** the guard (`"guard": true`) and the test
  command in a sandbox without network.
- **Outside the home directory** a sandboxed command still reads what the system lets any user
  read (`/etc`, `/opt`).
- **A phone that is lost unlocked** opens the dashboard. The dangerous actions still need the
  ticket typed. Keep the QR code with the token private.

The full list of limits is in [The trust model: The limits](guide/trust-model.md#the-limits).
