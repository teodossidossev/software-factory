// Atomic file replacement: a complete temp file (fsynced) renamed over the target.
import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function writeFileAtomic(target: string, data: Buffer, mode = 0o600): Promise<void> {
  const dir = dirname(target);
  const tempPath = join(dir, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tempPath, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, target);
  } finally {
    await rm(tempPath, { force: true });
  }
  // Persist the rename itself; a failure here leaves a complete file in place.
  try {
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Some filesystems do not support fsync on directories.
  }
}
