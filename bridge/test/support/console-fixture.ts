// Test entry point: the operator console (runConsole) wired to a fixture, as
// main.js console wires it to the real mediator.
//   node dist/test/support/console-fixture.js <fixture.json>
import { readFileSync } from 'node:fs';
import { runConsole } from '../../src/operator/console.js';
import { OperatorStore } from '../../src/operator/store.js';
import { fixtureService, type Fixture } from './operator-fixture.js';

async function main([fixturePath]: string[]): Promise<number> {
  const fx = JSON.parse(readFileSync(fixturePath!, 'utf8')) as Fixture;
  return runConsole({
    mediatorRoot: fx.mediator,
    store: await OperatorStore.open(fx.stateHome, fx.mediator),
    service: fixtureService(fx, 'inherit'),
    input: process.stdin,
    output: process.stdout,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    now: () => new Date(),
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`console-fixture: ${String(error)}`);
    process.exitCode = 1;
  },
);
