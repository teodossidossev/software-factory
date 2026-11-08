// The globals the typed page scripts (web/) use from the scripts still in static/ (SF-146, SF-147). Each is
// typed as narrowly as its definition there allows; SF-147 to SF-150 remove a declaration when they
// convert the file that defines it. A global declaration file: no import or export.

// static/reports.js.
declare const SVG_NS: 'http://www.w3.org/2000/svg';

// The words of a stop's code in STOPS (static/board.js): only what job-screens.ts reads.
interface StopWords {
  reason: string;
  sentence: (job: JobRow) => string;
}

// static/job-page.js.
declare function whyLines(buttons: readonly HTMLElement[]): HTMLElement[];
declare function availability(action: string, job: JobRow | null): string;
declare function mrAvailable(): boolean;
declare function run(action: string, key: string, body: object): Promise<void>;

// static/board.js.
declare function sentence(job: JobRow): string;
declare function shownIteration(job: JobRow): number;
declare function stopEntry(code: unknown): StopWords;
declare function toast(outcome: Outcome | null): void;
declare function jobByKey(key: string | null): JobRow | null;
declare function mrOff(job: JobRow): string;

// static/routing.js: the view shown (ui, only the fields job-screens.ts reads), the routing and the
// focus a card's button asked for.
declare const ui: {
  screen: string;
  job: string | null;
  sel: number;
  open: Set<string>;
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

// static/ticket-page.js.
declare function inl(text: unknown): Node[];
declare function md(text: unknown, mark: (line: string) => string): HTMLElement;
declare function tkCounts(output: CheckOutput | null | undefined): { blocker: number; major: number; nit: number };

// static/setup.js: one request of a form or a ticket's action; its result, or undefined when it
// was not sent or did not succeed.
declare function setupRequest(what: string, path: string, body: unknown, statusId: string, describe: (result: unknown) => Outcome): Promise<unknown>;

// static/main.js.
declare function openStream(): void;
