# Review and merge

This page covers the ways to take a finished job: the hand-over to your own checkout, pushing and
opening the merge request from the factory, editing the MR text, and what happens after; and a
job from the review comments of a merge request already open.

When the reviews are clean, MR preparation has left the job's branch with **one commit**, rebased
onto the base, with the MR text as its message. Nothing is pushed yet. You get a notification, and
the job is either **handed over** to your checkout (`handed_over`, the default) or waits in
**`ready_for_human_review`** (hand-over off, or refused).

## 1. The hand-over to your checkout

With hand-over on, the factory puts the job's result into the workspace's checkout, the one open in
your IDE, so you read, run, debug and change it there.

**What you get:**

- your checkout is switched to the job's branch, `APP-12-<slug>` (the slug is the title in lower
  case, other characters as `-`, at most 40 characters);
- the branch is at the base commit and **the job's changes are uncommitted Local Changes**; new
  files are added with `git add -N`, so the IDE lists them;
- the **commit message is prefilled**: the MR title and description are in
  `.git/factory/APP-12.commit-msg`, and your checkout's local `commit.template` points at it (with
  `commit.cleanup=scissors`, so the `#` headings survive). `git commit` opens your editor with it; an
  IDE that reads `commit.template` shows it too. The factory puts both settings back when the job
  leaves `handed_over`;
- the job's own commit is kept as `refs/factory/APP-12`, so nothing is lost.

The board says "In your checkout on `APP-12-export-the-report-as-csv`"; `sf status` and the
notification say the same.

**When it does not happen.** The factory never overwrites your work. The hand-over is refused, and
the job stays in `ready_for_human_review` with the reason, when your checkout has changes to
tracked files (`checkout_dirty`), a rebase or merge is in progress (`checkout_busy`), a file is in
the way (`handover_refused`), or another job of the workspace holds the sandbox's config lock
(`config_locked`: it runs by itself when that job ends). Clean up and press **Hand over to my
checkout**, or:

```sh
sf handover my-app APP-12
```

**Per workspace.** `handoff` in `workspaces.json` (`"checkout"` or `"off"`, set with
`sf workspace add my-app --read ~/work/my-app --handoff off` or the Workspaces drawer) wins over
`SF_HANDOFF` (default `checkout`). Use `off` for a checkout that must not switch to every job's
branch, for example when a coordinating session merges through `sf mr create` and `sf mr merge`.
It is read when the job is ready, so a change applies to running jobs too.

**Then, in `handed_over`, you finish in one of these ways:**

