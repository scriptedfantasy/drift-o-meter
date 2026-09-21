/**
 * The feel layer's lifecycle, and the one-line call sites.
 *
 *   const feel = useDriftFeel();     // on any screen that wants the status; never rebuilds
 *   feelFrame(frame);                // in the 100 Hz path
 *   feelCue('stop');                 // from a control, or the results screen's grade reveal
 *
 * `feelFrame` and `feelCue` are plain module functions against a singleton, not methods on a
 * hook result, for two reasons. They have to be callable from inside `useDriveRun`'s `applyFrame`
 * — a `useCallback` that must not gain a dependency — and they have to be no-ops until the ports
 * exist, so a call site can be added without the screen having to care whether sound exists yet.
 *
 * ── THE PORT OUTLIVES THE SCREEN ──────────────────────────────────────────────────────────────
 * The sound port is a module singleton beside `driftFeel`, built once and released when the app
 * goes away — NOT per screen. It used to be per screen, and the cost was measured on the shipped
 * web export with instrumented Web Audio:
 *
 *   t = 6151.7 ms   `start dur=0.52`   — the STOP clip, from the driver's own tap
 *   t = 6367.3 ms   three `srcStop`s and `ctx.close()`
 *
 * 215 ms into a 520 ms clip. The chain was `useDriveRun.stop()` → `feelCue('stop')` →
 * `finishAndSave()` → `router.replace('/results/…')` → `/drive` unmounts → the hook's cleanup
 * calls `port.release()` → `ctx.close()` on web, or `player.remove()` eighteen times on native.
 * "A band of noise falling away, a sub sliding to nothing" became a click and a hard cut, on
 * every single run. The same teardown then made the results screen rebuild the whole bank —
 * 18 × `decodeAudioData` at t = 7066 ms, the grade clip at t = 7864 ms against a reveal that
 * slams at ~7920 — spending 800 ms of margin it never needed to spend.
 *
 * So the hook no longer owns the port. It subscribes to a snapshot, and unmounting only tells
 * the mixer to forget the run (`reset()` closes the bed and drops the phase latches, so a slide
 * cannot drone on into the results screen). Nothing is decoded twice, and nothing the driver
 * asked for is cut off by a navigation.
 *
 * ── AND IT IS READ THROUGH STATE, NOT THROUGH A REF ───────────────────────────────────────────
 * Every field this hook returns comes out of `useState`. That is not tidiness: this app builds
 * with the React Compiler (`app.json` → experiments.reactCompiler), which is entitled to treat a
 * property read of a stable module value during render as a constant and hoist it out. This hook
 * used to read `portRef.current` and `driftFeel.enabled` during render and hand back `loaded`,
 * `sound`, `soundOn` and a `recentHaptics()` closure straight off mutable module state; it
 * rendered correctly only because the `/sound` lab happens to force a re-render 20 times a
 * second, and `/drive` and `/results/[id]` happen to ignore those fields. A snapshot object with
 * a new identity on every change is state, and cannot be hoisted.
 */
import { useCallback, useEffect, useState } from 'react';

import type { LiveFrame } from '../../engine/pipeline';
import { createSoundPort, type PreparedSoundPort, type SoundPortState } from '../../platform/audio';
import { createHapticPort, type PreparedHapticPort } from '../../platform/haptics';
import { nowMs } from '../../platform/clock';
import { loadSettings, peekSettings, subscribeSettings } from '../../platform/settings';
import { AUDIO_FILES, BED_HIGH, BED_LOW, type SoundId } from './bank';
import { DriftFeel } from './mixer';
import { AUDIO_SOURCES } from './sources';
import { CLIP_MEASUREMENTS } from './waveforms';

/** The one mixer. Screens attach ports to it; call sites talk to it through the functions below. */
export const driftFeel = new DriftFeel();

let attached = false;

/**
 * One live frame. Safe to call before any screen has mounted the hook (it costs one boolean
 * test), and safe to call after the screen is gone.
 *
 * The dispatch measurement is taken only on frames that actually produced a cue, so
 * `stats.lastDispatchMs` is the number the brief asks for — the delay between the frame arriving
 * and `SoundPort.play()` having been called — rather than an average dominated by silent frames.
 */
export function feelFrame(frame: LiveFrame): void {
  if (!attached) return;
  const before = driftFeel.stats.cues;
  const t0 = nowMs();
  driftFeel.frame(frame);
  if (driftFeel.stats.cues !== before) driftFeel.noteDispatch(nowMs() - t0);
}

