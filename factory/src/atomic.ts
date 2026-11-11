// Atomic file replacement: a complete temp file (fsynced) renamed over the target.
import { randomUUID } from 'node:crypto';
import { type FileHandle, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export function writeFileAtomic(target: string, data: Buffer, mode = 0o600): Promise<void> {
  return writeFileAtomicWith(target, (handle) => handle.writeFile(data), mode);
}

// The same, with the content written by write into the temp file's handle (a stream, a child
// process's stdout, ...); a write that throws leaves the target alone.
export async function writeFileAtomicWith(target: string, write: (handle: FileHandle) => Promise<void>, mode = 0o600): Promise<void> {
  const dir = dirname(target);
  const tempPath = join(dir, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tempPath, 'wx', mode);
    try {
      await write(handle);
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
  } catch { // fsync of a directory is not supported on every filesystem
  }
}
