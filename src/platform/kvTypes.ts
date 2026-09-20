/** Minimal async key/value store, implemented by `kv.ts` (AsyncStorage) and `kv.web.ts` (localStorage). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type StorageErrorCode = 'quota' | 'invalid-id' | 'corrupt' | 'io';

/**
 * A storage failure.
 *
 * `message` IS SHOWN TO THE DRIVER, VERBATIM. The drive display puts it on screen when a
 * finished run fails to save (`src/ui/hud/useDriveRun.ts`), which is the worst possible moment
 * to read a quoted key or a class name: someone has just finished the run of their life and is
 * being told, in effect, that a string could not be written. So every message thrown from this
 * layer is written for that person — what went wrong, in their words, and what they can do — and
 * anything an engineer would want instead goes in `detail`.
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  /** The technical description: keys, ids, paths. For logs and bug reports, never for a screen. */
  readonly detail?: string;
  override readonly cause?: unknown;

  constructor(code: StorageErrorCode, message: string, cause?: unknown, detail?: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.cause = cause;
    this.detail = detail;
  }
}

/** How much a write would have needed, in whole KB, for a message that names a size. */
export function sizeKb(value: string): number {
  return Math.max(1, Math.round(value.length / 1024));
}

export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: number; message?: string };
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message ?? '');
}