| You want to … | Button | Command | What happens |
| --- | --- | --- | --- |
| push it yourself | *I opened the MR myself* (after your push) | `sf handed-done my-app APP-12` | Commit (edit the message as you like), push from your IDE, open the merge request on the host. The factory marks the job `pushed` once `origin` has the branch with a commit that descends from the base; the job's page also notices your push by itself (it asks `origin` at most once a minute). Refused with `not_pushed` until then. |
| say you merged it | **Merged — archive** (on the card and in the job's panel; also on a pushed job's Done card and page) | `sf handed-done my-app APP-12 --merged` | You merged the changes, any way: a merge request on the host, another branch name, straight into the main branch; the branch may already be deleted. Press it twice: the first click arms it ("Click again to archive"), a second click within 4 seconds runs it. The job is marked merged and archived in one step, without the factory asking `origin` or the host: the commit template and the prefilled message go from your checkout as after a push, the worktree goes and the Task file moves to the archive. Your branch, commits and edits stay, and no branch is deleted anywhere. From another device you type the ticket to confirm. |
| let the factory push | **Approve…** | `sf approve my-app APP-12` | Without a commit of yours, the factory pushes its own commit and moves your branch to it ("Pushed the factory's commit …"); your uncommitted edits stay local and are not pushed. With your own commits on top of the base, it pushes the branch as it is ("Pushed your commit …"). |
| have the factory push and open the MR | **Create merge request** | `sf mr create my-app APP-12` | The push, then the merge request on GitHub or GitLab (below). |
| ask the Implementer for changes | **Ask for changes** (the composer's Send) | `sf say my-app APP-12 "<message>"` | Your edits go back into the job (below), and a new turn starts. |
| have a small fix made quickly | **Quick fix** (beside Send on a ready job; beside Ask for changes in the hand-over panel) | `sf quickfix my-app APP-12 "<message>"` | Ask for changes, one turn, then MR preparation with no review round while the change stays small; the job comes back to your checkout (Quick fix, below). |
| give the job back to the factory | **Take it back** | `sf takeback my-app APP-12` | Your checkout returns to the branch it was on, the job goes back to `ready_for_human_review` with its worktree. Only while your checkout is as the factory left it (`takeback_changed` otherwise). |
| drop it | **Abort…** | `sf abort my-app APP-12` | The job ends; your checkout and the branch stay as they are (`--discard` is refused here). |

### Ask for changes

Ask for changes is `sf say` on a handed-over job. Your checkout must still be on the job's branch
(`checkout_moved` otherwise). The factory takes a snapshot of everything in your checkout (your
edits and commits, new files; not your own untracked files from before), saves it as
`refs/factory/APP-12-ask`, switches your checkout back to the branch it was on before the
hand-over, and continues the job from the snapshot: your edits are uncommitted changes in the job's
worktree, and the Implementer gets your message. The change goes through review and Clean again, and
the next ready hands it over again.

### Quick fix

A small fix to a change you are reviewing (a CSS line, a typo) need not cost a review round:
`sf quickfix my-app APP-12 "<message>"` on a job in `ready_for_human_review` or `handed_over`
(refused in any other state: use `sf say`). On a handed-over job it is Ask for changes first. On
the job's page it is the **Quick fix** button: on a ready job beside Send, once *Ask for a change*
opens the message box; on a handed-over job beside **Ask for changes** in the hand-over panel. It
sends the message box's text, and is off while the box is empty. The
Implementer gets your message and is told to make only that change and to run only the fast checks
of the files it touches. When the turn ends, the factory measures the change since the tree you
had (your checkout's edits count too):

- **Quick** when it has at most `SF_QUICK_FIX_MAX_LINES` added plus deleted lines (30) in at most
  `SF_QUICK_FIX_MAX_FILES` files (2), no binary file or submodule, and no sensitive, security,
  `may_touch`, `SF_GATE_FULL_PATHS`, agents' instructions or out-of-scope path. The job goes
  straight to MR preparation: the guard's scan, the test step, the MR text turn (given the MR text
  to keep, changing only what the fix makes wrong), the tree check, the rebase. No Claude review,
  no Codex gate. A job that came from your checkout is handed over again, whatever the hand-over
  setting says; one that was `ready_for_human_review` is ready again as usual.
- **Full** otherwise: the job says why (`quick fix goes through the full loop: size: 31 lines`)
  and the change goes through review and Clean as any iteration.

A stop inside a quick fix (failing tests after their fixes, the guard, MR preparation) goes on
with `sf say`, which ends the quick fix: the next iteration is reviewed. `sf accept` and `sf retry`
refuse there, as on any iteration without a clean review.

## 2. Pushing and opening the merge request from the factory

From `ready_for_human_review` (and from `handed_over`) the factory can push for you.

**The Merge request screen** (`m` on the job's page; *Review the MR and push* on the card): the
branch, the base, the MR title and the description, with a side panel showing the commit message,
what the change carries (files, the last verdicts, the gate's tokens, the fix rounds, the target),
the lines under `Not checked:` and the checks of the MR rules. The bar has:

- *Push branch only*: Approve, the push of the prepared commit;
- *Push and open MR ↗*: the push, then the merge request (hidden, with the reason, when the
  workspace's host has no token);
- *Save* (Ctrl+S) and *Reset to factory text* for the MR text.

**The commands:**

```sh
sf approve my-app APP-12            # push the branch prepared at Clean
sf approve my-app APP-12 --as-is    # push a branch tip you changed by hand
sf mr create my-app APP-12          # open the merge request (from ready_for_human_review: push first)
sf mr status my-app APP-12          # open, merged or closed, mergeable or why not, the checks (finds one you opened yourself)
sf mr merge my-app APP-12           # merge it through the host's API (a merge commit)
```

- **Approve** pushes `origin <branch>` and nothing else. It refuses a branch tip that is not the
  commit the factory prepared (`branch_changed`: you edited the branch by hand) unless `--as-is`
  (on the dashboard: "Push the branch as it is"). It never pushes to `main`, `master` or the base
  (`mr_push_protected`). After the push the job is `pushed`, the worktree is removed, and the answer
  gives a link to open the merge request (GitHub's compare page, GitLab's new merge request form).
  A failed push stops the job (`mr_push_failed`): Push again.
- **Create merge request** opens a pull request (GitHub) or merge request (GitLab) from the branch
  into the base, with the MR title and description; an open one for the branch is reused. It needs
  `SF_GITHUB_TOKEN` or `SF_GITLAB_TOKEN` ([Configuration](configuration.md#push-and-merge-request-providers));
  the host is chosen from `origin`'s URL: `github.com` is GitHub; the host of `SF_GITLAB_URL` when
  it is set, else `gitlab.com`, is GitLab; any other host is refused (`mr_host_unsupported`).
- **Merge** merges an open merge request through the host's API, as a merge commit, never by a
  push. A draft, a conflict, failing required checks or missing approvals refuse it
  (`mr_not_mergeable`, with the host's reason); nothing changes then.
- **Refresh MR status** reads what the host says now and records a merge or close done there.

Approve stays for those who open merge requests themselves: push with Approve, then follow the link.

### A merge request you opened yourself

When you pushed the branch and opened its merge request yourself (from the IDE, after a
hand-over), the job has no merge request recorded. *Refresh MR status* finds it: in
`handed_over` (the hand-over panel's **More ▾**), `ready_for_human_review` and `pushed`, the
factory asks the host for an **open** merge request from the job's branch into its base.

- One found: it is recorded as the job's merge request (a `merge_request` event, action `found`),
  and the answer is the same as for one the factory opened: its state, draft, mergeable or why
  not, and the checks or the pipeline, after the line "Found by branch APP-12-…".
- Several found: the newest, and the line says "(newest of N open)".
- None: "No open merge request for branch APP-12-…"; nothing is recorded.

Later refreshes read the recorded one by its number, and a merge or close on the host is
recorded as for any other. The lookup only reads (`GET`): a **read-only token** (GitLab:
`read_api`; GitHub: Pull requests read, Checks read) is enough for the state, the pipeline and
the review comments (`sf mr comments`). Create merge request and Merge still need a token that may
write, and your action.

## Editing the MR text

The Implementer writes the MR text by the [MR template](../../factory/HANDBOOK.md#mr-template): the
title `<type>(<ticket>): <summary>` (at most 72 characters, also the commit header), then `## What`,
`## Why`, `## How`, `## Why the change`, `## Special things to note`, `## Change outline`,
`## Testing`, `## Screenshots` and `## Checklist`. The factory adds only the result of the workspace's
test command, as `### Checks` under `## Testing`. Its own notes (the nits not applied, the review
findings not fixed, an Accept over a stop and the simplifications you skipped) are shown under the
text on the Merge request screen, and are never committed or pushed.

The text speaks to your colleagues: it never names the factory's decisions or findings by id, nor
who decided what. The factory refuses a text that holds its notes' headings or such an id, and
names the lines of the description to delete (a job prepared before this rule shows them at Save
and at Push).

On the Merge request screen you can change it in `ready_for_human_review` (and after a failed or
refused push):

- edit the **title** and the **description** (*Edit* | *Preview*); the page checks the rules as you
  type (the title's form, the required headings, no manual check claimed as run) and the factory
  checks again at **Save** (`mr_text_invalid` otherwise);
- on Save the factory rewrites the prepared commit's message to your text (same tree, author and
  date), so the push carries exactly what you see;
- rename the **branch** or change the **base**, only before the first push (`branch_locked` or
  `base_unrelated` say why not);
- *Show changes against the factory's text* and **Reset to factory text** bring the factory's text
  back.

Your saved text stays the MR text when the job goes round again (Ask for changes, a fix): a new
Clean writes the factory's new text aside ("The factory wrote a new text … Compare · Reset to
factory text"). In `handed_over` the text is read-only on the page ("Take it back to edit the MR
text"); edit the commit message in your IDE instead. After the push it is read-only.

## What happens after

- The job is `pushed` (Done column: "Pushed · 2 iterations · 14:05", with the merge request's
  number, state and link once the factory knows one). Its worktree is gone; the branch stays in your
  checkout and on `origin`.
- Merge on the host (or *Merge…*, `sf mr merge`). `sf mr merge` and *Merge…* delete the merged
  branch on the host; after a merge on the host, delete it there or with
  `git push origin --delete APP-12-…`.
- **Archive** on every Done card (pushed, aborted or failed) and on the job's page asks first
  ("Archive the job: its worktree is removed and it leaves the board. The branch and its commits
  stay."), then does what `sf reset` does: it ends the session, removes the worktree and archives
  the job record. While the ticket's Task file is active it also moves the Task file (and its
  images) to `.software-factory/archive/`; Restore brings it back from the *Archived* drawer. The
  branch and its commits are never touched. From another device it asks you to type the ticket.
- **A merged job leaves by itself.** A minute after `sf serve` starts and then every 10 minutes,
  the factory looks at every pushed job and every handed-over job, and archives as Archive does the
  ones it finds merged, after recording `merged_on_target` in the job's history:
  - the merge request it recorded is merged (no request to the host);
  - with a host token for the workspace (`SF_GITHUB_TOKEN` or `SF_GITLAB_TOKEN`): the host reports
    the recorded merge request merged, or, with none recorded, a merge request of the job's branch
    into its base that was merged after the job started (the one you opened by hand from the
    handed-over branch counts). Only `GET` requests go to the host; a host error is logged once and
    the next check runs;
  - for a pushed job only: its commit is in `origin/<base>` after a fetch of the base
    (`git fetch --no-tags origin <base>` in your checkout, which only updates `origin/<base>`, never
    a branch or a file). A fetch that fails leaves the jobs alone and is logged once.

  A squash or rebase merge leaves no commit of the job in the base, so only the host finds it; in a
  workspace without a host token, press **Merged — archive**. A handed-over job is archived only on
  the host's word (no ref of your checkout is read for it, nothing fetched), after the same first
  step as Merged — archive. A job that continues an existing branch (`continues`) is never looked up
  on the host. This pass deletes no branch and no commit.
- Tickets that wait for this one (`lands_after`) can start once it counts as **merged**: the factory
  found it on its base (`merged_on_target`), its merge request is recorded `merged`, or (with no
  merge request recorded) its branch is in `origin/<base>`. After a merge on the host, *Refresh MR
  status* (`sf mr status`) records it.
- The saved refs `refs/factory/APP-12` and `refs/factory/APP-12-ask` are deleted by `sf serve` seven
  days after the job is pushed or aborted.

## A job from review comments

When a merge request (yours or a colleague's) has review comments on the Git host, the factory can
implement them on that merge request's branch:

1. Open **Merge requests** in the top bar: the chosen workspace's open merge requests are read at
   once, one compact row each, newest update first. A row shows the pipeline (passed, failed,
   running), whether the merge request can be merged (*Ready to merge*, or *Not ready* and why),
   *Rebase needed: N behind main* when its branch lacks commits of the target, and a red SonarQube
   badge only when SonarQube found a problem (a failed gate or new issues). Choosing another
   workspace reads its list at once. **Refresh** reads everything again; *Read 14 min ago* beside
   it says how old the rows are. Nothing reads the host while the page is closed.
2. Press a row's comments button (or its title): its review threads, the open ones first (the
   resolved ones behind *Show resolved*, the bots' comments, SonarQube's long summaries among them,
   behind *Show bot comments*).
3. Tick the comments to implement, and write **Your instructions** if you want more ("fix this and
   that"); instructions alone are enough.
4. Press **Create job**. The factory reads the comments from the host again and writes a Task file
   `<key>-review-<n>` (for example `SF-12-review-1`, or `MR-7-review-1` when the branch names no
   ticket) that continues the merge request's branch, and adds it to the run queue; the page links
   to its ticket page. It runs as any job: the Task check, the reviews, Clean.

Nothing is written to the host: no reply, no resolve. The change reaches the merge request in one
of two ways, as the workspace's hand-over setting decides:

- **handed over** to your checkout: you look at it there, commit and push the merge request's
  branch yourself;
- **Approve**: the factory pushes its one commit onto the merge request's source branch (never
  forced), so the open merge request shows it and keeps its title and description.

The details: [MR preparation](../../factory/README.md#mr-preparation),
[Hand-over to your checkout](../../factory/README.md#hand-over-to-your-checkout),
[Merge request screen](../../factory/README.md#merge-request-screen),
[Merge requests](../../factory/README.md#merge-requests).

Next: [When a job stops](when-a-job-stops.md).
