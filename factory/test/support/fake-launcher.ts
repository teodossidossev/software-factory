// A fake xdg-open for the tests of --open and sf up: a directory to put on PATH whose xdg-open
// records each call's arguments and exits with the given code.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temp } from './harness.js';

export interface FakeLauncher {
  bin: string;
  calls(): Promise<string[][]>;
}

// A directory with a fake xdg-open that records each call's arguments and exits with the given code.
export async function fakeLauncher(name: string, exit: number, body = ''): Promise<FakeLauncher> {
  const bin = join(temp, name);
  const log = join(bin, 'xdg-open.log');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'xdg-open'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> '${log}'\nprintf '\\036' >> '${log}'\n${body}\nexit ${exit}\n`);
  await chmod(join(bin, 'xdg-open'), 0o755);
  return {
    bin,
    async calls() {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text.split('\x1e').filter((entry) => entry !== '').map((entry) => entry.split('\x1f').slice(0, -1));
    },
  };
}

