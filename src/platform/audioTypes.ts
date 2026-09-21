/**
 * What the feel layer needs from a platform to make a noise, and to make a phone buzz.
 *
 * Shared by `audio.ts` / `audio.web.ts` and `haptics.ts` / `haptics.web.ts` the same way
 * `kvTypes.ts` is shared by the two key/value stores: the interface lives in a file with no
 * imports, so neither platform build can drift from the other.
 */

/** A clip id. Kept as a plain string here so this file stays free of UI imports. */
export type ClipId = string;

/** The two continuous layers are addressed through `setBed`, never through `play`. */
export interface SoundPort {
  /** Start `id` from the top. False when nothing was audible (locked, unloaded, no device). */
  play(id: ClipId): boolean;
  /** Stop a sounding voice so a higher-priority cue can have it. */
  stop(id: ClipId): void;
  /** Set the two bed-layer gains, 0..1. `(0, 0)` closes the bed and must stop the loops. */
  setBed(low: number, high: number): void;
}

export interface HapticPort {
  impact(shape: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'): void;
  notify(shape: 'success' | 'warning' | 'error'): void;
}

/**
 * - `ready`       clips are loaded and `play` will make a sound
 * - `locked`      the platform has everything it needs but is waiting for a user gesture (web)
 * - `unavailable` there is no audio output here at all (headless browser, blocked API)
 */
export type SoundPortState = 'ready' | 'locked' | 'unavailable';

export interface PreparedSoundPort extends SoundPort {
  readonly state: SoundPortState;
  /** How many clips are loaded and ready — shown by the `/sound` lab. */
  readonly loaded: number;
  readonly total: number;
  /** Web needs a user gesture before anything is audible. Native resolves immediately. */
  unlock(): Promise<SoundPortState>;
  release(): void;
  /** One line describing what the platform is actually doing, for the lab. */
  describe(): string;
}

export interface SoundPortSources {
  /** id → clip length in seconds, so the port can schedule its own rewinds. */
  durations: Record<ClipId, number>;
  /** id → Metro asset module id (a `require` of a `.wav`). */
  modules: Record<ClipId, number>;
  bedLow: ClipId;
  bedHigh: ClipId;
}
