// The channel from the bridge to the SF-004 OpenClaw container. It runs three
// fixed docker commands, never a shell, with validated identifiers only:
//   1. receiver.mjs enqueue  (the request as JSON on stdin)
//   2. openclaw cron list    (find the provisioned receiver automation)
//   3. openclaw cron run <id> --wait
// A dispatch counts as accepted only when OpenClaw's own run record is ok and
// the run output acknowledges this exact request.
import { spawn } from 'node:child_process';

export const COMPOSE_PROJECT = 'software-factory-openclaw';
export const COMPOSE_SERVICE = 'gateway';
export const RECEIVER_AUTOMATION = 'sf-dispatch-receiver';
const RECEIVER_SCRIPT = '/home/node/.openclaw/sf-dispatch/receiver.mjs';
export const RECEIVER_ARGV: readonly string[] = ['node', RECEIVER_SCRIPT, 'accept'];
const RUN_WAIT = '60s';
const COMPOSE_FILE = 'deploy/openclaw/compose.yaml';
const COMMAND_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_CHARS = 1024 * 1024;

export interface DispatchRequest {
  request_id: string;
  app_id: string;
  job_id: string;
  instruction_sha256: string;
}

// OpenClaw's record of one run of the receiver automation.
export interface OpenClawRun {
  automation_id: string;
  run_id: string;
  status: string;
  completion_status: string;
  run_at_ms?: number;
  duration_ms?: number;
  error?: string;
  // Captured stdout of the receiver, as OpenClaw stored it.
  output: string;
}

export type Delivery =
  | { outcome: 'accepted'; run: OpenClawRun; acknowledgement: Record<string, unknown> }
  | { outcome: 'not_accepted'; run: OpenClawRun; reason: string }
  | { outcome: 'unreachable'; reason: string };

export interface OpenClawChannel {
  deliver(request: DispatchRequest): Promise<Delivery>;
}

