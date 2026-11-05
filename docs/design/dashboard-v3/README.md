# Dashboard v3: the design reference

The user reviewed a clickable prototype on 2026-11-05 and said: "I want it exactly like this, or as
close as possible." This folder holds it as the reference every dashboard ticket implements.

- `prototype.html`: the prototype's markup, CSS and JavaScript, without its data snapshot. This is
  the reference for the code: reuse its CSS tokens and classes, its markup structure, its
  rendering functions and its keyboard shortcuts.
- The full prototype with the real data snapshot (3.6 MB, opens in a browser and works) is on the
  branch `prototype-dashboard-v3`, `docs/design/dashboard-v3/prototype-full.html`. Open it to see
  how each screen looks and behaves.

## How to implement against it

- Match it. Port the CSS verbatim into `factory/static/app.css` (tokens on `:root`, light and dark),
  keep its class names and markup structure, and keep the interactions and keys. Where the live
  page needs something the prototype lacks (an error, an empty state, a loading state), design it
  in the same style.
- Remove what only the prototype has: the PROTOTYPE badges, the floating bar with scenarios and the
  State panel, every "(prototype)" and simulated reply. Every action calls the real API.
- Data comes from the dashboard API and its event stream, never from a snapshot.
- When a ticket's behaviour and the prototype disagree, the ticket says which wins; otherwise the
  prototype wins.
- The coordinator checks every dashboard ticket by opening the real page next to the prototype.

## The screens

1. **Board.** Five kanban columns: Queue, Implementing, Reviewing, Your turn, Done. Cards: plain
   reason with the code as a small tag, one primary action only where the user acts, a "Now:" line
   on running cards, iteration, cost and elapsed time. The Queue column is ordered (drag and drop,
   Alt+Up/Down), with a "Not queued" part; the top bar has "Run up to N jobs at once", the queue
   status and the Rules menu (usage-limit rule).
2. **Job, full page**, three screens switched in its header (Stream `s`, Changes `c`, Merge request
   `m`); Esc goes back one level.
   - **Stream**: one chronological stream (Implementer text, tool calls as one expandable line
     each, the user's messages, Fix sections, Claude and Codex verdicts with findings, state changes
     and stops), with the composer and the actions that apply now pinned at the bottom. Keys j/k,
     Enter. Every path links to Changes at that file and iteration.
   - **Changes**: IntelliJ-like. File tree on the left (folders, modified blue, added green,
     deleted grey and struck through, M/A/D, +/− counts, filter, tree/flat), side-by-side or unified
     diff on the right with changed words highlighted and unchanged parts collapsed, F7/Shift+F7 and
     n/p between files, and an iteration selector (all changes or one iteration).
   - **Merge request**: branch, base, title and text (Edit | Preview), editable; side panel with
     the commit message, what the MR carries, the "Not checked" lines and the checks; Save, Reset to
     factory text, Push branch only, Push and open MR.
3. **Planned ticket, full page**: the Task file (Edit | Preview), front matter as fields, the Task
   check, the planning conversation, images, dependencies and history; Check and Start.

## Tickets

| Ticket | Scope |
| --- | --- |
| SF-077 | The v3 shell and the board: CSS, top bar, columns, cards, routing between full pages |
| SF-078 | Job page: header and the Stream screen with the composer |
| SF-079 | Job page: the Changes screen, with the API for file versions per iteration |
| SF-080 | Job page: the Merge request screen, with saving the MR text |
| SF-081 | Planned ticket page |
| SF-071 | The queue (board controls included) |
| SF-072 | The usage-limit rule (Rules menu included) |
