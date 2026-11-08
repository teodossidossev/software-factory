// The globals the typed page scripts (web/) use from the scripts still in static/ (SF-146 to SF-149). Each
// is typed as narrowly as its definition there allows; SF-147 to SF-150 remove a declaration when they
// convert the file that defines it. A global declaration file: no import or export.

// static/routing.js: the view shown (ui, only the fields the typed scripts read and write), the
// routing, the focus a card's button asked for, Esc's way back to the board and the drawing of the
// jobs.
declare const ui: {
  screen: string;
  job: string | null;
  ticket: string | null;
  opener: string | null;
  pending: boolean;
  sel: number;
  open: Set<string>;
  related: string | null;
  cx: {
    view: CxView;
    sel: string | null;
    cursor: string | null;
    rows: TreeRow[];
    q: string;
    flat: boolean;
    collapsed: Set<string>;
    mode: 'side' | 'uni';
    collapse: boolean;
    unfolded: Set<string>;
    check: string | null;
    tree: boolean;
  };
};
declare function go(key: string, screen?: string, focus?: 'composer' | 'stop', confirm?: string): void;
declare function applyWantedFocus(): void;
declare function back(): void;
declare function renderJobs(): void;
// static/routing.js: the URL hash of the view shown.
declare function setHash(): void;

// static/setup.js: one request of a form or a ticket's action; its result, or undefined when it
// was not sent or did not succeed.
declare function setupRequest(what: string, path: string, body: unknown, statusId: string, describe: (result: unknown) => Outcome): Promise<unknown>;

// static/setup.js: the confirmation a card asked the job page to open.
declare function openWantedConfirm(): void;

// static/setup.js: the job page and the drawer close; a form's status line (or the toast) shows an
// outcome, or is cleared with null; the setup forms and the board are drawn again; Start or Delete
// of a ticket asks first (extra: what the planned ticket page adds to Start's text).
declare function leaveJob(): void;
declare function hideDrawer(): void;
declare function setSetupStatus(id: string, outcome: Outcome | null): void;
declare function renderSetup(): void;
declare function openTicketConfirm(action: 'start' | 'delete', row: TicketEntry, extra?: string): void;

// static/main.js.
declare function openStream(): void;
