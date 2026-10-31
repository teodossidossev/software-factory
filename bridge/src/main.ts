// CLI entry point: reads FACTORY_PORT / FACTORY_DATA_DIR / FACTORY_REPO_ROOT / FACTORY_OPENCLAW_DISPATCH,
// starts the bridge and shuts it down cleanly on SIGINT/SIGTERM.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DisabledChannel, DockerComposeChannel, dockerRunner, type OpenClawChannel } from './openclaw-channel.js';
import { resolveRepoRoot } from './repo-files.js';
import { BRIDGE_NAME, PortInUseError, startBridge } from './server.js';

const DEFAULT_PORT = 8787;
// Compiled to bridge/dist/src/main.js; the default data dir is <repo>/factory-data.
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../factory-data', import.meta.url));
// The default repository root is the checkout that contains this bridge, independent of the shell cwd.
const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`FACTORY_PORT must be an integer between 0 and 65535, got "${raw}".`);
  }
  return port;
}

// "docker" (default) uses the SF-004 Compose project in this repository; "off" fails every dispatch.
function openClawChannel(raw: string | undefined, repoRoot: string): OpenClawChannel {
  if (raw === undefined || raw === '' || raw === 'docker') {
    return new DockerComposeChannel(dockerRunner(repoRoot));
  }
  if (raw === 'off') {
    return new DisabledChannel();
  }
  throw new Error(`FACTORY_OPENCLAW_DISPATCH must be "docker" or "off", got "${raw}".`);
}

async function main(): Promise<void> {
  const port = parsePort(process.env.FACTORY_PORT);
  const dataDir = resolve(process.env.FACTORY_DATA_DIR || DEFAULT_DATA_DIR);
  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot(process.env.FACTORY_REPO_ROOT || DEFAULT_REPO_ROOT);
  } catch (error) {
    console.error(`${BRIDGE_NAME}: ${(error as Error).message} Set FACTORY_REPO_ROOT to an existing directory.`);
    process.exit(1);
  }
  const openclaw = openClawChannel(process.env.FACTORY_OPENCLAW_DISPATCH, repoRoot);
  const bridge = await startBridge({ port, dataDir, repoRoot, openclaw });
  console.log(
    `${BRIDGE_NAME} listening on ${bridge.url.href} (data dir: ${dataDir}, repo root: ${repoRoot}, ` +
      `openclaw dispatch: ${openclaw instanceof DisabledChannel ? 'off' : 'docker'})`,
  );

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`${BRIDGE_NAME} received ${signal}, shutting down`);
    bridge.close().then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  if (error instanceof PortInUseError) {
    console.error(`${BRIDGE_NAME}: ${error.message} Set FACTORY_PORT to a free port.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
