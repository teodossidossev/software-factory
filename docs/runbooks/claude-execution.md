# Claude Code execution of accepted jobs (SF-006)

How the operator takes one OpenClaw-accepted job into its application repository and runs the native Claude Code `/implement` workflow there. Results come back to the mediator for review. Everything here is **one-shot and operator-started**. Nothing watches for jobs or starts sessions on its own.

## Roles

| Component | Does | Does not |
|---|---|---|
| ChatGPT (MCP) | Writes `instruction.md`, requests a dispatch, reads results with `factory_read_file` | Read `.env`, choose paths, commands or repositories, start execution |
| OpenClaw (SF-005) | Accepts the dispatch; its receiver records the request in the OpenClaw volume | See the host filesystem or any repository, run Claude, use a model |
| Host adapter (`scripts/sf006-execute.sh`) | Reads the app's `.env`, verifies the acceptance, copies the instruction, starts one Claude session, collects results | Run as a service, take paths or commands from anyone, stage/commit/push/reset/clean |
| Claude Code | Runs `/implement` in the application repository, in your terminal, asking you for permissions | Get extra permissions from the adapter: the session starts in manual permission mode |
| Operator | Registers apps, starts each step, answers Claude's prompts, confirms the end, reviews, commits and pushes | |

## Register an application (once per app)

```bash
mkdir -m 700 -p factory-data/apps/<app-id>
install -m 600 config/apps/.env.example factory-data/apps/<app-id>/.env
$EDITOR factory-data/apps/<app-id>/.env      # APP_REPO=<absolute path of the app's Git worktree root>
```

Rules, enforced by the adapter:
- **App id:** `a-z`, `0-9`, `-`.
- **`.env` file:**
  - a regular file (not a symlink), not group- or world-writable, at most 4 KiB;
  - only `APP_REPO`, one `KEY=value` per line, comments with `#`;
  - no quotes, `$`, backticks or other shell characters. The file is **parsed as data**, never sourced.
- **`APP_REPO`:** must be the root of an existing, non-bare Git worktree, separate from the Software Factory checkout.
- **Never exposed.** `.env` is refused by `factory_read_file`, and `factory-data/` is not in Git. The adapter never writes `APP_REPO` into anything ChatGPT can read.
- **Not executable without a configuration.** An app without `.env` (for example `sf-pilot`) is registered but not executable.
- **One `/implement` only.** The app repository must **not** have its own `.claude/skills/implement`. The session must load your personal skill (`~/.claude/skills/implement`); preflight refuses a repository that would replace it.

## Run one job

The job must be accepted first: `factory_request_dispatch` returned `accepted`. Run the adapter **from your own terminal**, not from inside a Claude Code session: there Claude saves no transcript and the adapter refuses.

```bash
cd ~/IdeaProjects/software-factory          # or wherever this checkout is
(cd bridge && npm run build)                # once after updates
scripts/sf006-execute.sh preflight <app-id> <job-id>
scripts/sf006-execute.sh prepare   <app-id> <job-id>
scripts/sf006-execute.sh run       <app-id> <job-id>
```

1. **`preflight`** is read-only. It checks:
   - the terminal (not inside a Claude session);
   - the app configuration;
   - that `instruction.md`'s SHA-256 equals the accepted one;
   - that `dispatch.json` and `openclaw-receipt.json` are valid and `accepted` (SF-005 rules);
   - the OpenClaw receiver's own record for that request id, through one fixed read-only `docker compose exec … cat`;
   - that the app repository is clean outside `.software-factory/` and the destination is free;
   - Claude Code installed and logged in, the personal `/implement` skill present and not shadowed.
2. **`prepare`** asks `y/N`. It repeats the checks, then copies the instruction byte-for-byte to `.software-factory/jobs/<job-id>/instruction.md` in the app repository, using an exclusive create and a SHA-256 check. It writes `execution.json` (`prepared`) in the mediator job directory. A different existing copy is never overwritten. `.gitignore` and other app files are not touched, so the copy shows up as an **untracked** file in the app repository.
3. **`run`** needs an interactive terminal and asks `y/N`. It starts **one** interactive Claude Code session in the app repository:

   ```text
   claude --permission-mode manual --session-id <new uuid> --name sf-<app-id>-<job-id> "/implement .software-factory/jobs/<job-id>/instruction.md"
   ```

   - **First use in a repository:** Claude shows its workspace trust dialog. Its default is "No, exit"; choose to trust the repository yourself.
   - **Permission mode:** `manual` is set on purpose. Without it, Claude Code 2.1.310 starts in auto mode, where tool calls are approved without asking. Answer every permission prompt yourself.
   - **Other dialogs:** Claude may show tips or onboarding dialogs, for example "Teach auto mode about your environment?". Dismiss them with Esc; they are not part of the job.
   - **When `/implement` is done,** end the session with `/exit` or Ctrl+D.
   - **Confirm the end.** The adapter asks *"Did /implement finish its work…?"*. Answer `y` only if it really finished; Claude Code also exits with code 0 when it is merely closed. `n` gives `interrupted`.
   - **Then** the adapter collects results and prints the final state.

