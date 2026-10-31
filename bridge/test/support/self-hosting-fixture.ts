// Shared fixture of the SF-009 self-hosting tests: the throwaway mediator of the executor fixture,
// turned into a Git checkout with the operator's existing uncommitted work, used as the app's
// repository (APP_REPO = the mediator itself).
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutorState } from '../../src/executor/policy.js';
import { streamClaude } from './executor-fixture.js';
import { git, type Fixture } from './operator-fixture.js';

export const CLAUDE = { executable: '/usr/bin/true', version: 'fake 0.0.0' };
// The operator's own uncommitted work in the checkout, before any job.
export const EXISTING = { 'notes.md': '# Notes\nedited, not committed\n', 'wip.txt': 'work in progress\n', 'staged.txt': 'staged, not committed\n' };

export const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

// Turns the fixture's mediator into a Git checkout with one commit and existing uncommitted work,
// and points the app at it (APP_REPO = the mediator itself).
export async function selfHostedMediator(fx: Fixture): Promise<void> {
  await writeFile(join(fx.mediator, '.gitignore'), 'factory-data/\n');
  await writeFile(join(fx.mediator, 'README.md'), '# Software Factory\n');
  await writeFile(join(fx.mediator, 'notes.md'), '# Notes\n');
  git(fx.mediator, 'add', '.gitignore', 'README.md', 'notes.md');
  git(fx.mediator, 'commit', '-q', '-m', 'init');
  for (const [name, content] of Object.entries(EXISTING)) {
    await writeFile(join(fx.mediator, name), content);
  }
  git(fx.mediator, 'add', 'staged.txt');
  await writeFile(join(fx.mediator, 'factory-data', 'apps', fx.app, '.env'), `APP_REPO=${fx.mediator}\n`, { mode: 0o600 });
}

export async function enableSelfHosting(fx: Fixture): Promise<ExecutorState> {
  const state = await ExecutorState.open(fx.stateHome, fx.mediator);
  await state.enable(fx.app, { executable: streamClaude(fx), version: 'fake 0.0.0' }, [], new Date(), 'self_hosting_unconfined');
  return state;
}

export async function existingWorkIntact(fx: Fixture): Promise<void> {
  for (const [name, content] of Object.entries(EXISTING)) {
    assert.equal(await readFile(join(fx.mediator, name), 'utf8'), content, `${name} kept`);
  }
  assert.match(git(fx.mediator, 'status', '--porcelain'), /^A  staged\.txt$/m, 'the staged file stays staged');
}
