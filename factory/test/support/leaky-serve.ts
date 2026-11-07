// A test file that leaves sf serves running (SF-114), for test/children.test.ts; not a *.test.ts,
// so the suite does not run it by itself. Its one test starts an untracked, detached serve as
// sf smoke does and a serve through the harness, prints their pids and the harness's temp
// directory, then with LEAK=pass ends without stopping them, with LEAK=hang never ends.
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { CLI, newEnv, processEnv, serve, temp } from './harness.js';

test('leaves its serves running', async () => {
  const stray = spawn(process.execPath, [CLI, 'serve'], { env: processEnv(await newEnv('leak-detached')), detached: true, stdio: 'ignore' });
  process.stdout.write(`stray-pid ${stray.pid}\n`);
  const served = await serve(await newEnv('leak'));
  process.stdout.write(`serve-pid ${served.child.pid}\ntemp ${temp}\n`);
  if (process.env.LEAK === 'hang') {
    await new Promise(() => {});
  }
});
