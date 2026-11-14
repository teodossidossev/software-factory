// The dashboard's pins: numbered marks the user places on an element of the page in point mode
// (web/pins.ts), each with the page's hash, a selector, the element's text, its position and an
// optional note, which the coordinator reads with sf pins. In <state dir>/pins.json
// ({ version: 1, next, pins: [Pin, ...] }), written atomically with mode 0600 by sf serve only: the
// dashboard's checked POSTs and the sf pins commands, one write at a time per file. A missing file
// is no pins; a file that is not JSON or not this shape is refused on every read and write
// (pins_unreadable) and only sf pins clear replaces it. Every string is bounded and holds no control
// character (text and note: none but \n and \t), so nothing sf pins prints is acted on by a terminal.
// Below the store, the sf pins commands of src/commands.ts's table (spread into its COMMANDS) and
// how the CLI prints their answers.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import type { Answer, Command, Result } from './commands.js';
import { stateDir as serveStateDir } from './config.js';
import { FactoryError } from './errors.js';

export const PINS_FILE = 'pins.json';
export const pinsFile = (stateDir: string): string => join(stateDir, PINS_FILE);

// The bounds, in characters as JavaScript counts them (UTF-16 code units).
export const MAX_ROUTE_CHARS = 300;
export const MAX_SELECTOR_CHARS = 1000;
export const MAX_TEXT_CHARS = 200;
export const MAX_NOTE_CHARS = 500;
// A rect's x and y lie within ±MAX_COORDINATE; w, h, vw and vh within 0 and MAX_COORDINATE.
export const MAX_COORDINATE = 1_000_000;
// The open pins at most; of the resolved ones only the newest MAX_RESOLVED_PINS are kept.
export const MAX_OPEN_PINS = 50;
export const MAX_RESOLVED_PINS = 50;

// Every control character (C0, DEL, C1); the free texts may hold \n and \t.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// The length as JavaScript counts it (zod's max counts otherwise), as the page counts it.
const bounded = (max: number, control: RegExp) => z.string().refine((value) => value.length <= max, `longer than ${max} characters`)
  .refine((value) => !control.test(value), 'holds a control character');
const line = (max: number) => bounded(max, CONTROL);
const free = (max: number) => bounded(max, CONTROL_BUT_LINES);
// z.number() refuses NaN and the infinities.
const coordinate = z.number().min(-MAX_COORDINATE).max(MAX_COORDINATE);
const size = z.number().min(0).max(MAX_COORDINATE);
const NOTE = free(MAX_NOTE_CHARS);

// POST api/pins's body: a new open pin, as the page measured it.
export const PIN_INPUT = z.strictObject({
  route: line(MAX_ROUTE_CHARS), selector: line(MAX_SELECTOR_CHARS), text: free(MAX_TEXT_CHARS),
  rect: z.strictObject({ x: coordinate, y: coordinate, w: size, h: size, vw: size, vh: size }), note: NOTE,
});
export const PIN_INPUT_SHAPE = '{"route": string, "selector": string, "text": string, "rect": {"x": number, "y": number, "w": number, "h": number, "vw": number, "vh": number}, "note": string}';
// POST api/pins/<id>'s body: a new note, resolved or open again; at least one of them.
export const PIN_CHANGE = z.strictObject({ note: NOTE.optional(), resolved: z.boolean().optional() })
  .refine((change) => change.note !== undefined || change.resolved !== undefined, 'changes nothing');
export const PIN_CHANGE_SHAPE = '{"note"?: string, "resolved"?: boolean}, at least one of them';
// POST api/pins/<id>/remove's body.
export const PIN_REMOVE = z.strictObject({});

const PIN = PIN_INPUT.extend({ id: z.number().int().min(1), at: z.iso.datetime(), resolved: z.boolean() });
const FILE = z.strictObject({ version: z.literal(1), next: z.number().int().min(1), pins: z.array(PIN) })
  .refine((file) => file.pins.every((pin, index) => pin.id < file.next && file.pins.findIndex((other) => other.id === pin.id) === index), 'an id not below next, or one given twice');

export type PinInput = z.infer<typeof PIN_INPUT>;
export type PinChange = z.infer<typeof PIN_CHANGE>;
export interface Pin {
  id: number;
  route: string;
  selector: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number; vw: number; vh: number };
  note: string;
  at: string;
  resolved: boolean;
}
interface PinsFile { version: 1; next: number; pins: Pin[] }
// What GET api/pins and every write answer: every stored pin, in id order.
export interface PinsView { pins: Pin[] }

