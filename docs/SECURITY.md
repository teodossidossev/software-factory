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
    `grilling` for the Implementer). The factory reads `~/.agents/skills` and its lock file, and
    for a planning copy's settings the names of the skill folders in `~/.claude/skills`
    (`$CLAUDE_CONFIG_DIR/skills`): it installs nothing for you (`npx skills add` in your terminal
    does) and never writes into `~/.agents`, `~/.claude` or a workspace's checkout, with one exception: the `skillOverrides` key of the
    coordinator checkout's `.claude/settings.local.json` (below). The chosen skills are copied verbatim into the factory's
    skills snapshot in its state directory when their lock file's hashes change, and never edited.
    `sf planner setup` copies the planner role's skills from that snapshot into a planning copy's
    `.claude/skills/` and switches your other skills off in that copy's settings (`skillOverrides`,
    and `syncClaudeAiSkills` for your claude.ai skills).
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
- **What is committed is what the reviewers saw.** Every published iteration records the tree the
  factory's commit would have: the worktree's change built in a temporary index, without
  `.software-factory/` (the MR text, the steps checklist). MR preparation stages the worktree's
  change and commits it only when its tree is the one the reviewed iteration recorded, whichever
  way the job got there (a clean verdict, your Accept or Skip, Retry). When the test run, the MR
  text turn or anything else changed a file of the change after that review, nothing is
  committed: the worktree as it is goes back to review as a new iteration, whose Report names the
  changed paths. The comparison is of the commit before its rebase; a rebase conflict's
  resolution goes back to review as before.
- **The Codex gate runs in a read-denying wrapper.** It sees no secrets and no other jobs. Secrets
  in its findings are masked. The wrapper refuses new Unix sockets, so the gate cannot reach your
  X server, session bus or other local services through one.
- **The reviewers read the factory's copy of the Task file.** The Claude review, the Codex gate and
  the simplification pass get the Task file, with the factory's Fix sections, from the factory's
  own copy in the job's directory, written each time the factory puts the Task file into the
  worktree; a contest's `§section` is checked against the same copy. The worktree's
  `.software-factory/<ticket>.md`, which the Implementer can write, is not what they read.
- **The factory writes into the worktree through no link.** The Task file it copies into the
  worktree's `.software-factory/`, and the ticket's images there, are written by a rename into a
  folder of its own: a link the Implementer put at `.software-factory/`, at the Task file or at
  the image folder is removed, never followed.
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
- **The Claude Code planner can only read, and write its prototypes.** `sf planner setup` gives
  the planning copy's sessions the factory's planning tools, reading tools, and Write and Edit in one
  folder outside the copy, the workspace's prototypes folder (`<planning folder>/prototypes/<workspace>/`);
  those two refuse every other path without asking (Claude Code 2.1.314 or later; Claude Code's own
  files, such as its plan files, excepted). Web search and fetch are denied, Claude Code's artifacts
  are off, so nothing is published to claude.ai, and any other tool but the sandboxed shell asks you
  first. Their shell commands run in Claude Code's sandbox:
  they write nowhere, reach no network, and cannot see the factory's state folder; without a
  working sandbox the session does not start. Reads of the environment file, the MCP and dashboard
  tokens, Claude Code's own configuration and credentials, the tunnel profile, and SSH, cloud, Git
  and package credentials are denied to every tool. The MCP server is registered for the copy's
  folder only (Claude Code's local scope, in `~/.claude.json`, which every session the factory
  starts is denied). The sessions `sf planner start` starts get no token or setting of the factory
  in their environment but those that say where its folders are, and no Anthropic or Claude Code
  variable but `CLAUDE_CONFIG_DIR`: they sign in with your own claude.ai login.
