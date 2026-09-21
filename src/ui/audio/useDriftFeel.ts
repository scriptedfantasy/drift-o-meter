/**
 * The feel layer's screen-level lifecycle, and the one-line call sites.
 *
 *   const feel = useDriftFeel();     // once per screen: loads the bank, configures the session
 *   feelFrame(frame);                // in the 100 Hz path
 *   feelCue('stop');                 // from a control, or the results screen's grade reveal
 *
 * `feelFrame` and `feelCue` are plain module functions against a singleton, not methods on a
 * hook result, for two reasons. They have to be callable from inside `useDriveRun`'s `applyFrame`
 * — a `useCallback` that must not gain a dependency — and they have to be no-ops until a screen
 * has mounted the hook, so a call site can be added without the screen having to care whether
 * sound exists yet.
 *
 * Nothing in here runs in the 100 Hz path except `feelFrame`, which is two clock reads and a
 * `DriftFeel.frame()`. The settings are subscribed once, here, and pushed into the mixer as two
 * booleans — exactly the property `useDriveRun` already holds for haptics, kept.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { LiveFrame } from '../../engine/pipeline';
import { createSoundPort, type PreparedSoundPort, type SoundPortState } from '../../platform/audio';
import { createHapticPort, type PreparedHapticPort } from '../../platform/haptics';
import { nowMs } from '../../platform/clock';
import { loadSettings, peekSettings, subscribeSettings } from '../../platform/settings';
import { BED_HIGH, BED_LOW, SOUND_BANK, type SoundId } from './bank';
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

/**
 * Mount the feel layer for a screen: configure the audio session, build every player, subscribe
 * to the two settings. Everything expensive happens here, once, so no cue path ever allocates,
 * decodes or awaits.
 */
export function useDriftFeel(): FeelStatus {
  const [state, setState] = useState<SoundPortState | 'loading'>('loading');
  const [tick, setTick] = useState(0);
  const portRef = useRef<PreparedSoundPort | null>(null);
  const hapticRef = useRef<PreparedHapticPort | null>(null);

  useEffect(() => {
    let alive = true;

    // Synchronous, before anything can fire: whatever settings are already known. `peekSettings`
    // returns the defaults until the first load resolves, and `sound` defaults to true, which is
    // the same promise the settings screen has been making since before any of this existed.
    const seed = peekSettings();
    driftFeel.setSettings(seed.sound, seed.haptics);
    const unsubscribe = subscribeSettings((s) => driftFeel.setSettings(s.sound, s.haptics));
    void loadSettings().then((s) => {
      if (alive) driftFeel.setSettings(s.sound, s.haptics);
    });

    const haptics = createHapticPort();
    hapticRef.current = haptics;

    void createSoundPort(SOURCES).then((port) => {
      if (!alive) {
        port.release();
        return;
      }
      portRef.current = port;
      driftFeel.attach(port, haptics);
      attached = true;
      setState(port.state);
    });

    return () => {
      alive = false;
      unsubscribe();
      attached = false;
      driftFeel.attach(null, null);
      driftFeel.release();
      portRef.current?.release();
      portRef.current = null;
      hapticRef.current = null;
    };
  }, []);

  const unlock = useCallback(async () => {
    const port = portRef.current;
    if (!port) return 'unavailable' as SoundPortState;
    const next = await port.unlock();
    setState(next);
    setTick((n) => n + 1);
    return next;
  }, []);

  // A browser will not start an AudioContext until the page has been touched. One listener, once.
  useEffect(() => {
    if (state !== 'locked') return;
    const target = globalThis as unknown as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
    if (!target.addEventListener) return;
    const onGesture = () => void unlock();
    target.addEventListener('pointerdown', onGesture, { once: true });
    target.addEventListener('keydown', onGesture, { once: true });
    return () => {
      target.removeEventListener?.('pointerdown', onGesture);
      target.removeEventListener?.('keydown', onGesture);
    };
  }, [state, unlock]);

  const port = portRef.current;
  const settings = driftFeel.enabled;
  void tick; // re-render after an unlock so the lab's status line is never stale
  return {
    mixer: driftFeel,
    state,
    loaded: port?.loaded ?? 0,
    total: port?.total ?? SOUND_BANK.length + 2,
    sound: port?.describe() ?? 'loading the sound bank',
    haptics: hapticRef.current?.describe() ?? 'loading',
    hapticsAvailable: hapticRef.current?.available ?? false,
    soundOn: settings.sound,
    hapticsOn: settings.haptics,
    unlock,
    recentHaptics: () => hapticRef.current?.recent() ?? [],
  };
}