const EMPTY: PinsFile = { version: 1, next: 1, pins: [] };

// The stored pins; none when the file is missing. A file that is not JSON or not the shape above
// is pins_unreadable.
async function readFileState(stateDir: string): Promise<PinsFile> {
  let text: string;
  try {
    text = await readFile(pinsFile(stateDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return EMPTY;
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch { // not JSON: refused below as not the shape
    data = undefined;
  }
  const parsed = FILE.safeParse(data);
  if (!parsed.success) {
    throw new FactoryError('pins_unreadable', `${PINS_FILE} in the factory's state directory is not a pins file the factory can read; nothing is written over it. sf pins clear replaces it with an empty one.`);
  }
  return { version: 1, next: parsed.data.next, pins: [...parsed.data.pins].sort((a, b) => a.id - b.id) };
}

// GET api/pins and sf pins: every stored pin in id order.
export async function readPins(stateDir: string): Promise<PinsView> {
  return { pins: (await readFileState(stateDir)).pins };
}

// The writes of each file one after the other, each reading what the one before wrote: change
// gets the stored pins (or, from clearPins, undefined for an unreadable file) and gives the new
// ones with its result. The resolved pins beyond the newest MAX_RESOLVED_PINS are dropped.
const queues = new Map<string, Promise<unknown>>();
function update<T extends object>(stateDir: string, change: (file: PinsFile | undefined) => { file: PinsFile; result: T }, overUnreadable = false): Promise<T & PinsView> {
  const path = pinsFile(stateDir);
  const done = (queues.get(path) ?? Promise.resolve()).then(async () => {
    const stored = await readFileState(stateDir).catch((error: unknown) => {
      if (overUnreadable && error instanceof FactoryError && error.code === 'pins_unreadable') {
        return undefined;
      }
      throw error;
    });
    const { file, result } = change(stored);
    const dropped = new Set(file.pins.filter((pin) => pin.resolved).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id)).slice(MAX_RESOLVED_PINS));
    const pins = file.pins.filter((pin) => !dropped.has(pin));
    await writeFileAtomic(path, Buffer.from(`${JSON.stringify({ version: 1, next: file.next, pins }, null, 2)}\n`));
    return { ...result, pins };
  });
  const settled = done.catch(() => undefined);
  queues.set(path, settled);
  void settled.then(() => {
    if (queues.get(path) === settled) {
      queues.delete(path);
    }
  });
  return done;
}

const openCount = (file: PinsFile): number => file.pins.filter((pin) => !pin.resolved).length;
const tooMany = (): FactoryError => new FactoryError('too_many_pins', `${MAX_OPEN_PINS} pins are open already; resolve or delete one first.`);

function pinOf(file: PinsFile, id: number): Pin {
  const pin = file.pins.find((each) => each.id === id);
  if (pin === undefined) {
    throw new FactoryError('pin_not_found', `There is no pin ${id}.`);
  }
  return pin;
}

// A body checked again by the store itself, for a caller that did not check it (the callers are
// async: a refusal is a rejection, before the write is queued).
function checked<T>(schema: z.ZodType<T>, value: unknown, shape: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new FactoryError('invalid_body', `A pin expects ${shape}, within its bounds and without control characters.`);
  }
  return parsed.data;
}

// POST api/pins: a new open pin with the next id.
export async function addPin(stateDir: string, input: PinInput, now = new Date()): Promise<{ pin: Pin } & PinsView> {
  const given = checked(PIN_INPUT, input, PIN_INPUT_SHAPE);
  return update(stateDir, (file = EMPTY) => {
    if (openCount(file) >= MAX_OPEN_PINS) {
      throw tooMany();
    }
    const pin: Pin = { id: file.next, ...given, at: now.toISOString(), resolved: false };
    return { file: { ...file, next: file.next + 1, pins: [...file.pins, pin] }, result: { pin } };
  });
}

