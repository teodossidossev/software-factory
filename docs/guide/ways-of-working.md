# Ways of working

This page gives end-to-end recipes, each a numbered walkthrough from an idea to a merged change:
alone on a product repository, several tickets through the queue, with a coordinating Claude Code
session, with ChatGPT, and in a team.

All recipes assume the factory is installed and `sf serve` runs ([Install](install.md)).

## 1. A developer alone on a product repository

You work on `my-app` in IntelliJ (or any IDE) at `~/work/my-app`, and you want the factory to do a
ticket while you do something else, then review the result in your IDE and push it yourself.

1. Register the repository once, with hand-over on (the default):
   `sf workspace add my-app --read ~/work/my-app`.
2. On the dashboard press **New ticket**: workspace `my-app`, key `APP-12`, the title "Export the
   report as CSV", and in your words what you want. Paste a screenshot if it helps.
3. Plan it: open the ticket's page and write the Task file in *Edit* (the [example in
   Planning](planning.md#4-writing-the-task-file-by-hand)), or press *Open the ChatGPT
   conversation ↗* and let ChatGPT write it ([recipe 4](#4-planning-with-chatgpt-and-running-locally)).
   Include `scope:` and a `## Review brief`. *Save*.
4. Wait a minute for the automatic Task check (the card shows `checking…`, then `check: ready` or
   `not ready: …`). Read its findings on the Plan check card, fix the Task file, save again.
5. Press **Start**, confirm. The card moves to Implementing, then Reviewing; you get a notification
   only when you are needed. Keep your checkout clean of uncommitted changes to tracked files by the
   time the job finishes (or commit your own work on another branch), so the hand-over can switch
   it.
6. If the job stops (Your turn, with a reason), do what its button says
   ([When a job stops](when-a-job-stops.md)): answer a question, accept a finding, tell it to go
   on.
7. When it is ready, the notification says "in your checkout on `APP-12-export-the-report-as-csv`".
   Your IDE now shows the branch with the job's changes as Local Changes. Read them, run the app and
   the tests, change what you want.
8. Want something changed by the Implementer instead? Type it in the job's composer and press *Ask
   for changes*; your own edits go with it. The job comes back to your checkout when it is clean
   again.
9. Commit in the IDE (the message is prefilled with the MR text; edit it as you like), push, and
   open the merge request on GitHub or GitLab.
10. On the job's page press **I opened the MR myself** (or wait: the page notices your push). The
    job is `pushed`.
11. Merge on the host after your team's review, delete the remote branch, and press **Archive
    ticket** on the Done card.

## 2. Several tickets at once through the queue

You have three tickets: `APP-12` (the CSV export), `APP-13` (an export button that needs `APP-12`'s
code) and `APP-14` (unrelated). You want them to run one after another, or two at a time, without
starting each by hand.

1. Write the three Task files ([Planning](planning.md)). In `APP-13`'s front matter, add
   `lands_after: [APP-12]` and keep `base: main`: the queue starts `APP-13` only once `APP-12` is
   merged into `main`, so it starts from `APP-12`'s code. (To build on `APP-12` before its merge,
   set `base: APP-12-export-the-report-as-csv` and start `APP-13` by hand; its merge request then
   targets that branch. The queue waits for the merge either way.)
2. Set how many jobs may run at once: the board's "Run up to [− N +] jobs at once", or
   `sf queue limit 2`.
3. Add the tickets in the order you want: *Add to queue* on each card, or

   ```sh
   sf queue add my-app APP-12
   sf queue add my-app APP-13
   sf queue add my-app APP-14
   ```

4. The queue starts a ticket only when its Task check is `ready`. The automatic checks run by
   themselves; fix what they find. Use *Start anyway* (`sf queue force my-app APP-14`) for a ticket
   you want to run whatever the check says.
5. `sf serve` starts `APP-12` and, with a limit of 2, `APP-14` (it skips `APP-13`, whose card says
   "Waits for APP-12 (running)"). `sf queue list` shows the same: the limit, the running count, the
   next ticket, and what each entry waits for.
6. Take each finished job as in recipe 1, or push it from the Merge request screen.
7. Once `APP-12` is **merged** (its merge request recorded merged, or its branch in `origin/main`;
   press *Refresh MR status* after merging on the host), the queue starts `APP-13` within five
   minutes.
8. Reorder by dragging cards; hold everything with `sf queue hold "release Friday"` and go on with
   `sf queue release`.

When a usage limit is hit, the parked job keeps its slot and the queue starts nothing until the
reset; the rule `sf queue on-limit resume-then-queue` (default) then resumes it and goes on.

## 3. With a coordinating Claude Code session

This is how this repository develops itself; the user's rules for that session are in the
[coordinator runbook](../runbooks/coordinator.md). A Claude Code session in your terminal is the
**coordinator**: it discusses the work with you, writes the Task files, runs the queue, reads the
results and opens and merges the merge requests, while the factory's jobs do the implementing and
reviewing, each with a fresh context.

1. Run the factory from a second clone ([Install (b)](install.md#b-a-second-clone-used-only-to-run-the-factory)),
   so the coordinator can change the factory's code in the development clone without touching
   running jobs.
2. Register the workspace with hand-over off, so your checkout is not switched to every job's
   branch: `sf workspace add my-app --read ~/work/my-app --handoff off`, and set
   `SF_GITHUB_TOKEN` (or `SF_GITLAB_TOKEN`) in `auth.env` so the factory can open and merge merge
   requests.
3. Discuss the plan with the coordinator. It writes each ticket's Task file directly into
   `~/work/my-app/.software-factory/` with the whole design: goal, decisions, behaviour, out of
   scope, tests, docs, acceptance, the Review brief, `scope` and `lands_after`. It asks you the
   decisions only you can make before writing.
4. It runs the Task check on larger Task files (`sf check-task my-app APP-12`) and fixes what it
   finds.
5. It queues the tickets (`sf queue add my-app APP-12`, `sf queue limit 3`) and waits for the jobs
   with a background watcher, not by polling, reading only short summaries (`sf status`, the
   states, verdicts and counts), never whole logs.
6. When a job stops, it reads the reason and answers (`sf say`, `sf settle`, `sf accept`), or asks
   you.
7. When a job is `ready_for_human_review`, it leaves the MR text as it is (the push must carry the
   prepared commit's message) and runs `sf mr create my-app APP-12`, then, after review,
   `sf mr merge my-app APP-12`.
8. After the merge: `sf reset my-app APP-12`, the Task file moved to
   `.software-factory/archive/`, the remote branch deleted, and, for the factory's own repository,
   the second clone updated and `sf serve` restarted, then `sf smoke`.

Give a coordinator only what it needs: it may run `sf` commands and read the job states, but your
tokens and `auth.env` values are never printed, and the dashboard URL is shown as `/d/<token>/`.

### Zen: asking the coordinator for a status

A click on Zen's screen on the board's Coordinator card asks the coordinator for a status. The
small lights blink while it thinks. The bar flickers while the new status shows. After 2 minutes
without one the card says the coordinator is not answering.

<img src="img/zen-rest.svg" alt="Zen at rest" width="120"> <img src="img/zen-thinking.svg" alt="Zen thinking" width="120"> <img src="img/zen-speaking-6.svg" alt="Zen speaking, the lights spelling 6" width="120"> <img src="img/zen-speaking-9.svg" alt="Zen speaking, the lights spelling 9" width="120">

At rest; thinking; speaking. While Zen speaks, the small lights left on spell a number in binary.
Read them like a page, left to right and top to bottom: the two above the bar, the four down the
right, then below the bar the two upper ones (left, right) and last the lower one between them;
the first is the largest bit (256), the last is 1. Lights 000000110 = 4 + 2 = 6;
000001001 = 8 + 1 = 9. For now the number is a random one; it will be the jobs landed today.

## 4. Planning with ChatGPT and running locally

You like to think a ticket through in ChatGPT; the factory runs locally.

1. Set up the tunnel and the connector once ([Planning: with ChatGPT](planning.md#1-with-chatgpt-through-the-tunnel),
   [connection runbook](../runbooks/chatgpt-connection.md)).
2. Start the factory with `npm start` (`sf up`): `sf serve`, the tunnel and the dashboard. Check
   `sf info`: `tunnel` should say `ready`.
3. **New ticket** on the dashboard: workspace, key, title, your words, any screenshots.
4. On the ticket's page press **Open the ChatGPT conversation ↗**. ChatGPT gets the first message
   with your words and the instructions; press Enter if it is not sent.
5. Discuss. ChatGPT reads the repository and the images through the connector, proposes the plan,
   writes the Task file with `write_task`, waits for the automatic Task check, fixes it, and tells
   you it is ready.
6. Read the Task file on the ticket's page. Start it, or ask ChatGPT to put it in the queue
   (`queue_add`).
7. From here on ChatGPT is not involved: the job runs, the factory's reviewers review it, and you
   take the result as in recipe 1 or push it from the Merge request screen.

## 5. A team

The factory is a **single-user local tool**: one person, one machine. `sf serve` listens only on
`127.0.0.1`, the dashboard is protected by one token, jobs run with that person's Claude and Codex
logins and Git credentials, and there is no notion of users, sharing or remote access. Colleagues
each run their own.

**What each colleague installs on their own machine** ([Install](install.md#prerequisites)):
Node.js 24, Git with push access, Claude Code logged in with their own plan, the agents' skills
installed with the `skills` tool, the Codex CLI logged in with their own ChatGPT account (or the gate off), a clone of the
factory (`npm run setup`), and, if they plan with ChatGPT, their own tunnel and connector.

**What is per person:**

| Per person | Where |
| --- | --- |
| the install and its version | their clone(s) |
| settings, tokens, models, limits | their `~/.config/software-factory/auth.env` |
| workspaces (paths of their checkouts) | their `workspaces.json` |
| personal coding rules | their `rules/<workspace>.md`, `rules/global.md` |
| jobs, queue, Task checks, history, dashboard token | their `~/.local/state/software-factory/` |
| Claude and Codex usage limits | their plans |
| the ChatGPT tunnel and connector | their OpenAI and ChatGPT accounts |

**What can be shared:**

- **The coding rules in the repository**: `AGENTS.md` and the Markdown files it links to reach
  every colleague's agents the same way; put the team's rules there, not in personal files.
- **The agents' skills, by installing the same ones**: they come from each user's
  `~/.agents/skills` (`implement`, `tdd`, `code-review`, `grilling`, installed with the `skills`
  tool), copied verbatim at each job's start ([The agents' skills](../../factory/README.md#the-agents-skills));
  the factory does not take them from the repository. A repository's own `.claude/skills` are not
  hidden: they still load in the Implementer's session as its project skills, read-only.
- **Task files**: they are plain Markdown. `.software-factory/` is excluded from Git in each
  checkout, so share a Task file by sending it, or keep the team's Task files in a separate
  folder or repository and copy the one you take into your checkout's `.software-factory/`.
- **The process**: the Handbook's Task file format, the review rules, the Git rules and the MR
  template are the same in every install of the same version.

**What it does not support:**

- several people on one factory: no shared server, no logins, no remote dashboard;
- a shared queue or dependencies across machines: `lands_after` sees only your own Task files and
  jobs (a colleague's ticket shows as `missing`);
- locking a ticket: two colleagues who start the same ticket create the same branch name, and the
  second push collides; agree who takes which ticket;
- Jira or another tracker: the ticket key is a name, nothing more.

Next: back to the [guide's start](README.md).