**If you prefer to start Claude yourself,** run `handoff` instead of `run`. It sets `pending_manual` and prints the exact `cd` and command, with its pre-assigned session id, to your terminal. Since SF-007 Review 01 the command is wrapped in `flock … claude-session.lock`, so it takes the session gate (below). It refuses with exit code 75 while another session runs. Run it, end the session, then:

```bash
scripts/sf006-execute.sh collect <app-id> <job-id>      # asks whether /implement finished and the session ended
```

## States (`execution.json`)

| State | Meaning |
|---|---|
| *(accepted)* | SF-005 receipt only; no `execution.json` yet |
| `prepared` | Acceptance verified, instruction copied and verified |
| `running` | The session was claimed and started; session id, pid and start time recorded |
| `pending_manual` | Handed to you; the adapter does not start Claude |
| `completed` | All of these hold: <br>• you confirmed `/implement` finished (after exit code 0 for `run`); <br>• the session transcript shows your personal `/implement` skill invoked with this instruction, as the first message, in the app repository; <br>• HEAD and the Git index are unchanged; <br>• the results were exported. <br>**It does not mean the work is correct.** |
| `failed` | Git HEAD/index changed (`git_changed`, takes precedence), non-zero exit (`claude_exit`), no transcript (`transcript_missing`), `/implement` not shown (`skill_not_invoked`), or the runner did not start |
| `interrupted` | Signal (`claude_signal`), end not confirmed (`not_confirmed`), or the adapter stopped while the session ran (`adapter_interrupted`) |
| `needs_inspection` | The results were not exportable: credential-style paths changed (also Git-ignored ones, also inside ignored directories), content conversions on changed paths, credential-like text, the app path in the diff, more than 1000 changed files or a diff over 2 MiB, an ignored tree that could not be checked completely, collection failed, or the result files could not be written |

- **One session per job.** `launch.claim` in the job directory is created exclusively before any session starts (`run` or `handoff`) and is never removed. A job with a claim never launches again, even if `execution.json` were edited. A file lock (pid + start time + boot id) also refuses concurrent commands on the same job.
- **One session on this host (SF-007 Review 01).**
  - `run` takes a host-wide session gate before it claims the job: an OS lock on `~/.local/state/software-factory/claude-session.lock`, held by the Claude process itself until it ends. The SF-007 operator console uses the same gate.
  - While another session holds it, `run` stops with `session_busy`: nothing is claimed, and the job stays `prepared`. Run it again later.
  - `preflight` shows the gate.
  - `handoff` is refused while it is held, and also while a recorded hand-started session still runs. That covers a session handed off or resumed, including a resumed `completed`/`failed`/`needs_inspection` job, found by its session id.
  - If the gate's helper does not answer or end in time, the command stops with `gate_unresponsive` and nothing is claimed. See `docs/runbooks/SF-007-local-operator.md`, "Recovery".
  - Requires `python3` and util-linux `flock`. Details and recovery: `docs/runbooks/SF-007-local-operator.md`.
- **`needs_inspection` / `launch_unconfirmed` (Review 02).** The job was claimed, but the adapter could not confirm that Claude Code started: the gate helper ended before handing over, or Claude ended at once. Inspect the app repository yourself. The job never launches again; use a new job id.
- **"Running sessions cannot be verified: …".** `run`, `handoff` and `preflight` refuse while a record or directory under `factory-data/apps` cannot be checked for a live hand-started session. See the table in `docs/runbooks/SF-007-local-operator.md`, "Recovery".
- **`interrupted`.** Run `flock --nonblock --conflict-exit-code 75 ~/.local/state/software-factory/claude-session.lock claude --resume <session-id>` in the app repository to look at or finish the session, then `collect` again and confirm. The state becomes `completed` only with the same evidence, and is recorded as `operator_confirmed`.
- **A `running` job whose adapter stopped:**
  - `collect` checks whether a Claude process with that session id still runs (`still_running`).
  - Otherwise it uses the observed exit if there was one; if not, the job becomes `interrupted` unless you confirm the end.