/** One cue from outside the frame stream: the STOP control, the grade reveal, the lab. */
export function feelCue(id: SoundId): void {
  if (!attached) return;
  const t0 = nowMs();
  driftFeel.cue(id);
  driftFeel.noteDispatch(nowMs() - t0);
}

/** Forget the previous run's phase edges and close the bed. Called when a run starts. */
export function feelReset(): void {
  driftFeel.reset();
}

export interface FeelStatus {
  /**
   * The mixer these ports are attached to. Exposed so a screen reads the instance that is
   * actually wired rather than reaching for the module singleton and hoping they are the same.
   */
  mixer: DriftFeel;
  /** 'ready' once a cue would be audible; 'locked' on web until the first user gesture. */
  state: SoundPortState | 'loading';
  /** Clips decoded / clips in the bank. */
  loaded: number;
  total: number;
  /** What the platform is doing, in one line. */
  sound: string;
  haptics: string;
  hapticsAvailable: boolean;
  /** True when the settings say sound / haptics are on. */
  soundOn: boolean;
  hapticsOn: boolean;
  /**
   * Whether a cue offered RIGHT NOW would actually be heard: the port is ready AND the driver
   * has not switched sound off. `state` alone answers "is the port ready", which is a different
   * question — the lab read it and printed AUDIBLE in green above "0/3 played".
   */
  audible: boolean;
  /**
   * Resume a web AudioContext. MUST be called from inside a user gesture; resolves with the
   * state afterwards so a caller can fire its cue once the context is actually running. On
   * native it resolves immediately.
   */
  unlock(): Promise<SoundPortState>;
  /** The haptic shapes the port was actually asked for (web only — see `haptics.web.ts`). */
  recentHaptics(): readonly string[];
}

const SOURCES = {
  modules: AUDIO_SOURCES as Record<string, number>,
  durations: Object.fromEntries(Object.keys(AUDIO_SOURCES).map((id) => [id, CLIP_MEASUREMENTS[id]?.durationS ?? 0.6])),
  bedLow: BED_LOW as string,
  bedHigh: BED_HIGH as string,
};

// ── the singleton ports, and the snapshot every screen reads ─────────────────────────────────
let soundPort: PreparedSoundPort | null = null;
let hapticPort: PreparedHapticPort | null = null;
let building: Promise<void> | null = null;
let unloadHooked = false;

type Snapshot = Omit<FeelStatus, 'mixer' | 'unlock' | 'recentHaptics'>;

const listeners = new Set<() => void>();

let snapshot: Snapshot = {
  state: 'loading',
  loaded: 0,
  total: AUDIO_FILES.length,
  sound: 'loading the sound bank',
  haptics: 'loading',
  hapticsAvailable: false,
  soundOn: true,
  hapticsOn: true,
  audible: false,
};

/** Rebuild the snapshot from the ports and the settings, and notify only when something moved. */
function publish(): void {
  const settings = driftFeel.enabled;
  const state: SoundPortState | 'loading' = soundPort ? soundPort.state : 'loading';
  const next: Snapshot = {
    state,
    loaded: soundPort?.loaded ?? 0,
    total: soundPort?.total ?? AUDIO_FILES.length,
    sound: soundPort?.describe() ?? 'loading the sound bank',
    haptics: hapticPort?.describe() ?? 'loading',
    hapticsAvailable: hapticPort?.available ?? false,
    soundOn: settings.sound,
    hapticsOn: settings.haptics,
    audible: state === 'ready' && settings.sound,
  };
  const prev = snapshot;
  if (
    prev.state === next.state &&
    prev.loaded === next.loaded &&
    prev.total === next.total &&
    prev.sound === next.sound &&
    prev.haptics === next.haptics &&
    prev.hapticsAvailable === next.hapticsAvailable &&
    prev.soundOn === next.soundOn &&
    prev.hapticsOn === next.hapticsOn
  ) {
    return;
  }
  snapshot = next;
  for (const l of listeners) l();
}

let settingsWired = false;

/**
 * The two settings, wired once for the life of the module. They are pushed into the mixer as two
 * booleans — read at the moment of play, so flipping a switch takes effect on the next cue — and
 * `publish` is what tells the screens.
 */
