// Test entry point standing in for `scripts/sf009-executor.sh run` in its own process, wired to a
// fixture (fake stream-json Claude, the fixture's gate and receiver). Prints "ready" once started,
// or "error <code>"; stops on SIGTERM. With a fault it kills itself (SIGKILL) at that point:
//   crash-before-commit    after an iteration's diff and report were written, before its snapshot.json
//   crash-after-use        after consumed/<authorization_id> was written, before the SF-007 approval
//   crash-after-approval   after the SF-007 approval was created, before it was consumed
//   crash-after-review-recorded   after a review was recorded as being sent, before it was sent
//   node dist/test/support/supervisor-fixture.js <fixture.json> [crash-before-commit | crash-after-use | crash-after-approval | crash-after-review-recorded]
import { readFileSync } from 'node:fs';
import { Supervisor } from '../../src/executor/supervisor.js';
import { FAST, managedService } from './executor-fixture.js';
import type { Fixture } from './operator-fixture.js';

const crash = async (): Promise<void> => void process.kill(process.pid, 'SIGKILL');

async function main([fixturePath, fault]: string[]): Promise<void> {
  const fx = JSON.parse(readFileSync(fixturePath!, 'utf8')) as Fixture;
  let supervisor: Supervisor;
  try {
    supervisor = await Supervisor.start({
      mediatorRoot: fx.mediator,
      stateHome: fx.stateHome,
      service: managedService(fx),
      ...FAST,
      ...(fault === 'crash-before-commit' ? { beforeSnapshotCommit: crash } : {}),
      ...(fault === 'crash-after-use' ? { afterAuthorizationUse: crash } : {}),
      ...(fault === 'crash-after-approval' ? { afterApprovalCreated: crash } : {}),
      ...(fault === 'crash-after-review-recorded' ? { afterRequestRecorded: async (kind: 'review' | 'acceptance') => (kind === 'review' ? crash() : undefined) } : {}),
    });
  } catch (error) {
    console.log(`error ${(error as { code?: string }).code ?? 'unknown'}`);
    process.exitCode = 3;
    return;
  }
  console.log('ready');
  process.on('SIGTERM', () => void supervisor.stop());
  await supervisor.run();
  await supervisor.close();
}

void main(process.argv.slice(2));