export class DisabledChannel implements OpenClawChannel {
  async deliver(): Promise<Delivery> {
    return { outcome: 'unreachable', reason: 'OpenClaw dispatch is disabled for this bridge (FACTORY_OPENCLAW_DISPATCH=off).' };
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Runs `docker <args>` in the repository root; input, if any, goes to stdin.
export type CommandRunner = (args: readonly string[], input?: string) => Promise<CommandResult>;

export function dockerRunner(repoRoot: string): CommandRunner {
  return (args, input) =>
    new Promise((resolve) => {
      const child = spawn('docker', args, { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: COMMAND_TIMEOUT_MS });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const collect = (append: (text: string) => void) => (text: string) => {
        if (stdout.length + stderr.length < MAX_OUTPUT_CHARS) {
          append(text);
        }
      };
      child.stdout.on('data', collect((text) => (stdout += text)));
      child.stderr.on('data', collect((text) => (stderr += text)));
      // EPIPE when docker exits before reading stdin; the exit code reports the failure.
      child.stdin.on('error', () => undefined);
      child.once('error', (error) => {
        resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
      });
      child.once('close', (code) => {
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(input ?? '');
    });
}

class Unreachable extends Error {}

// Diagnostic text from docker or OpenClaw, without absolute paths: it ends up in
// dispatch.json and in the MCP result.
function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').replace(/\/[^\s'"`:,)]+/g, '<path>').slice(0, 300);
}

function parseJson(result: CommandResult, step: string): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Unreachable(`${step} exited with code ${result.code}: ${firstLine(result.stderr) || 'no JSON output'}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The receiver prints one JSON object per line; find the one for this request.
function findAcknowledgement(output: string, request: DispatchRequest): Record<string, unknown> | undefined {
  for (const line of output.split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      isRecord(value) &&
      (value.sf_dispatch === 'accepted' || value.sf_dispatch === 'already_accepted') &&
      value.request_id === request.request_id &&
      value.app_id === request.app_id &&
      value.job_id === request.job_id &&
      value.instruction_sha256 === request.instruction_sha256
    ) {
      return value;
    }
  }
  return undefined;
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCEPTED_DIR = '/home/node/.openclaw/sf-dispatch/accepted';

// The receiver's own record of an accepted request inside the OpenClaw volume.
export interface ReceiverRecord {
  request_id: string;
  app_id: string;
  job_id: string;
  instruction_sha256: string;
  accepted_at: string;
}

// SF-006: reads accepted/<request_id>.json through one fixed, read-only
// `docker compose exec ... cat` (no shell). Returns undefined when the
// receiver has no such record; throws when OpenClaw cannot be asked or the
// record is not a receiver record.
export async function readReceiverRecord(run: CommandRunner, requestId: string): Promise<ReceiverRecord | undefined> {
  if (!REQUEST_ID.test(requestId)) {
    throw new Error('request_id is not a UUID.');
  }
  const result = await run([
    ...['compose', '-f', COMPOSE_FILE, '-p', COMPOSE_PROJECT, 'exec', '-T', COMPOSE_SERVICE],
    ...['cat', `${ACCEPTED_DIR}/${requestId}.json`],
  ]);
  if (result.code !== 0) {
    if (/No such file or directory/.test(result.stderr)) {
      return undefined;
    }
    throw new Error(`reading the OpenClaw receiver record failed (exit ${result.code}): ${firstLine(result.stderr)}`);
  }
  let record: unknown;
  try {
    record = JSON.parse(result.stdout);
  } catch {
    throw new Error('the OpenClaw receiver record is not JSON.');
  }
  const fields = ['request_id', 'app_id', 'job_id', 'instruction_sha256', 'accepted_at'] as const;
  if (!isRecord(record) || !fields.every((field) => typeof record[field] === 'string')) {
    throw new Error('the OpenClaw receiver record is malformed.');
  }
  return Object.fromEntries(fields.map((field) => [field, record[field]])) as unknown as ReceiverRecord;
}

export class DockerComposeChannel implements OpenClawChannel {
  readonly #exec: string[];
  readonly #run: CommandRunner;
  #queue: Promise<unknown> = Promise.resolve();

  // run executes docker in the repository root, so the compose file path stays relative.
  constructor(run: CommandRunner) {
    this.#exec = ['compose', '-f', COMPOSE_FILE, '-p', COMPOSE_PROJECT, 'exec', '-T', COMPOSE_SERVICE];
    this.#run = run;
  }

  // One delivery at a time: an accept run processes the whole inbox.
  deliver(request: DispatchRequest): Promise<Delivery> {
    const delivery = this.#queue.catch(() => undefined).then(() => this.#deliver(request));
    this.#queue = delivery;
    return delivery;
  }

  async #deliver(request: DispatchRequest): Promise<Delivery> {
    try {
      const enqueued = await this.#run([...this.#exec, 'node', RECEIVER_SCRIPT, 'enqueue'], JSON.stringify(request));
      if (enqueued.code !== 0) {
        throw new Unreachable(`receiver enqueue exited with code ${enqueued.code}: ${firstLine(enqueued.stderr)}`);
      }
      const automationId = await this.#receiverAutomation();
      const result = await this.#run([
        ...this.#exec,
        ...['node', 'openclaw.mjs', 'cron', 'run', automationId, '--wait', '--wait-timeout', RUN_WAIT, '--json'],
      ]);
      return this.#interpret(request, automationId, parseJson(result, 'openclaw cron run'));
    } catch (error) {
      if (error instanceof Unreachable) {
        return { outcome: 'unreachable', reason: error.message };
      }
      throw error;
    }
  }

  async #receiverAutomation(): Promise<string> {
    const command = [...this.#exec, 'node', 'openclaw.mjs', 'cron', 'list', '--all', '--json'];
    const listed = parseJson(await this.#run(command), 'openclaw cron list');
    const jobs = isRecord(listed) && Array.isArray(listed.jobs) ? listed.jobs.filter(isRecord) : [];
    const matches = jobs.filter((job) => job.name === RECEIVER_AUTOMATION);
    const [job] = matches;
    const payload = job?.payload;
    if (
      matches.length !== 1 ||
      job === undefined ||
      typeof job.id !== 'string' ||
      job.enabled !== false ||
      !isRecord(payload) ||
      payload.kind !== 'command' ||
      JSON.stringify(payload.argv) !== JSON.stringify(RECEIVER_ARGV)
    ) {
      throw new Unreachable(
        `OpenClaw automation "${RECEIVER_AUTOMATION}" is missing or differs from the provisioned definition ` +
          '(run scripts/openclaw/sf005-dispatch.sh provision).',
      );
    }
    return job.id;
  }

  #interpret(request: DispatchRequest, automationId: string, answer: unknown): Delivery {
    const record = isRecord(answer) && isRecord(answer.run) ? answer.run : undefined;
    if (!isRecord(answer) || answer.ok !== true || typeof answer.runId !== 'string' || record === undefined) {
      throw new Unreachable(`openclaw cron run returned no run record: ${firstLine(JSON.stringify(answer))}`);
    }
    if (record.runId !== answer.runId || record.jobId !== automationId) {
      throw new Unreachable(`openclaw cron run returned a record for another run (${String(record.runId)}).`);
    }
    const run: OpenClawRun = {
      automation_id: automationId,
      run_id: answer.runId,
      status: String(record.status),
      completion_status: String(record.completionStatus),
      ...(typeof record.runAtMs === 'number' ? { run_at_ms: record.runAtMs } : {}),
      ...(typeof record.durationMs === 'number' ? { duration_ms: record.durationMs } : {}),
      ...(typeof record.error === 'string' ? { error: record.error } : {}),
      output: typeof record.summary === 'string' ? record.summary : '',
    };
    const acknowledgement = findAcknowledgement(run.output, request);
    if (run.status === 'ok' && run.completion_status === 'succeeded' && acknowledgement !== undefined) {
      return { outcome: 'accepted', run, acknowledgement };
    }
    return {
      outcome: 'not_accepted',
      run,
      reason: run.error === undefined ? `OpenClaw run ${run.run_id} finished ${run.status} without acknowledging request ${request.request_id}.` : firstLine(run.error),
    };
  }
}