- **`failed` / `needs_inspection`** are final for this job id. Inspect the repository yourself; for another attempt, use a new job id.
- **`status`** is read-only. It also tells whether the session's process is still alive.

## Results (mediator job directory, readable through `factory_read_file`)

| File | Content |
|---|---|
| `report.md` | State, how the end is known, request id, instruction SHA-256, session id, runner version, start/end, exit code or signal, transcript evidence, HEAD before/after, index unchanged, changed paths, Claude's last message (excerpt, filtered) |
| `implementation.diff` | Changes against the HEAD before the session: tracked changes plus new untracked files, as diffs. Excludes `.software-factory/` |
| `new-files.md` | New untracked files with size, SHA-256 and export status (binary or over 1 MiB: listed only); new Git-ignored entries by name |
| `checks.md` | Acceptance checks of `prepare` and `run`; the fixed Git commands of the collection with exit codes; shell commands from the session transcript with Claude Code's ok/error status (not exit codes); host paths replaced with `<app-repo>` and `~` |
| `execution.json` | State machine, session, evidence, Git state before/after, and SHA-256 of the four files above |

**Export filter (not a general secret detector).** Nothing is exported, and the state is `needs_inspection`, when:
- a changed path is credential-style: `.env`, `.env.*` except the examples, `.npmrc`, `.netrc`, `.git-credentials`, `id_rsa`, `id_ed25519`, `*.key`, `*.p12`, `*.pfx`, anything under `.git`;
- a Git-ignored credential-style file appeared or changed;
- the diff contains private-key headers or common token shapes;
- the diff contains the app repository's host path.

Other Git-ignored files are never exported; new ones are listed by name.

**Git inspection runs nothing the repository configures.** Git applies clean filters whenever it compares working-tree content: `git status`, `git diff` and `git hash-object` all do (Review 02). So the adapter:
- runs only `rev-parse`, `config --get`, `check-attr`, `ls-files`, `ls-tree` and `cat-file` inside the repository, with `core.fsmonitor=false`, `protocol.allow=never` (no lazy fetch), `--no-optional-locks` and no inherited `GIT_*`;
- finds working-tree changes by hashing files itself as Git blobs;
- builds diffs with `git diff --no-index` in a temporary directory outside the repository, without system/global configuration or attribute files.

Paths with content conversions (`filter`, `ident`, `working-tree-encoding`, or `eol`/`text`/`core.autocrlf` on files with carriage returns) are not compared as raw bytes:
- a dirty repository with them is refused at `prepare` (`unsupported_conversions`);
- changed paths with them after a session give `needs_inspection`.

Git LFS repositories therefore cannot be used yet.

**Ignored files.**
- **What is checked.** Credential-style files are checked inside ignored directories too, but not inside nested `.git` directories.
- **Private baseline.** Their names and content fingerprints are kept in `factory-data/apps/<app-id>/.env.sf006-ignored-<job-id>` (0600). `factory_read_file` refuses it like `.env`; `execution.json` holds only counts.
- **When the export is withheld.** An ignored tree that is unreadable, larger than 200,000 entries, or holds more than 1000 credential-style files cannot be checked completely, so the export is withheld.

**The private baseline must prove a finished scan** (Review 04). It is a strict JSON object `{entries, credentials, complete}` with a required boolean `complete`.
- **Invalid:** a file that misses `complete`, has a non-boolean value or extra keys, or whose credential map is not a string-to-string object (including keys that a parser would drop, such as `__proto__`). Reason: "not readable as a baseline".
- **Incomplete:** a file with `complete: false`. Reason: "records an incomplete check".
- **Only `complete: true`** supports an export.
- **Older private files** without `complete` now fail closed.

**What the ignored-file check compares.**
- **Two directions.** It compares both ways: credential-style entries that appeared, disappeared (also together with their whole ignored directory) or changed. Any of these withholds the export, reported by counts only.
- **Symlinks.** Credential-named symlinks are recorded by a SHA-256 of their own target bytes and are never followed. A symlink to a directory is never walked into, so changes behind it, outside the repository, are not seen. Other entry types are recorded by type only.

**A withheld export** keeps only the reason, as categories and counts. No paths, transcript commands or messages, and no Claude output reach the mediator.

**If the result files cannot be written,** the job becomes `needs_inspection` (`artifacts_failed`, with the outcome it would have had). Files already written in that attempt are removed.

## Legacy records (before Review 02)