function ensureSettings(): void {
  if (settingsWired) return;
  settingsWired = true;
  // Synchronous, before anything can fire: whatever settings are already known. `peekSettings`
  // returns the defaults until the first load resolves, and `sound` defaults to true, which is
  // the same promise the settings screen has been making since before any of this existed.
  const seed = peekSettings();
  driftFeel.setSettings(seed.sound, seed.haptics);
  subscribeSettings((s) => {
    driftFeel.setSettings(s.sound, s.haptics);
    publish();
  });
  void loadSettings().then((s) => {
    driftFeel.setSettings(s.sound, s.haptics);
    publish();
  });
}

/**
 * Build the ports, once. Every later caller awaits the same promise, which resolves as soon as
 * the bank is playable — never later.
 *
 * On native `PreparedSoundPort.loaded` counts players that have finished loading, a value that
 * CONVERGES rather than one that arrives, so a bounded background poll re-publishes until every
 * clip is in and then stops. It is deliberately outside the awaited promise: `unlock()` runs
 * inside a user gesture and must not wait five seconds for a counter to settle. On web `loaded`
 * is final the moment the decodes resolve, and the first pass ends the poll.
 */
function ensurePorts(): Promise<void> {
  if (building) return building;
  building = (async () => {
    ensureSettings();
    hapticPort = createHapticPort();
    publish();

    const port = await createSoundPort(SOURCES);
    soundPort = port;
    driftFeel.attach(port, hapticPort);
    attached = true;
    hookUnload();
    publish();

    void (async () => {
      for (let i = 0; i < 20 && soundPort === port && port.loaded < port.total; i++) {
        await new Promise((r) => setTimeout(r, 250));
        publish();
      }
    })();
  })();
  return building;
}

/**
 * Release the ports for good. There is exactly one right moment for this and it is the app
 * going away, not a screen going away — see the header.
 */
export function releaseFeel(): void {
  attached = false;
  driftFeel.attach(null, null);
  driftFeel.release();
  soundPort?.release();
  soundPort = null;
  hapticPort = null;
  building = null;
  publish();
}

function hookUnload(): void {
  if (unloadHooked) return;
  const target = globalThis as unknown as { addEventListener?: typeof addEventListener };
  if (!target.addEventListener) return;
  unloadHooked = true;
  // `pagehide` rather than `beforeunload`: it also fires when a mobile browser freezes the tab,
  // and it does not make the page ineligible for the back/forward cache.
  //
  // AND ONLY WHEN THE PAGE IS REALLY GOING. `persisted` is true when the browser is putting the
  // page into that cache rather than destroying it; releasing then would tear down the
  // AudioContext behind a page that is about to come back with its React tree intact and no
  // effect to rebuild it, which is a silent app for the rest of the session.
  target.addEventListener('pagehide', (e: Event) => {
    if ((e as PageTransitionEvent).persisted) return;
    releaseFeel();
  });
}

/**
 * Mount the feel layer: build the ports the first time any screen asks, and subscribe to the
 * status. Cheap on every mount after the first — nothing is decoded, nothing is awaited.
 */
export function useDriftFeel(): FeelStatus {
  const [snap, setSnap] = useState<Snapshot>(() => snapshot);

  useEffect(() => {
    const listener = () => setSnap(snapshot);
    listeners.add(listener);
    void ensurePorts();
    // The ports may have finished building between the first render and this effect.
    listener();
    return () => {
      listeners.delete(listener);
      // The screen is going, the port is not. Forget the RUN — the bed closes, the phase edges
      // and the fault latch are dropped — so a slide in progress cannot drone into the next
      // screen, while every decoded clip and the audio session survive.
      driftFeel.reset();
    };
  }, []);

  const unlock = useCallback(async () => {
    await ensurePorts();
    const port = soundPort;
    if (!port) return 'unavailable' as SoundPortState;
    const next = await port.unlock();
    publish();
    return next;
  }, []);

  // A browser will not start an AudioContext until the page has been touched. One listener, once.
  useEffect(() => {
    if (snap.state !== 'locked') return;
    const target = globalThis as unknown as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
    if (!target.addEventListener) return;
    const onGesture = () => void unlock();
    target.addEventListener('pointerdown', onGesture, { once: true });
    target.addEventListener('keydown', onGesture, { once: true });
    return () => {
      target.removeEventListener?.('pointerdown', onGesture);
      target.removeEventListener?.('keydown', onGesture);
    };
  }, [snap.state, unlock]);

  const recentHaptics = useCallback(() => hapticPort?.recent() ?? [], []);

  return { mixer: driftFeel, ...snap, unlock, recentHaptics };
}
