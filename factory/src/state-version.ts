// The state format version (SF-101): <state dir>/state-version holds a whole number, the format
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
export const STATE_VERSION = 1;

// One step of the format: the state written at version from becomes the state of version from + 1.
export interface Migration {
  from: number;
  run(stateDir: string): Promise<void>;
}

// The migrations, one per step; none exist yet.
export const MIGRATIONS: readonly Migration[] = [];

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
