# Review and merge

This page covers the ways to take a finished job: the hand-over to your own checkout, pushing and
opening the merge request from the factory, editing the MR text, and what happens after.

When both reviews are clean, MR preparation has left the job's branch with **one commit**, rebased
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
| let the factory push | **Approve…** | `sf approve my-app APP-12` | Without a commit of yours, the factory pushes its own commit and moves your branch to it ("Pushed the factory's commit …"); your uncommitted edits stay local and are not pushed. With your own commits on top of the base, it pushes the branch as it is ("Pushed your commit …"). |
| have the factory push and open the MR | **Create merge request** | `sf mr create my-app APP-12` | The push, then the merge request on GitHub or GitLab (below). |
| ask the Implementer for changes | **Ask for changes** (the composer's Send) | `sf say my-app APP-12 "<message>"` | Your edits go back into the job (below), and a new turn starts. |
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
sf mr status my-app APP-12          # open, merged or closed, mergeable or why not, the checks
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
  the host is chosen from `origin`'s URL (`github.com` is GitHub, any other host GitLab).
- **Merge** merges an open merge request through the host's API, as a merge commit, never by a
  push. A draft, a conflict, failing required checks or missing approvals refuse it
  (`mr_not_mergeable`, with the host's reason); nothing changes then.
- **Refresh MR status** reads what the host says now and records a merge or close done there.

Approve stays for those who open merge requests themselves: push with Approve, then follow the link.

## Editing the MR text

The Implementer writes the MR text by the [MR template](../../factory/HANDBOOK.md#mr-template): the
title `<type>(<ticket>): <summary>` (at most 72 characters, also the commit header), then `## What`,
`## Why`, `## How`, `## Why the change`, `## Special things to note`, `## Change outline`,
`## Testing`, `## Screenshots` and `## Checklist`. The factory adds `### Nits not applied`, `###
Review findings not fixed` and, when you skipped the simplification pass, `### Simplifications not
applied`.

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
- Merge on the host (or *Merge…*, `sf mr merge`). The factory does not delete the remote branch; do
  it on the host or with `git push origin --delete APP-12-…` once merged.
- **Archive ticket** on the Done card (or Archive on the job's page) moves the Task file (and its
  images) to `.software-factory/archive/` and retires the job from the board; Restore brings it
  back from the *Archived* drawer. `sf reset my-app APP-12` archives the job record.
- Tickets that wait for this one (`lands_after`) can start once it counts as **merged**: its merge
  request is recorded `merged`, or (with no merge request recorded) its branch is in
  `origin/<base>`. After a merge on the host, *Refresh MR status* (`sf mr status`) records it.
- The saved refs `refs/factory/APP-12` and `refs/factory/APP-12-ask` are deleted by `sf serve` seven
  days after the job is pushed or aborted.

The details: [MR preparation](../../factory/README.md#mr-preparation),
[Hand-over to your checkout](../../factory/README.md#hand-over-to-your-checkout),
[Merge request screen](../../factory/README.md#merge-request-screen).

Next: [When a job stops](when-a-job-stops.md).
