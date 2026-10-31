// Software Factory dispatch receiver, run inside the OpenClaw gateway container.
// It is installed into the state volume by scripts/openclaw/sf005-dispatch.sh and
// has exactly two modes, both without network, shell or model:
//
//   enqueue  run by the bridge through `docker compose exec`: reads one request
//            {request_id, app_id, job_id, instruction_sha256} as JSON on stdin
//            and stores it in inbox/<request_id>.json
//   accept   the argv of the disabled OpenClaw command automation
//            "sf-dispatch-receiver": records every inbox request once in
//            accepted/<request_id>.json and prints one JSON line per request
//            ("accepted", or "already_accepted" with the first acceptance time
//            when the same payload was accepted before), which OpenClaw keeps in
//            the run history. A request_id already accepted with a different
//            payload is refused ("conflict"); the first acceptance stays as is.
//
// Exit 0 on success, 2 on any refused input. Instruction content never reaches it.
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = process.env.SF_DISPATCH_DIR || '/home/node/.openclaw/sf-dispatch';
const MAX_INPUT_BYTES = 4096;
const FIELDS = {
  request_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  app_id: /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
  job_id: /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
  instruction_sha256: /^[0-9a-f]{64}$/,
};

class Refused extends Error {}

function print(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}

function parseRequest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Refused('invalid request');
  }
  const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  const names = Object.keys(FIELDS);
  if (keys.length !== names.length || !names.every((name) => typeof value[name] === 'string' && FIELDS[name].test(value[name]))) {
    throw new Refused('invalid request');
  }
  return Object.fromEntries(names.map((name) => [name, value[name]]));
}

// undefined when the request was never accepted; null when the record cannot be read as JSON.
async function readAccepted(requestId) {
  let text;
  try {
    text = await readFile(join(DIR, 'accepted', `${requestId}.json`), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function samePayload(record, request) {
  return (
    record !== null &&
    typeof record === 'object' &&
    Object.keys(FIELDS).every((name) => record[name] === request[name]) &&
    typeof record.accepted_at === 'string'
  );
}

// Keeps every refused entry: an existing name in rejected/ gets a unique suffix instead of being replaced.
async function moveToRejected(path, entry) {
  let target = join(DIR, 'rejected', entry);
  try {
    await link(path, target);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    target = join(DIR, 'rejected', `${entry}.${randomUUID()}`);
    await link(path, target);
  }
  await rm(path);
}

// Complete temp file first; 'create' links it (fails if the name exists), 'replace' renames it.
async function writeJson(dir, name, object, mode) {
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(object)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode === 'create') {
      await link(temp, join(dir, name));
    } else {
      await rename(temp, join(dir, name));
    }
  } finally {
    await rm(temp, { force: true });
  }
}

async function readStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) {
      throw new Refused('request too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function enqueue() {
  const request = parseRequest(await readStdin());
  // Also for an already accepted request: the next accept run then reports it again.
  await writeJson(join(DIR, 'inbox'), `${request.request_id}.json`, request, 'replace');
  print({ enqueued: true, request_id: request.request_id });
  return 0;
}

async function accept() {
  const entries = (await readdir(join(DIR, 'inbox'))).filter((name) => !name.startsWith('.')).sort();
  if (entries.length === 0) {
    print({ sf_dispatch: 'idle' });
    return 0;
  }
  let status = 0;
  for (const entry of entries) {
    const path = join(DIR, 'inbox', entry);
    let request;
    try {
      request = parseRequest(await readFile(path, 'utf8'));
      if (entry !== `${request.request_id}.json`) {
        throw new Refused('invalid request');
      }
    } catch (error) {
      if (!(error instanceof Refused)) {
        throw error;
      }
      await moveToRejected(path, entry);
      print({ sf_dispatch: 'rejected', entry, reason: error.message });
      status = 2;
      continue;
    }
    const existing = await readAccepted(request.request_id);
    if (existing !== undefined && !samePayload(existing, request)) {
      await moveToRejected(path, entry);
      print({
        sf_dispatch: 'conflict',
        entry,
        request_id: request.request_id,
        reason: 'request_id was already accepted with a different payload',
      });
      status = 2;
      continue;
    }
    if (existing !== undefined) {
      print({ sf_dispatch: 'already_accepted', ...request, accepted_at: existing.accepted_at });
    } else {
      const record = { ...request, accepted_at: new Date().toISOString() };
      await writeJson(join(DIR, 'accepted'), `${request.request_id}.json`, record, 'create');
      print({ sf_dispatch: 'accepted', ...record });
    }
    await rm(path, { force: true });
  }
  return status;
}

async function main(mode) {
  for (const name of ['inbox', 'accepted', 'rejected']) {
    await mkdir(join(DIR, name), { recursive: true, mode: 0o700 });
  }
  if (mode === 'enqueue') {
    return enqueue();
  }
  if (mode === 'accept') {
    return accept();
  }
  throw new Refused('mode must be "enqueue" or "accept"');
}

main(process.argv[2]).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Refused ? error.message : `receiver failed: ${error.code ?? error.name}`);
    process.exitCode = error instanceof Refused ? 2 : 1;
  },
);
