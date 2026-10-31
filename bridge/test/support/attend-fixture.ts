// Test entry point: attend() for one approved job, wired to a fixture (fake
// claude on this terminal, file-based receiver, the fixture's session gate).
// The fixture is named by the first argument, a JSON file written by the test.
//   node dist/test/support/attend-fixture.js <fixture.json> <app-id> <job-id>
import { readFileSync } from 'node:fs';
import { attend } from '../../src/operator/attend.js';
import { OperatorStore } from '../../src/operator/store.js';
import { fixtureService, type Fixture } from './operator-fixture.js';

async function main([fixturePath, appId, jobId]: string[]): Promise<number> {
  const fx = JSON.parse(readFileSync(fixturePath!, 'utf8')) as Fixture;
  return attend(
    {
      store: await OperatorStore.open(fx.stateHome, fx.mediator),
      service: fixtureService(fx, 'inherit'),
      input: process.stdin,
      output: process.stdout,
      isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
      now: () => new Date(),
      closePrompt: 'Press Enter to close this window.',
    },
    appId!,
    jobId!,
  );
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`attend-fixture: ${String(error)}`);
    process.exitCode = 1;
  },
);
