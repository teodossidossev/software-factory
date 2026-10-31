// SF-007 demo (scripts/sf007-demo.sh): the real operator console in this
// terminal, against a throwaway mediator, app repository, fake `claude`, stub
// receiver and its own session gate, all created under the system temp
// directory and removed again when the console ends (unless --keep).
// --info-file <path> writes {"dir": <throwaway directory>} for a test harness.
//
//   node demo.js [--keep] [--info-file <path>]
import { rm, writeFile } from 'node:fs/promises';
import { runConsole } from './console.js';
import { createDemo, demoService } from './demo-fixture.js';
import { OperatorStore } from './store.js';

async function main(argv: string[]): Promise<number> {
  const infoIndex = argv.indexOf('--info-file');
  const infoFile = infoIndex >= 0 ? argv[infoIndex + 1] : undefined;
  if (argv.some((arg, index) => arg !== '--keep' && index !== infoIndex && index !== infoIndex + 1) || (infoIndex >= 0 && infoFile === undefined)) {
    console.error('usage: sf007-demo [--keep] [--info-file <path>]');
    return 2;
  }
  const demo = await createDemo();
  if (infoFile !== undefined) await writeFile(infoFile, JSON.stringify({ dir: demo.dir }), { flag: 'wx', mode: 0o600 });
  try {
    return await runConsole({
      mediatorRoot: demo.mediator,
      store: await OperatorStore.open(demo.stateHome, demo.mediator),
      service: demoService(demo),
      input: process.stdin,
      output: process.stdout,
      isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
      now: () => new Date(),
      banner: '*** DEMO: fake Claude Code, throwaway repositories; nothing real is touched ***',
    });
  } finally {
    if (!argv.includes('--keep')) await rm(demo.dir, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`sf007-demo: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
