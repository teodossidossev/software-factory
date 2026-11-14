# Security

The state of the factory's security in plain words: what is protected, what is not, and when it
was last checked. The mechanics are in the [trust model](guide/trust-model.md); the audits that
found the gaps are in [audits/](audits/README.md). Update this file whenever a change moves a line
between "protected" and "open", and after every audit.

Last checked: 2026-11-09, the [audit of 2026-11-09](audits/2026-11-09-audit.md) on `main` at
c4f6d33. It found two critical ways out of the sandbox, both closed by SF-159: a test run could
rewrite the worktree's `.git` so that the factory's next Git call ran a command as you, and a job
could write `.claude/settings.json` hooks (or `.mcp.json`, `.codex/`) that the next Claude session
in the worktree ran outside any sandbox. Its high finding, a link swapped between the file guard's
check and the write sending the write out of the worktree, is closed by SF-181 (the agent's Claude
Code runs in a bubblewrap wrapper). Its other findings are listed under "Open".
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
  - Its tools are an allow list: `Bash`, `Read`, `Edit`, `Write`, `NotebookEdit`, `Glob`,
    `Grep`, `Skill`, `Task`/`Agent` (sub-agents), `TaskOutput`, `TaskStop`, `TodoWrite` and
    `ToolSearch` (`IMPLEMENTER_TOOLS` in `factory/src/rules.ts`). Any other tool a Claude Code
    release offers (scheduling, messaging, workflows, WebFetch, WebSearch) does not exist in its
    session, and those a release has offered so far are also denied by name, sub-agents included.
  - No MCP server loads in its session: not your claude.ai connectors, not a project's
    `.mcp.json`, not a plugin's, not the factory's own.
  - It is told to write its own changes with Edit and Write only, never through an inline script,
    `sed -i` or a shell redirection, so the file guard sees them; running the repository's own
    tools (formatter, code generator, package manager) stays allowed.
  - It cannot run a command outside the sandbox.
  - The agent's Claude Code itself runs in a bubblewrap wrapper: only its worktree, its temporary
    folder and Claude Code's own state (`~/.claude/projects` and its other session folders, its
    login and `~/.claude.json`) are writable, and the worktree's `.git` is not. `/tmp` is an empty
    folder of the wrapper's own: writable, but nothing of the host's `/tmp` is seen there and
    nothing written there reaches the host. So a link swapped in between the file guard's check and
    the write cannot send the write out of the worktree.
    Its skills are the user's choice: of the skills installed in `~/.agents/skills`, each agent
    role (the Implementer, the Claude review, the Codex gate, the Task check, the planner) uses the
    ones you switch on with `sf skills set` (by default `implement`, `tdd`, `code-review`,
    `grilling` for the Implementer). The factory only reads `~/.agents/skills` and its lock file:
    it installs nothing (`npx skills add` in your terminal does) and never writes into `~/.agents`,
    `~/.claude` or a workspace's checkout, with one exception: the `skillOverrides` key of the
    coordinator checkout's `.claude/settings.local.json` (below). The chosen skills are copied verbatim into the factory's
    skills snapshot in its state directory when their lock file's hashes change, and never edited.
    Only the Implementer's chosen skills are mounted, each read-only, where Claude Code looks for
    the user's skills, over an empty read-only folder: the job can read them but not change them or
    add one, every turn of a job binds the folder and the choice its start recorded (an update
    builds a new folder and swaps a link to it, and no folder a job not yet archived recorded is
    removed), every other skill (`~/.claude/skills`, `~/.agents`, the snapshot's others) stays
    hidden, and each job's event log records the versions, the folder and each role's list it
    used. The reviewers, the Task check and the planning method get their chosen skills' text in
    their prompts, read from the same snapshot; the dashboard's `api/skills` reads only an
    installed skill's `SKILL.md` and refuses any other name or path. The file
    guard lets only this session read that folder, by the path given; every other session, and a
    write by any session, is refused there.
    Without `bwrap` a job's turn stops; it never runs unwrapped. `SF_SANDBOX=off` turns the
    wrapper off with the rest of the sandbox, which opens the link swap again.
- **The coordinator's skills change one key of one file.** The Skills page's Coordinator column
  and `sf skills set coordinator` switch the skills of your own Claude Code session in the checkout
  of the workspace `SF_COORDINATOR_WORKSPACE` (`software-factory` by default) through Claude Code's
  `skillOverrides` in `<checkout>/.claude/settings.local.json`. The factory writes that key only:
  it sets a skill to `"off"` or removes its entry (and the empty `skillOverrides`), keeps every
  other key and entry in value and order, and never writes a permission, an environment variable,
  a hook or any other setting. The file is read again before each change and replaced atomically
  with its own mode (a new one 0600, a new `.claude` 0700). A file that is not a JSON object, or
  whose `skillOverrides` is not one, is refused (`coordinator_settings_unreadable`), never
  overwritten; a `.claude` or a settings file that is a symlink, or a `.claude` that is not the
  checkout's own, is refused (`coordinator_settings_unsafe`). The file is reached only through one
  handle on `.claude`, opened without following a link and checked to be the checkout's own: the
  read, the temporary file and the rename all go through it (`/proc/self/fd/<fd>`), so a `.claude`
  swapped for a link during a change cannot send the write out of the checkout. Only installed
  skills' names can be switched. The dashboard never gets the checkout's path.
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
  them. `read_job` returns a job's Report and the reviews' items, read only from the job's own
  directory, with the real paths of its worktree and of the checkout replaced (`<worktree>`,
  `<checkout>`).
- **The planner can only propose a change.** `suggest_changes` stores one note and starts nothing;
  only your Send on the dashboard sends it, and only the note the page showed (its SHA-256 is
  checked, so a note the planner replaced meanwhile is never sent unread). A note is refused unless
  the job waits for you, and is bounded at 4000 characters. The planning chat link is only ever a
  `https://chatgpt.com/` link, checked when it is saved and again before the page links it, and is
  opened only by your click.
- **The read-only sessions load no MCP server.** The morning digest, which reads other people's
  commit messages, the reviews and the Task check start without your MCP servers and deny every
  MCP tool, so nothing they read can drive one.
- **Code from a repository never runs as you through Git.** The factory's Git commands run no hooks
  and no fsmonitor.
- **A change to files your IDE or tools run is handed over only by you.** An automatic hand-over
  skips a change to a build file, a build wrapper, IDE or agent settings or Git hooks
  (`handoff_sensitive`), and one whose files cannot be listed; it waits until you have read it
  and press *Hand over to my checkout*.
- **The GitLab token goes only to gitlab.com or the host of `SF_GITLAB_URL`.** A workspace on any
  other host that is not GitHub has its merge request actions off, and the hourly logins check
  leaves it out.
- **The pass of merged jobs only reads the Git host.** Every 10 minutes it sends the host `GET`
  requests only, and it never deletes a branch.
- **The dashboard:**
  - It listens on loopback only.
  - From another device it opens only through Tailscale, for the logins in
    `SF_DASHBOARD_REMOTE_LOGINS`.
  - Approve, Retry, Create merge request, Merge, Archive and Merged — archive from there need the
    ticket typed again.
  - A foreign web page cannot act on it.
  - No token is written to a log.
  - The coordinator's state (its status, its open questions and its chat link) is a local file
    in the state directory. Only `sf coordinator`, through `sf serve`, writes it; the dashboard
    only reads it, and shows every text as text. The chat link is limited to `https://claude.ai/`,
    checked when it is written and again on the page.
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
