// The state format version: <state dir>/state-version holds a whole number, the format
// of the state files the factory last wrote. sf serve and every runner (sf run) check it at start:
// a missing file gets the current version; an equal one goes on; a lower one runs the migrations
// from it to the current one in order, then the new number is written; a higher one refuses with
// state_too_new, since an older factory cannot know what a newer one wrote.
// Any later change of a state file's format raises STATE_VERSION and adds its migration to
// MIGRATIONS (factory/README.md, "Changing the state format").
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';

export const STATE_VERSION_FILE = 'state-version';
// The format this release reads and writes.
export const STATE_VERSION = 11;

// One step of the format: the state written at version from becomes the state of version from + 1.
export interface Migration {
  from: number;
  run(stateDir: string): Promise<void>;
}

// The migrations, one per step.
export const MIGRATIONS: readonly Migration[] = [
  // 1 → 2: job.json may hold claude_review, which an older factory's strict schema refuses.
  // A job without it counts as true (claudeReviews), so nothing is rewritten.
  { from: 1, run: async () => undefined },
  // 2 → 3: queue.json may hold last_start, which an older factory's strict schema refuses.
  // A queue without it has had no start recorded yet, so nothing is rewritten.
  { from: 2, run: async () => undefined },
  // 3 → 4: a digest record's model texts are {text, en} objects and it may hold in_progress, which
  // an older factory's page reads wrongly. The page reads a record without them, so nothing is
  // rewritten.
  { from: 3, run: async () => undefined },
  // 4 → 5: a queue entry may hold retry_at and retries (a start that could not fetch, tried again),
  // which an older factory's strict schema refuses. An entry without them has never failed so,
  // so nothing is rewritten.
  { from: 4, run: async () => undefined },
  // 5 → 6: job.json may hold stalled_fixes, least_open, gate_stalled, gate_budget_from and important,
  // which an older factory's strict schema refuses. A job without them has no round counted, its
  // budget counts from 0 and it is not important, so nothing is rewritten.
  { from: 5, run: async () => undefined },
  // 6 → 7: a pin in pins.json may hold url (a pin of another page), which an older factory's strict
  // schema refuses. A pin without it is a dashboard pin, so nothing is rewritten.
  { from: 6, run: async () => undefined },
  // 7 → 8: job.json may hold fix_session, session_cost_usd and unpublished_cost_usd, which an older
  // factory's strict schema refuses. A job without them resumes its session for every fix round and
  // has no cost carried, so nothing is rewritten.
  { from: 7, run: async () => undefined },
  // 8 → 9: job.json may hold findings_checklist, which an older factory's strict schema refuses. A
  // job without it was given no findings checklist, so nothing is rewritten.
  { from: 8, run: async () => undefined },
  // 9 → 10: job.json may hold quick_fix (a quick fix under way), which an older factory's strict
  // schema refuses. A job without it runs no quick fix, so nothing is rewritten.
  { from: 9, run: async () => undefined },
  // 10 → 11: job.json may hold clean, an iteration's meta.json delta and a stored review or gate item
  // outside_delta, which an older factory's strict schemas refuse or misread. A job without clean has
  // no clean round recorded, an iteration without delta was reviewed whole, and an item without
  // outside_delta gave no reason, so nothing is rewritten.
  { from: 10, run: async () => undefined },
];

export interface StateVersionOptions {
  current?: number;
  migrations?: readonly Migration[];
}

// What the check found and did: the version in the file (undefined: none), and the migrations run.
export interface StateVersionCheck {
  found: number | undefined;
  version: number;
  migrated: number[];
}

async function readVersion(path: string): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const value = text.trim();
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new FactoryError('state_version_invalid', `state_version_invalid: state-version in the state directory must hold a whole number, got "${value.slice(0, 40)}".`);
  }
  return Number(value);
}

const writeVersion = async (path: string, version: number): Promise<void> => writeFileAtomic(path, Buffer.from(`${version}\n`, 'utf8'));

// The check at the start of sf serve and of every runner (see the top of this file).
export async function checkStateVersion(stateDir: string, { current = STATE_VERSION, migrations = MIGRATIONS }: StateVersionOptions = {}): Promise<StateVersionCheck> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, STATE_VERSION_FILE);
  const found = await readVersion(path);
  if (found === undefined) {
    await writeVersion(path, current);
    return { found, version: current, migrated: [] };
  }
  if (found > current) {
    throw new FactoryError(
      'state_too_new',
      `state_too_new: the state was written by a newer factory (state format ${found}, this factory reads ${current}); update the factory (sf update).`,
    );
  }
  const migrated: number[] = [];
  for (let version = found; version < current; version += 1) {
    const step = migrations.find((migration) => migration.from === version);
    if (step === undefined) {
      throw new FactoryError('state_migration_missing', `state_migration_missing: no migration of the state format from ${version} to ${version + 1}.`);
    }
    await step.run(stateDir);
    migrated.push(version);
    // Each step is recorded, so a failure later starts again from the step that failed.
    await writeVersion(path, version + 1);
  }
  return { found, version: current, migrated };
}