**Exposure boundary.**
- `factory_read_file` can read every `execution.json`.
- Records written before Review 02 store the ignored-file baseline there as `ignored_initial`: ignored entry names, credential file names and their content fingerprints.
- Records written since keep it in the private `.env.sf006-ignored-<job>` (refused by `factory_read_file`); their `execution.json` has `ignored_initial: null` and only counts.
- Fingerprints of low-entropy secrets could be guessed offline, so legacy `ignored_initial` content counts as sensitive.

**Policy (Review 03), without modifying any record.**
- **Never a baseline.** A legacy `ignored_initial` is never used as a baseline. A job without a valid private baseline cannot pass the ignored-file check: missing, not a regular file, a symlink, unparsable or oversized all give `needs_inspection` with a fixed reason. This holds whatever `complete` a legacy record claims.
- **No silent rewrites.** Historical records are never rewritten or removed by the adapter.
- **Earliest-format records** (from before the first SF-006 review) lack later fields. They are refused as `invalid_record` and left unchanged.

**Audit (read-only):**

```bash
scripts/sf006-execute.sh audit-legacy
```

- **Output, one line per job that has an `execution.json`:**
  - app and job id;
  - `record`: `ok` for the current schema, `legacy-format` for the schema marker without the current schema (an earlier SF-006 format or a malformed field), or `unreadable, UNVERIFIED (<issue>)`;
  - the state, only when it is one of the adapter's states, otherwise `-`;
  - `ignored_initial`: `absent`, `null`, counts, `malformed`, or `unknown` (unverified record);
  - the private baseline: `valid`, `invalid` or `missing`.

  No names, fingerprints, malformed values, raw JSON or host paths are printed.
- **`malformed`** (Review 04) means any non-null `ignored_initial` that does not match the strict legacy shape exactly:
  - extra keys;
  - non-string entries or fingerprints;
  - an array as the credential map;
  - a non-boolean `complete`;
  - keys a parser would drop.

  A malformed field counts as exposing names, even when its visible containers are empty.
- **Coverage (Review 05).** Exposure and coverage are reported separately. The audit fails closed: what it cannot inspect is unknown, never clean.
  - **Verified record:** `execution.json` meets all of the following. Only verified records are counted as not exposing names.
    - a regular file (not a symlink), at most 1 MiB, read in full;
    - valid UTF-8;
    - a JSON object with the execution schema marker;
    - no duplicate keys;
    - only fields of the record schema, each of its current type. Earlier formats may lack fields; `ignored_initial` is judged by the legacy checks above.
  - **Unverified record** (`UNVERIFIED (<issue>)`): the file exists, but its contents are not fully known. `ignored_initial` is `unknown` unless the record parsed. A parsed record whose legacy field exposes names still says `EXPOSES NAMES`; otherwise its exposure is unknown, never clean. The issue is one of:

    | Issue | Meaning |
    |---|---|
    | `symlink` | `execution.json` is a symlink (also a dangling one); never followed |
    | `not_regular` | a directory, FIFO or other non-regular file |
    | `too_large` | larger than 1 MiB |
    | `unreadable` | any other I/O error, e.g. no permission |
    | `invalid_utf8` | not valid UTF-8 |
    | `invalid_json` | not parseable as JSON (e.g. truncated), even if it visibly contains names |
    | `not_record` | JSON, but not an object with the execution schema marker |
    | `duplicate_key` | a key appears twice in one object; `JSON.parse` keeps only the last value, but `factory_read_file` shows both |
    | `unknown_shape` | a field outside the record schema, a field of another type, or a `__proto__` key |

  - **Coverage gap** (`<repository-relative path>: COVERAGE GAP (...)`): a directory on the way that was not inspected. The path is built from verified ids only:
    - `factory-data` or `factory-data/apps` that is a symlink, not a directory, or cannot be listed — the audit stops there;
    - an app, `jobs` or job directory that is a symlink (never followed, even when it stays inside the mediator and `factory_read_file` could resolve it), not a directory, or cannot be listed or inspected;
    - entries in `factory-data/apps` or in a `jobs` directory whose names are outside the id pattern (counted, names never printed).

    The audit continues with the other apps and jobs after a gap.
  - **Not a gap:**
    - a job directory without `execution.json` (only `ENOENT` counts; any other error is unverified) — a job not yet prepared, counted as "without execution.json";
    - a registered app without a `jobs` directory (it gets one with its first job);
    - **never initialized:** `factory-data` or `factory-data/apps` does not exist (`ENOENT`). The audit prints `factory-data/apps does not exist: never initialized, no execution records.` and exits 0: there is no record that `factory_read_file` could read.