- **A planning copy holds none of the repository's Claude Code configuration.** `sf planner
  setup` checks the copy out without anything the repository tracks under a `.claude/` folder but
  its `CLAUDE.md` (its settings, hooks, skills, agents, commands and rules) and without its
  `.mcp.json` (its MCP servers), at every run; the copy keeps the code and its instructions. A
  repository that tracks `.claude` itself as a link, a file or a submodule is refused. Only a
  configuration file with changes of yours, or a `.mcp.json` Git does not track, stays in the
  copy: the setup names it in a warning, and it loads until you remove it. `sf planner start`
  refuses a copy whose working tree holds any of it.
- **The factory accepts Claude Code's trust dialog only for its own planning copies, and only
  with your consent.** With `SF_PLANNER_TRUST=auto`, set once in the factory's configuration, `sf
  planner setup` and `sf planner start` accept Claude Code's trust dialog for the workspace's
  planning copy, which holds none of the repository's Claude Code configuration: only for the
  folder `sf planner setup` made for that workspace, only while its working tree holds none of
  that configuration, and only by answering the dialog in a terminal of their own as you would,
  so Claude Code saves the answer itself; the factory never writes Claude Code's global config.
  With the default, `ask`, you accept the dialog yourself (`sf planner trust`).
- **The read-only sessions load no MCP server.** The morning digest, which reads other people's
  commit messages, the reviews and the Task check start without your MCP servers and deny every
  MCP tool, so nothing they read can drive one.
- **Code from a repository never runs as you through Git.** The factory's Git commands run no hooks
  and no fsmonitor.
- **A change to files your IDE or tools run is handed over only by you.** An automatic hand-over
  skips a change to a build file, a build wrapper, IDE or agent settings or Git hooks
  (`handoff_sensitive`), and one whose files cannot be listed; it waits until you have read it
  and press *Hand over to my checkout*.
- **A part built on another part is never pushed before it.** A Task can name `builds_on:` a
  ticket of the same workspace whose change is not merged yet. Its job then starts from the commit
  that ticket's job prepared, taken from the workspace's checkout: nothing is fetched or pushed for
  it. The Patch and both reviews show this part's own change alone, so each part is reviewed once,
  in its own job. Approve (the push) is refused until the ticket it builds on is merged, and MR
  preparation replays the part onto that ticket's latest prepared commit, so a branch whose base is
  not merged never reaches the Git host.
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
  - A foreign web page cannot act on it, but for one thing you allow (a page you allow in the
    factory window adds pins, below), nor show it inside a frame to trick a click
    (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).
  - No token is written to a log.
  - The coordinator's state (its status, its open questions and its chat link) is a local file
    in the state directory. `sf coordinator`, through `sf serve`, writes it. The dashboard writes
    one thing in it, the time of a request for a status (a click on Zen's screen), through
    `POST api/coordinator/request` with the checks of its other actions; it shows every text as
    text. The chat link is limited to `https://claude.ai/`, checked when it is written and again
    on the page.
  - A workspace's vision is local files in the state directory (folders 0700, files 0600), in
    `<state dir>/vision/`, which `sf serve` makes at its start so that no job's session reads it.
    The Claude Code planner reads its English files, which `sf planner setup` names in the
    workspace's planning copy, so they go to Anthropic.
    Only `sf vision`, through `sf serve`, writes it, from a folder you name, following no link in
    it; no dashboard route writes it. Its page is served behind the token under its own policy
    (`VISION_PAGE_CSP`): an opaque origin that can use neither the dashboard's cookie and storage
    nor its API, and loads nothing. Every Markdown text on it is escaped, and its only script is
    the factory's.
  - A ticket's prototypes, which the Claude Code planner writes into
    `<planning folder>/prototypes/`, are shown behind the token like every page, read-only, through
    folders that follow no link, each a regular file of at most 4 MiB. Each opens in a page of the
    factory's that holds it in a sandboxed frame (`PROTOTYPE_PAGE_CSP`, `PROTOTYPE_FRAME_CSP`): an
    opaque origin that can use neither the dashboard's cookie and storage nor its API, loads
    nothing, cannot move the page or open a window, and whose navigations stay on the dashboard's
    origin. The file itself is served only to that frame, at an address that never holds the
    token.
  - A pin of point mode stores the page's hash or another page's address, a selector, up to 200
    characters of the element's text, its position and the note, in `<state dir>/pins.json`
    (mode 0600), on this machine only. It is written only through the dashboard's checked POSTs (the exact Origin, JSON, the
    body's bound, strict bounded fields) or `sf pins`, both in `sf serve`. The page shows every pin
    text as text, never as HTML, and no control character is stored (none but a line break and a
    tab in the text and the note), so `sf pins` prints nothing a terminal would act on.
  - The factory window (`http://127.0.0.1:<port>/point`) is the one page served without the
    token: static, with no data, on the local listener only, never in a frame, and its script
    loads only with the dashboard's cookie. It takes pins only from the page that opened it, only
    after you press Allow in it, only for addresses of that page's own origin, and only through
    `POST api/pins`; it tells the page nothing but each pin's number. The page never gets the token
    or the cookie and sends `sf serve` no request.
  - A pin never holds the dashboard's token. A new pin, or a pin's note, with the token anywhere
    in its address, route, selector, text or note is refused (`400 pin_holds_token`) before
    anything is stored, whichever page it comes from; so neither `pins.json` nor `sf pins` shows
    the token, also when something is pinned on the dashboard's own address.
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

- **A pin from another page holds that page's text and address:** the coordinator reads them as
  data, not instructions, and a note typed next to the pin is typed into that page, whose scripts
  can read it.
- **LFS content is not scanned for secrets in a workspace without the guard flag.** The guard reads
  an LFS file's pointer only.
- **The network is open to the agents.** It has to be: Claude and Codex are remote models. The
  code a job works on goes to Anthropic and OpenAI; secrets do not.
- **The factory itself runs as you,** outside any sandbox: fetch, commit, push, the merge request,
  and, after a merge it made, the deletion of that job's pushed branch on the host.
  That is why every change goes through a pull or merge request, and product repositories are
  never pushed without your go.
- **The test command runs only where it is set.** The company workspaces have none yet, so their
  jobs reach the merge request without a test run.
- **Outside the home directory** a sandboxed command still reads what the system lets any user
  read (`/etc`, `/opt`).
- **A planner's shell can open Unix sockets** on Linux unless Claude Code's seccomp filter is
  installed (`npm install -g @anthropic-ai/sandbox-runtime`). The factory's own socket is hidden
  from it, with the state folder.
- **A planner session answers to your Claude account.** `sf planner start` starts it with Remote
  Control: any device signed in to your Claude account can write to it and answer its permission
  prompts. It can still only read, and write its prototypes.
- **A planner's other tools ask you first.** Your claude.ai connectors load in the planner's
  sessions; one that can publish (a document, a page, a message) asks before each call, like every
  tool outside the planner's list. For a company ticket, answer no.
- **A prototype's script runs in your browser.** It is the planner's, written from what it read.
  Its policy keeps it from loading or sending anything over the network and from navigating away,
  but a browser has channels a page's policy does not close everywhere (a WebRTC connection where
  `webrtc 'block'` is unknown, a DNS lookup). Open a company ticket's prototypes only in a browser
  you trust.
- **A phone that is lost unlocked** opens the dashboard. The dangerous actions still need the
  ticket typed. Keep the QR code with the token private.

The full list of limits is in [The trust model: The limits](guide/trust-model.md#the-limits).