// POST api/pins/<id> and sf pins resolve: the pin's note, resolved or open again. A pin opened
// again counts toward the open pins.
export async function changePin(stateDir: string, id: number, change: PinChange): Promise<PinsView> {
  const given = checked(PIN_CHANGE, change, PIN_CHANGE_SHAPE);
  return update(stateDir, (file = EMPTY) => {
    const pin = pinOf(file, id);
    if (given.resolved === false && pin.resolved && openCount(file) >= MAX_OPEN_PINS) {
      throw tooMany();
    }
    const changed: Pin = { ...pin, note: given.note ?? pin.note, resolved: given.resolved ?? pin.resolved };
    return { file: { ...file, pins: file.pins.map((each) => (each === pin ? changed : each)) }, result: {} };
  });
}

// POST api/pins/<id>/remove: the pin is gone; its id is not given again.
export function removePin(stateDir: string, id: number): Promise<PinsView> {
  return update(stateDir, (file = EMPTY) => {
    const pin = pinOf(file, id);
    return { file: { ...file, pins: file.pins.filter((each) => each !== pin) }, result: {} };
  });
}

// sf pins clear: every pin removed and the ids from 1 again, in a new file, also over an unreadable
// one (whose pins count as none).
export function clearPins(stateDir: string): Promise<{ removed: number } & PinsView> {
  return update(stateDir, (file) => ({ file: EMPTY, result: { removed: file?.pins.length ?? 0 } }), true);
}

// ------------------------------------------------------------------ sf pins

// A pin id as typed: a whole number from 1, without a leading zero, of any length.
export const PIN_ID = /^[1-9]\d*$/;

// The stored pin's number of an id as typed (PIN_ID). The ids are safe integers, so one beyond them
// names no pin: pin_not_found with the id as typed, never a rounded number that could be another.
export function pinIdOf(text: string): number {
  const id = Number(text);
  if (!Number.isSafeInteger(id)) {
    throw new FactoryError('pin_not_found', `There is no pin ${text}.`);
  }
  return id;
}

// The open pins as sf pins prints them: '<id>  #<route>  "<text>"', the board's route as board,
// then the note indented; a \n or \t printed as a space.
export function pinsLines(pins: readonly Pin[]): string[] {
  const flat = (text: string): string => text.replace(/[\n\t]/g, ' ');
  const open = pins.filter((pin) => !pin.resolved);
  if (open.length === 0) {
    return ['No open pins.'];
  }
  return open.flatMap((pin) => [
    `${pin.id}  #${pin.route === '' ? 'board' : pin.route}  "${flat(pin.text)}"`,
    ...(pin.note === '' ? [] : [`  note: ${flat(pin.note)}`]),
  ]);
}

// The commands of the table in src/commands.ts (spread into its COMMANDS): sf serve runs them, the
// writes one at a time with the dashboard's. They touch no job, so they answer while sf update
// drains or builds.
export const PINS_COMMANDS = {
  pins: {
    name: 'pins', args: [], openWhileUpdating: true,
    description: 'The open pins the user placed on the dashboard in point mode (Shift+P): id, the page\'s route, the element\'s text and the note',
    run: () => readPins(serveStateDir()),
  },
  pinsResolve: {
    name: 'pins resolve', args: ['<id>'], openWhileUpdating: true,
    description: 'Mark a pin resolved (also one resolved already): it leaves the dashboard at the page\'s next read of the pins',
    refuse: ([id = '']) => (PIN_ID.test(id) ? undefined : 'id must be a whole number from 1.'),
    run: async (_s, [id = '']) => ({ id: pinIdOf(id), ...(await changePin(serveStateDir(), pinIdOf(id), { resolved: true })) }),
  },
  pinsClear: {
    name: 'pins clear', args: [], openWhileUpdating: true,
    description: 'Remove every pin, open and resolved, and start the ids at 1 again (a new pins.json, also over an unreadable one)',
    run: () => clearPins(serveStateDir()),
  },
} satisfies Record<string, Command>;

// How the CLI prints their answers.
export const PINS_ANSWERS: ReadonlyArray<[Command, (result: Result) => Answer]> = [
  [PINS_COMMANDS.pins, (result) => ({ lines: pinsLines(result.pins as Pin[]), failed: false })],
  [PINS_COMMANDS.pinsResolve, (result) => ({ lines: [`Resolved pin ${String(result.id)}.`], failed: false })],
  [PINS_COMMANDS.pinsClear, (result) => {
    const removed = Number(result.removed);
    return { lines: [`Removed ${removed} ${removed === 1 ? 'pin' : 'pins'}.`], failed: false };
  }],
];
