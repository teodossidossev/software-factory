// CLI entry point of the SF-010 discovery probe. It requires SF010_PROBE_PORT, takes
// SF010_PROBE_LIFETIME_SECONDS (default and maximum 600) and exits when the lifetime ends.
import { MAX_LIFETIME_MS, PROBE_NAME, startEventProbe } from './server.js';

const SHUTDOWN_GRACE_MS = 5_000;

function parsePort(raw: string | undefined): number {
  const port = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SF010_PROBE_PORT must be an explicit port between 1 and 65535.');
  }
  return port;
}

function parseLifetimeMs(raw: string | undefined): number {
  if (raw === undefined) {
    return MAX_LIFETIME_MS;
  }
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds * 1000 > MAX_LIFETIME_MS) {
    throw new Error(`SF010_PROBE_LIFETIME_SECONDS must be a whole number between 1 and ${MAX_LIFETIME_MS / 1000}.`);
  }
  return seconds * 1000;
}

// Backstop: shutdown is already bounded, but the lifetime must hold even if it is not.
function exitAfter(delayMs: number): void {
  setTimeout(() => {
    console.error(`${PROBE_NAME}: shutdown overran its limit`);
    process.exit(1);
  }, delayMs);
}

async function main(): Promise<void> {
  const port = parsePort(process.env.SF010_PROBE_PORT);
  const lifetimeMs = parseLifetimeMs(process.env.SF010_PROBE_LIFETIME_SECONDS);
  const probe = await startEventProbe({ port, lifetimeMs, log: (line) => console.log(line) });
  console.log(`${PROBE_NAME} listening on ${probe.url.href} (lifetime ${lifetimeMs / 1000}s)`);

  exitAfter(lifetimeMs + SHUTDOWN_GRACE_MS);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      exitAfter(SHUTDOWN_GRACE_MS);
      void probe.close(signal);
    });
  }

  console.log(`${PROBE_NAME} stopped: ${await probe.closed}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`${PROBE_NAME}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
