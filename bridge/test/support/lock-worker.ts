// A separate process contending for an SF-006 execution lock (acquireLock), for
// the multi-process lock tests:
//   node lock-worker.js loop <dir> <iterations> <log>   acquire, log enter/exit around a short hold, release; repeat
//   node lock-worker.js once <dir> <holdMs> <log>       one attempt; logs "won" or "locked:<message>"
import { appendFileSync } from 'node:fs';
import { acquireLock } from '../../src/execution/process-identity.js';

const [mode, dir, count, log] = process.argv.slice(2) as [string, string, string, string];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (mode === 'loop') {
    for (let done = 0; done < Number(count); ) {
      let release;
      try {
        release = await acquireLock(dir, 'test lock');
      } catch (error) {
        if ((error as { code?: string }).code !== 'locked') throw error;
        await sleep(Math.random() * 5);
        continue;
      }
      appendFileSync(log, `enter ${process.pid}\n`);
      await sleep(Math.random() * 3);
      appendFileSync(log, `exit ${process.pid}\n`);
      await release();
      done += 1;
    }
    return;
  }
  try {
    const release = await acquireLock(dir, 'test lock');
    appendFileSync(log, `won ${process.pid}\n`);
    await sleep(Number(count));
    await release();
  } catch (error) {
    appendFileSync(log, `locked ${process.pid} ${(error as Error).message}\n`);
  }
}

main().catch((error: unknown) => {
  appendFileSync(log, `error ${process.pid} ${String(error)}\n`);
  process.exitCode = 1;
});