- **Exit code:**
  - 0 only when every record and directory was inspected and no record may expose names (`Audit coverage complete: ...`);
  - 1 when any record may expose names (non-empty or malformed `ignored_initial`), **or** coverage is incomplete (any unverified record or coverage gap, `Audit FAILED: coverage INCOMPLETE ...`), even if no inspected record exposes names.
- **Limits of the audit.**
  - It judges the content of `ignored_initial` only, the field that held the baseline. Other string fields of a verified record are checked for their type, not for their text.
  - It opens `execution.json` only. Other files in a job directory are not audited, for example a `.execution.json.<uuid>.tmp` left behind by a crash during a write.
  - Under `factory-data`, it walks `apps` only. With `factory-data` present and `apps` missing, it reports "never initialized" and exits 0.
- **State on 2026-10-26** (`review/SF-006/logs/review05/audit-legacy.log`):
  - 9 records: 8 verified, 1 unverified; 0 known to expose names; 0 coverage gaps; 13 jobs without `execution.json`. **Exit 1.**
  - `demo-20261026a` is unverified (`unknown_shape`). It was written by a development build that predates the first SF-006 package and stored `changed_paths` as a count, not a list. It has no `ignored_initial`. It stays unchanged until an operator decides (remediation below).
  - `demo-20261026b/c/d` carry an empty legacy `ignored_initial`.

**Remediation alternatives.** Each needs an explicit operator decision; none is performed.

| Option | What changes | Compatibility | Verification |
|---|---|---|---|
| A. Keep as is (current choice) | Nothing | None | Run `audit-legacy` after any change to `factory-data`; exit code 0 means every record was inspected and none exposes names |
| B. Redact legacy records | For each record the audit flags: back up `execution.json` (outside `factory-data`, 0600); move `ignored_initial` into `.env.sf006-ignored-<job>` (0600); set the field to `null`; record a note in the job directory | The record's bytes change. The artifact hashes in `execution.json` cover the four result files only, so they stay valid; dispatch and receipt files are untouched. The redacted job still never uses the moved data as a baseline | SHA-256 of the record before and after, kept with the backup; `status` still reads the job; `audit-legacy` exits 0; `factory_read_file` refuses the new private file |
| C. Hide legacy records from MCP | `factory_read_file` refuses an `execution.json` that carries a non-null `ignored_initial` | ChatGPT loses read access to those jobs' state; a change to the MCP reader's policy | A smoke test that the reader refuses such a record and still reads current ones |

## What stays manual

- Registering apps and writing `.env`.
- Starting `prepare` and `run` (or `handoff` + `collect`) for each job.
- Answering Claude's trust and permission prompts, and confirming the end.
- Reviewing the results.
- Staging, committing and pushing in the app repository. "Done" is your push.
- Removing `.software-factory/jobs/<job-id>/` from the app repository when you no longer need it.

**Future trigger seam:**
- **Today.** OpenClaw cannot start host processes (offline, no mounts, no Docker socket), and nothing polls.
- **Later.** An event from the accepted receipt (for example a bridge or tunnel notification) could tell the operator, or an approved local launcher, to run `preflight`/`prepare` for a job id. The adapter's commands take only `<app-id> <job-id>`, so such a trigger never needs to pass paths or commands.

## Boundaries

- **Not a sandbox.**
  - The Claude session runs as you, with your permissions, in your terminal. Its working directory being the application repository does not confine it.
  - The protection is Claude Code's permission prompts in manual mode, which you answer.
  - A session you approve can change anything you can change, including Git configuration that a later `collect` reads.
- **Transcript format.** It is internal to Claude Code and changes between versions; the docs say so explicitly. The adapter's evidence fails closed: an unrecognised transcript gives `failed` (`transcript_missing` or `skill_not_invoked`), never `completed`.
- **Linux only.** Process identity uses `/proc`.
- **Single host.** Locks, claims and liveness checks are per host. Do not run the adapter for the same mediator from two machines.
- **Claude Code is required.** It must be installed and logged in for the operator. Its credentials stay where Claude Code keeps them; nothing is copied into Docker or the mediator.
- **Clean worktree.** `prepare` refuses an app repository with uncommitted or untracked work outside `.software-factory/`. Commit or stash it yourself first; the adapter never touches it.
- **Raw comparison.**
  - Working-tree changes are raw-byte comparisons, as `git hash-object --no-filters` would compute them. Repositories that rely on content conversions are refused instead (see above).
  - `core.fileMode=false` is respected.
  - Submodule commits are not inspected.
  - Comparing a large repository reads every tracked file once per snapshot (streamed).
