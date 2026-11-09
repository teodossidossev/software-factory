# Header redesign: three layouts and improvements per view

Prototype: http://127.0.0.1:8799/ux/?v=1 · ?v=2 · ?v=3 (placeholder data; the floating
PROTOTYPE bar switches layouts, toggles a failing health check and the theme).

## The three layouts

### v1: one slim top bar (header only)
One 48 px row: logo and name, "1 waits for you", the page tabs (Board, Digest, Stats, Archived 119,
Workspaces), a workspace dropdown (full names and counts), a single factory pill (health dot +
"2/2 running"), New ticket. The pill's popover holds the 10 checks, the run limit and the reset rule.
Below 1100 px a second row: a page dropdown and the workspace dropdown, each half the width.
- Kanban: full width. At 1280 px each column with cards is about 240 px; the header is 48 px. On a
  phone the header is 2 rows (about 88 px).
- Gains: the least chrome; what needs me sits top-left, where the eye starts; nothing truncates.
- Costs: the run limit, the queue's next ticket and the rule are one click away (today you see them
  without clicking); the row is full at 1280 px with a long workspace name selected.

### v2: left nav rail + slim top bar
The rail holds New ticket, the five pages (icon + label) and the workspace filter as a list (long
names wrap, with counts). The top bar keeps the page title, waits for you, health, the run limit
inline and the rule. The rail folds to 60 px of icons (the default below 1440 px). On a phone it
slides in from the menu button.
- Kanban: with the 60 px rail, 1220 px are left at 1280 (about what you have today). The 232 px rail
  leaves about 1050 px, so about 200 px per column: too tight, which is why it starts folded. On a
  phone the rail covers the page and the board keeps the full width.
- Gains: pages and workspaces are always visible and read in full. The top bar has room for the run
  limit without crowding.
- Costs: the rail takes width the five columns need. With 5 pages and 3 workspaces it is mostly
  empty. Folded, the workspaces are bare dots.

### v3: top bar for navigation + IDE status bar + right drawer
The top bar is navigation only: logo, tabs, workspace, New ticket. A 30 px status bar at the bottom
shows the factory's state: health ("1 down · Sandbox leftovers"), slots (pips "2/2 running · 0
free"), "Q 1 · next: …", the reset rule, and "1 for you" at the far right. Any item opens a right
drawer with three tabs: Waits for you, Health, Run queue (limit, queued list, rule). New ticket opens
in the same drawer, like today's drawer.
- Kanban: full width. The drawer lies over the board and does not squeeze it. On a phone the bar
  shrinks to "● 1 down · 2/2 · Q 1 · 1 for you" and the drawer takes the full width.
- Gains: the state you watch all day is always in view and costs no header width. The drawer gives
  the health checks room.
- Costs: the bottom-right corner is the weakest place for "waits for you". The bar collides with the
  job page's pinned composer and the Merge request screen's push bar, which are both at the bottom,
  so it should show on the board only. The open drawer covers Your turn and Done.

**Recommendation:** v1. Borrow v3's drawer only for content that grows (health checks, an archived
ticket's Task file). A v4 that is worth building later: v1's top bar, plus v3's status bar on screens
of 1440 px or more, on the board only.

## Sidebars and footer: when they pay off here and when they don't
- **Left rail:** worth it when there are many places to go (7 or more) or many workspaces (6 or more) to
  switch between often. Today there are 5 pages and 3 workspaces, and the kanban needs every pixel of
  width, so it does not pay off. Revisit when the workspace list grows: then the workspace filter
  alone could go into a foldable rail.
- **Right sidebar / drawer:** worth it for secondary content that is long and read beside the board
  without leaving it: health checks, the New ticket form, an archived Task file (today's drawer does
  that well). It does not pay off as a permanent column on the board, because it takes width from
  Your turn and Done. The ticket page and the Merge request screen already have a 340 px right
  column. It helps at 1280 px and wider, but it clips long content (the first message in screenshot
  13), so long text belongs in the main column.
