// sf planner waiting <workspace> [permission]: the planning copy's hook (Claude Code's Stop event,
// and its Notification event for a permission prompt), which tells the user through the factory's
// notifications that the planner waits for them. A Stop stays silent while the planner's own
// sub-agents or crons run, and when the user's last message is younger than QUICK_SECONDS (a quick
// answer in a live exchange); a permission prompt is always notified. The notification names the
// workspace, and in its title the ticket of a session sf planner start started (SF_PLANNER_TICKET,
// when it is a ticket key), with the session's page as its link, as the workspace's notify setting
// has it. A hook never fails the session: every failure is one line on stderr, never a rejection.
import { open } from 'node:fs/promises';
import { notifyConfig, plannerNotification, sendNotification, withNotifyMode } from './notify.js';
import { workspaceNotifyMode } from './registry.js';
import { TICKET_PATTERN } from './task-file.js';

export const QUICK_SECONDS = 45;
// The transcript's tail searched for the user's last message.
const TAIL_BYTES = 400_000;
// The most of stdin (the hook's event) read.
const STDIN_BYTES = 1024 * 1024;

// The last bytes of a file, at most bytes of them.
async function tail(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// A transcript entry that is the user's own message: not meta, not a sub-agent's, its content a
// string or parts holding text (a tool result has none).
function isOwnPrompt(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true || !isObject(entry.message)) {
    return false;
  }
  const content = entry.message.content;
  return typeof content === 'string' || (Array.isArray(content) && content.some((part) => isObject(part) && part.type === 'text'));
}

// Seconds since the user's last own message in the transcript's last 400 000 bytes; undefined when
// the file cannot be read or holds none.
export async function lastPromptAge(transcriptPath: string, now: Date): Promise<number | undefined> {
  let text: string;
  try {
    text = (await tail(transcriptPath, TAIL_BYTES)).toString('utf8');
  } catch { // a missing or unreadable transcript: no age, the Stop is notified
    return undefined;
  }
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[index]!);
    } catch { // an unparsable line (the tail's cut first line among them): the one before
      continue;
    }
    if (isObject(entry) && isOwnPrompt(entry)) {
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
      return Number.isNaN(at) ? undefined : (now.getTime() - at) / 1000;
    }
  }
  return undefined;
}

const nonEmptyArray = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

// Why a Stop stays silent: 'background' (sub-agents or crons run), 'live' (a quick answer), or
// undefined (notify).
export function silence(event: Record<string, unknown>, age: number | undefined): 'background' | 'live' | undefined {
  if (nonEmptyArray(event.background_tasks) || nonEmptyArray(event.session_crons)) {
    return 'background';
  }
  return age !== undefined && age < QUICK_SECONDS ? 'live' : undefined;
}

// The hook's event: stdin (at most STDIN_BYTES) as a JSON object, else {}.
async function readEvent(stdin: AsyncIterable<Buffer>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > STDIN_BYTES) {
      return {};
    }
  }
  try {
    const event: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isObject(event) ? event : {};
  } catch { // not JSON: an event with no fields
    return {};
  }
}

const say = (message: string): void => console.error(`sf planner waiting: ${message}`.replace(/\s+/g, ' ').trim());

export async function plannerWaiting(
  name: string, permission: boolean,
  deps: { env: NodeJS.ProcessEnv; configDir: string; stdin: AsyncIterable<Buffer>; now?: () => Date; send?: typeof sendNotification },
): Promise<void> {
  try {
    const event = await readEvent(deps.stdin);
    if (!permission) {
      const path = String(event.transcript_path ?? '');
      const age = path === '' ? undefined : await lastPromptAge(path, (deps.now ?? (() => new Date()))());
      if (silence(event, age) !== undefined) {
        return;
      }
    }
    const mode = await workspaceNotifyMode(name, deps.configDir);
    const ticket = deps.env.SF_PLANNER_TICKET;
    const notification = withNotifyMode(
      plannerNotification(name, permission, deps.env.CLAUDE_CODE_BRIDGE_SESSION_ID, ticket !== undefined && TICKET_PATTERN.test(ticket) ? ticket : undefined),
      mode, name);
    if (notification === undefined) {
      return;
    }
    for (const result of await (deps.send ?? sendNotification)(notification, notifyConfig(deps.env))) {
      if (result.status === 'failed') {
        say(`${result.channel} failed: ${result.message}`);
      }
    }
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
  }
}
