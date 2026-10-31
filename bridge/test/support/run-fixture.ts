// Test entry point standing in for the manual SF-006 CLI in its own process:
// prepare (if needed) and run one job with the fixture's service, answering the
// end-of-session question with the second argument. Prints the final state or
// the error code.
//   node dist/test/support/run-fixture.js <fixture.json> <yes|no> <app-id> <job-id>
import { readFileSync } from 'node:fs';
import { fixtureService, type Fixture } from './operator-fixture.js';

async function main([fixturePath, answer, appId, jobId]: string[]): Promise<void> {
  const fx = JSON.parse(readFileSync(fixturePath!, 'utf8')) as Fixture;
  const service = fixtureService(fx, 'ignore');
  try {
    const result = await service.run(appId!, jobId!, async () => answer === 'yes');
    console.log(`state ${result.state}`);
  } catch (error) {
    console.log(`error ${(error as { code?: string }).code ?? String(error)}`);
  }
}

void main(process.argv.slice(2));