- **Footer / status bar:** worth it for state that changes by itself and you only glance at (health,
  slots, the queue's next ticket), as in an IDE. It does not pay off for things that need you
  (waits for you), which belong top-left. On a phone it costs 30 px plus the safe area. On the job
  page it clashes with the composer and the push bar.

## Board improvements in the prototype (all variants)
1. An empty or folded column gets a narrow track (about half width), and the columns with cards share the rest. Files: `web/board.ts` renderBoard sets `--tpl`; `static/app.css` `.cols`.
2. On a phone the columns stack with Your turn first, and an empty column is one line ("Reviewing 0 Nothing in review."). File: `static/app.css` (the 767 px media query).
3. A card's first line shows the key and the full workspace name (no more "ontolog…d-second"), and cost and time move to the meta line. Files: `web/board.ts` jobCard and queueCard, `shortName` goes; `static/app.css` `.card .row1`.
4. The "Now" line is readable ("running the tests (npm test)") instead of raw tool JSON (`Bash {"command":"cd /home/…`). File: `web/board.ts` jobCard.
5. One action per card: Your turn keeps "Review the MR and push", and the disabled "Create merge request…" next to it goes. Done shows Archive as a small link. File: `web/board.ts` jobCard.
6. The Queue column gets "In the queue (n)" and "Not queued (n)" labels, and its count includes both. "The queue is empty: add a ticket below" goes. File: `web/board.ts` (QUEUE_EMPTY, renderBoard).
7. "Waits for you" counts every workspace even when the filter is on. It says "(hidden)", and a click clears the filter and flashes the Your turn column. File: `web/board.ts` renderBoard (summary).

## Improvements per view (ranked)

### Board header (any variant)
1. The workspace filter becomes a dropdown with full names and counts, replacing the segmented chips with their middle ellipsis. Files: `web/board.ts` renderFilter; `static/app.css` `.seg2`.
2. The health light shows words when it is not green ("1 down"), and the separate "connecting" tag merges into it (the light already turns red after 30 s without the stream). Files: `web/health.ts`; `static/dashboard.html` `#connection`; `web/main.ts`.
3. "Rules ▾" shows its current value ("At reset: resume, then queue ▾"). File: `web/board.ts` renderRules.
4. The queue status says why nothing starts ("next: nothing ready (ACME-151 waits for ACME-123)"), not just "nothing ready". File: `web/board.ts` renderQueueBar.
5. Digest, Stats, Archived and Workspaces become tabs that show the current page, replacing buttons of equal weight. Files: `static/dashboard.html` `nav.ws`; `web/routing.ts`.

### Job page: Stream
1. The slim app header stays above the job page, so "waits for you" and health stay visible. "← Board" becomes a breadcrumb "Board › ACME-123". Files: `static/dashboard.html`; `web/job-page.ts` renderHead.
2. The head's second line is trimmed to state, iteration and cost. "(Claude, est.)" moves into the cost's tooltip, and the elapsed time and branch go behind a "Copy checkout" button. File: `web/job-page.ts` renderHead.
3. The Stream / Changes / Merge request switch moves under the title on the left, as tabs; the keys s/c/m stay. Files: `web/job-page.ts` renderHead; `static/app.css` `.switch`.
4. The composer shows the state's main action as the primary button on the right. Rare actions (Abort…, Take it back) go into More ▾. File: `web/job-page.ts` renderComposer.
5. When you have scrolled up, a "Latest (n new)" button jumps to the end of the stream. Files: `web/main.ts`; `web/job-screens.ts` (stream).

### Job page: Changes
1. Iterations become tabs in one toolbar row above the diff ("All · 1 · 2 · 3"), replacing the ◀ ▶ stepper. File: `web/job-screens.ts` renderChanges, iterLabel.
2. On a phone the file tree becomes a file dropdown above the diff, so a file is still one tap away without scrolling past the tree. Files: `web/job-screens.ts`; `static/app.css` (the 767 px media query).
3. The tree folds with `t`, and its width is remembered. File: `web/job-screens.ts` (divider).
4. "Flat list / Group by directory" becomes one icon toggle in the tree's header. File: `web/job-screens.ts` (around line 740).
5. `n`/`p` go to the next or previous file, and the diff header shows the file's +/− counts. File: `web/job-screens.ts`.

### Job page: Merge request
1. One primary button, "Push and open MR ↗". "Push branch only" and "Push it as it is" go into its split menu. File: `web/job-screens.ts` renderMr (`.mrbar` buttons).
2. The checks in the 340 px side panel become a one-line verdict above the form ("Title ok · 2 lines too long"), with details on demand. Files: `web/job-screens.ts` renderMrChecks; `static/app.css` `.form2 .grid`.
3. The title's rule hint shows only when the rule fails. Otherwise a counter ("58/72") sits at the field's right. File: `web/job-screens.ts` mrField.
4. Save and "Reset to factory text" move into the card head next to "edited by you", out of the bottom bar. File: `web/job-screens.ts` renderMr.

### Ticket page
1. The planning conversation (the first message) moves into the main column under the Task file, because the 340 px side column clips it (screenshot 13). File: `web/ticket-page.ts` (the side stack in renderTicket).
2. The plan check's verdict becomes a chip in the head ("Plan ready" / "not ready: 1 blocker"). Its card shows only the findings, and the 4-line explanation becomes the button's tooltip. File: `web/ticket-page.ts` tkHead, tkCheckCard.
3. "Starts from" and "Depends on" join the head's second line, and their two side cards go. File: `web/ticket-page.ts` renderTicket, tkHead.
4. The head's order: Start now (primary), Check the plan, then "Open the conversation ↗" as a plain link. File: `web/ticket-page.ts` tkHead.

### New ticket form
1. The workspace is preselected from the board's filter, and the key is prefilled with that workspace's next free key. File: `web/setup.ts`.
2. The "Context owner" fieldset goes until Claude Code is available (a single disabled option is noise). File: `static/dashboard.html` `#ticket-panel`.
3. The 3-line hint under "What you want" becomes one line, and the drop zone becomes a "Paste or drop images" line with thumbnails. File: `static/dashboard.html`.
4. Ctrl+Enter creates the ticket. In v1/v2 the form opens as a centred dialog; in v3 it stays in the drawer. Files: `web/setup.ts`; `static/app.css`.

### Digest
1. The Repositories / My daily switch moves into the page head as tabs. File: `web/reports.ts` renderDigest.
2. "since … · generated … · cost" becomes one muted line under the title. File: `web/reports.ts` renderDigest.
3. The digest picker reads "Mon 9 Nov 06:00 · scheduled", not a raw timestamp. File: `web/reports.ts` (dgTime).
4. With the board filtered, the digest opens at that workspace's card. File: `web/reports.ts` openDigest.

### Stats
1. Warnings come first as a short linked list. The "Now" tiles go, because the header already shows running, waiting and queued. File: `web/reports.ts` renderStats.
2. The page's own workspace select goes, and Stats follows the global workspace filter. File: `web/reports.ts` renderStats.
3. A row of section links at the top (Warnings · Second opinion · Review stages · Spend · Load · Jobs) for this long page. File: `web/reports.ts` stSection.
4. The 12-column jobs table shows Ticket, Title, State, Cost and Time to ready by default, and the rest behind "More columns". File: `web/reports.ts` stJobs.

### Archived
1. Archived becomes a page with a search box (key, title, workspace), replacing the drawer list of 119 cards. Files: `static/dashboard.html` `#archived-panel`; `web/setup.ts`; `web/routing.ts`.
2. One line per row (key · workspace · title · outcome · date), grouped by month, newest first. File: `web/setup.ts` (archived rows).
3. Restore and Delete… sit on the row, and a click on the row opens the Task file. File: `web/setup.ts`.

### Workspaces
1. One row per workspace: dot, full name, path, and small toggles for digest, My daily and hand-over. Edit opens the form for that row only. Files: `static/dashboard.html` `#workspaces-panel`; `web/setup.ts`.
2. "Add a workspace" folds behind a button, and each field's hint shrinks to one line (today 6 paragraphs show at once). File: `static/dashboard.html`.
3. The Morning digest settings (time, weekdays, language) get their own small card under the list. File: `static/dashboard.html` `#digest-form`.

### Health panel
1. Failing checks come first in a red block with detail and "since 10:43 (12 min)". Passing checks take one line each (dot, label, detail), so all 10 fit in about 260 px instead of about 900. Files: `web/health.ts`; `static/app.css` `.hpanel`.
2. A header line reads "1 of 10 checks down · checked 12 s ago", with a Check again button. File: `web/health.ts`.
3. "since 2026-11-09 10:40:01" becomes "since 10:40" for today. File: `web/health.ts`.
4. A failing check names its fix or offers the auto-recovery where the factory has one (e.g. Sandbox leftovers → reap). Files: `web/health.ts`; the server's health checks.
