// Storage for the single fixed probe artifact. Callers never choose a path:
// the artifact always lives at <dataDir>/probe.txt.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const PROBE_ARTIFACT = 'probe.txt';

export interface ProbeSnapshot {
  message: string;
  bytes: number;
  sha256: string;
}

function snapshot(message: string): ProbeSnapshot {
  const buffer = Buffer.from(message, 'utf8');
  return {
    message,
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

export class ProbeStore {
  readonly #dataDir: string;
  readonly #path: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
    this.#path = join(dataDir, PROBE_ARTIFACT);
  }

  // Writes to a temp file, fsyncs and renames over the artifact, so readers
  // only ever see a complete previous or complete new artifact.
  async write(message: string): Promise<ProbeSnapshot> {
    await mkdir(this.#dataDir, { recursive: true });
    const tempPath = join(this.#dataDir, `.${PROBE_ARTIFACT}.${randomUUID()}.tmp`);
    try {
      const handle = await open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(message, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.#path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    return snapshot(message);
  }

  async read(): Promise<ProbeSnapshot | undefined> {
    try {
      return snapshot(await readFile(this.#path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }
}
