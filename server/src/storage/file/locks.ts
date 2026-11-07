import { open, rm, stat } from "node:fs/promises";

/** In-process FIFO mutex. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<R>(fn: () => Promise<R>): Promise<R> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const STALE_LOCK_MS = 30_000;
const RETRY_MS = 25;
const MAX_WAIT_MS = 15_000;
const RELEASE_WAIT_MS = 5_000;

/**
 * Windows reports these while another process (a virus scanner, or a sync
 * tool such as Dropbox or OneDrive) briefly holds a file open, or while a
 * deleted file is still pending deletion.
 */
export function isBusyError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

/** Runs `fn`, retrying with a growing delay while the file is busy, up to `maxWaitMs`. */
export async function retryWhileBusy<R>(fn: () => Promise<R>, maxWaitMs: number): Promise<R> {
  const deadline = Date.now() + maxWaitMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBusyError(err) || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, Math.min(20 * attempt, 250)));
    }
  }
}

/**
 * Cross-process lock based on exclusive creation of a lock file.
 * A lock older than STALE_LOCK_MS is treated as left behind by a crashed process.
 */
export async function withLockFile<R>(lockPath: string, fn: () => Promise<R>): Promise<R> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      const busy = isBusyError(err);
      if (!busy && (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!busy) {
        const info = await stat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await retryWhileBusy(() => rm(lockPath, { force: true }), RELEASE_WAIT_MS);
          continue;
        }
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for lock ${lockPath}`, { cause: err });
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await releaseLockFile(lockPath);
  }
}

/**
 * Removes the lock file. The transaction has already committed (or failed
 * on its own) when this runs, so a file that stays busy is logged rather
 * than turned into an error; the lock then expires as stale.
 */
async function releaseLockFile(lockPath: string): Promise<void> {
  try {
    await retryWhileBusy(() => rm(lockPath, { force: true }), RELEASE_WAIT_MS);
  } catch (err) {
    console.warn(`Could not remove lock file ${lockPath}; it expires as stale`, err);
  }
}
