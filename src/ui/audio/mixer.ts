/**
 * The feel layer: one place that turns the run's events into sound and haptics.
 *
 *   LiveFrame (100 Hz) ──▶ DriftFeel.frame() ──▶ cue() ──▶ SoundPort.play()
 *                                            └──▶ bed()  ──▶ SoundPort.setBed()
 *                                            └──▶ HapticPort.impact()
 *
 * Pure TypeScript: no React, no React Native, no Expo. It runs in the app, in vitest on Linux
 * and in `tools/audio/bench.mjs`, which is how the latency numbers in the report were measured.
 * Everything platform-shaped lives behind the two port interfaces at the bottom of this file.
 *
 * ── The 100 Hz contract ───────────────────────────────────────────────────────────────────────
 * `frame()` runs once per motion sample. On a frame with no event it does a fixed number of
 * comparisons and ZERO allocations: no arrays, no closures, no object literals, no `Date`, no
 * settings read, no promise. The settings gate is two booleans on `this`, refreshed by a
 * subscription outside the hot path, and read at the moment of play so flipping the switch is
 * instant. The bed is pushed to the port at most 20 times a second and only when a gain has
 * actually moved. Measured cost: see `tools/audio/bench.mjs`.
 *
 * ── Why a mixer at all ────────────────────────────────────────────────────────────────────────
 * At the peak of a run several events land inside a few hundred ms. Measured on the real
 * pipeline over a harbour run: up to 3 cue moments inside 300 ms on a clean run and up to 7 on a
 * hand-held one. Three clips at once is mud, so this owns:
 *
 *   1. FAMILIES.  At most one cue per family survives a frame — the highest priority one. The
 *      events inside a family are the same moment described twice (INITIATION and LINK fire on
 *      the same frame; so do CHAIN LOST and SPIN).
 *   2. THE FLICK RULE.  A flick suppresses the entry chirp on the same frame, because a flick IS
 *      the initiation of the new direction. The detector really does emit EXIT then ENTRY 110 ms
 *      apart across a transition, and chirping through that is the single ugliest thing the
 *      naive mapping does.
 *   3. TWO VOICES.  A third simultaneous clip is mud by definition, so the budget is two, and a
 *      new cue takes a sounding voice only from something STRICTLY lower priority. Equal
 *      priority means the voice already speaking keeps the floor.
 *   4. THE BED DUCKS ITSELF.  While a voice at priority ≥ 60 is sounding, the continuous layer
 *      drops 5 dB. That is this app ducking its OWN layer — the driver's music is never touched.
 *   5. THE BELIEF GATE.  Scoring cues are dropped while `LiveFrame.integrity.believable` is
 *      false — the engine's OWN answer to "is this reading worth showing in colour", which it
 *      publishes precisely so that no screen re-derives it. On a hand-held recording the
 *      detector still fires 44 entry edges and the scorer still fires 11 initiation callouts;
 *      the drive display refuses to bloom for them and the feel layer refuses to speak.
 *
 *      NOT `score.counting`, which answers a different question — "is the scorer paying on THIS
 *      sample" — and is false at every red light and between every pair of slides. A BANKED
 *      lands about two seconds after a drift ends, so gating it on `counting` would swallow the
 *      loudest moment in the run.
 *   6. THE FAULT REPORT.  Rule 5's silence is correct and, on its own, indistinguishable from a
 *      broken app. Measured: a hand-held recording offers 56 cues and plays none of them for two
 *      whole laps. So the FIRST time the gate actually drops a cue, one quiet clip and a warning
 *      haptic say why — once, latched, never repeated — and RECOVERED says when it is over.
 *
 *      It hangs off the DROPPED CUE, not off the belief flag, and that is a measurement rather
 *      than a preference: every clean run is unbelievable for its first 5.0–5.5 s while the
 *      calibrator finds forward (harbour s1 5.3 s, s2 5.0 s, touge s1 5.3 s), so a report on the
 *      flag alone would fire at the start of every single drive. In those seconds the car is
 *      standing still and the gate drops nothing at all — measured zero gated cues on every
 *      believable run tried — so hanging it off the drop makes it fire exactly when the silence
 *      costs the driver something.
 *   7. THE LANDING.  The exit phase edge gets a light haptic and no clip (see `bank.ts`), held
 *      `EXIT_SETTLE_S` and cancelled if the car goes again, so a flick does not stutter.
 */
import type { LiveFrame } from '../../engine/pipeline';
import { radToDeg, type DriftPhase } from '../../engine/types';
import type { HapticPort, SoundPort } from '../../platform/audioTypes';
import { now as monotonicNow } from '../../platform/clock';
import { BED_HIGH, BED_LOW, CALLOUT_SOUND, EXIT_SETTLE_S, specFor, voiceLifetimeS, type CueFamily, type HapticShape, type SoundId, type SoundSpec } from './bank';

/**
 * What the mixer needs from a platform to make a noise. Both ports may be absent — with neither
 * attached every rule below still runs and still logs its decision, which is how the tests and
 * the bench exercise the mixer without an audio device.
 */
export type { HapticPort, SoundPort } from '../../platform/audioTypes';

/** Why a cue did or did not reach the speaker. The `/sound` lab shows the last 24 of these. */
export type CueOutcome = 'played' | 'stole' | 'felt' | 'busy' | 'family' | 'flick' | 'debounce' | 'gated' | 'muted' | 'silent' | 'unknown';

export interface CueDecision {
  id: SoundId;
  /** Monotonic seconds when the decision was taken. */
  t: number;
  outcome: CueOutcome;
  /** For 'stole', the clip whose voice was taken; for 'busy'/'family', the clip that kept it. */
  against: SoundId | null;
  /** Whether a haptic went out with it (false when haptics are off or the event has none). */
  haptic: HapticShape | null;
}

export interface FeelStats {
  frames: number;
  cues: number;
  played: number;
  dropped: number;
  stolen: number;
  bedPushes: number;
  /** Seconds between the frame arriving and `SoundPort.play()` being called, worst case so far. */
  worstDispatchMs: number;
  lastDispatchMs: number;
}

export interface FeelOptions {
  /** Monotonic seconds. Injected so tests and the bench can drive time by hand. */
  now?: () => number;
  /** Simultaneous one-shot voices. Two, because three clips at once is mud. */
  maxVoices?: number;
  /** Keep a decision log for the lab. */
  log?: boolean;
  /**
   * How many decisions the log keeps. 64 is what the `/sound` lab needs and all a phone should
   * ever hold; `tools/audio/bench.ts` raises it so it can print a whole run instead of printing
   * "the first 60" of a window that had already rotated past them.
   */
  logLimit?: number;
}

const ACTIVE_PHASES: ReadonlySet<DriftPhase> = new Set<DriftPhase>(['entry', 'drifting', 'transition']);

/**
 * How much of the reading the engine stands behind, 0..1 — and the ONE implementation of it.
 *
 * The drive display's ember glow and this module's continuous bed are two answers to a single
 * question, "how much does the engine trust this reading", and they used to give different ones:
 * the glow multiplied its target by this degree while the bed was a plain open/closed, so through
 * a GPS dropout or on a suspect mount the screen dimmed to 65 % and the bed played at 100 %. A
 * threshold copied into a second file is the defect class this project has been burned by more
 * than once, so there is no second copy — `useDriveRun.ts` imports this.
 *
 * It lives here because this module is the pure one: no React, no React Native, no Expo, so a
 * hook can import it and a test can call it.
 *
 * 0.65 is not a second opinion, it is a DEGREE: the engine believes the reading and says the
 * input is degraded — a shaking mount, a weak fix, or β dead-reckoned through a dropout.
 */
export function trustIn(integrity: LiveFrame['integrity']): number {
  if (!integrity.believable) return 0;
  const degraded = integrity.mount === 'suspect' || integrity.gps === 'poor' || integrity.gps === 'none';
  return degraded ? 0.65 : 1;
}

/**
 * Bed envelope, deliberately the same two constants the drive display uses for the ember glow.
 *
 * EXPORTED, because the `/sound` lab draws the curve and describes it in words. It used to type
 * "90 ms up, 240 ms down … shuts completely below 6°" into its own prose and re-implement
 * `6 + gain * 44` in a helper, which is the same defect as any other threshold copied into a
 * second file: it reads as a measurement and it would go stale the first time this envelope was
 * tuned.
 */
export const BED_ATTACK_TAU = 0.09;
export const BED_RELEASE_TAU = 0.24;
/** |β| in degrees at which the bed opens and at which it is fully open — the HUD's glow curve. */
export const BED_FLOOR_DEG = 6;
export const BED_SPAN_DEG = 44;
/** |β| band across which the cross-fade travels from the dark layer to the bright one. */
const BED_MIX_FLOOR_DEG = 10;
const BED_MIX_SPAN_DEG = 38;
/** Overall bed level. The layers are rendered at −26 dBFS RMS; this is the runtime trim. */
const BED_LEVEL = 0.85;
/** How far the bed ducks under a loud cue (−5 dB) and above which priority it does so. */
const BED_DUCK = 0.56;
const BED_DUCK_PRIORITY = 60;
/** The bed is pushed to the port at most this often. */
const BED_PUSH_INTERVAL_S = 0.05;
const BED_EPSILON = 0.012;

/**
 * A frame stream running faster than this multiple of real time is a SCRUB, not a drive, and the
 * feel layer stays silent through it while still tracking the run's state.
 *
 * This is not a theoretical worry. `?at=<s>` warps the simulated recording by pushing minutes of
 * frames through the pipeline in one synchronous burst before the screen is drawn — which is how
 * every held HUD frame in the capture harness is produced — and the drive display already guards
 * its flash, its shake and its haptic against exactly that (`useDriveRun`'s `warping`). Without
 * this, opening `/drive?at=100` would fire a hundred seconds of drift audio into the first
 * animation frame.
 *
 * Detection is exact rather than heuristic, because of how the two sources timestamp samples:
 * the device adapter stamps every sample with `clock.now()` AT DELIVERY, so on a phone recording
 * time and wall time advance together by construction and the ratio is always 1; and `SimPlayer`
 * keeps the recording's own timestamps and schedules delivery by `rate`, so the ratio IS the
 * playback rate. The settings screen offers at most 4×, so 6 leaves a clear margin under it and
 * a vast one under a warp, which arrives at thousands of times real time.
 */
const MAX_PLAY_RATE = 6;
/** Recording seconds per rate measurement. Short enough that a warp is caught almost at once. */
const RATE_WINDOW_S = 0.2;

interface Voice {
  id: SoundId;
  priority: number;
  /** Monotonic seconds at which this voice frees itself. */
  endsAt: number;
}

/** One candidate per family, resolved at the end of the frame. Preallocated: the hot path allocates nothing. */
interface Slot {
  id: SoundId | null;
  priority: number;
}

const FAMILIES: readonly CueFamily[] = ['entry', 'flick', 'angle', 'accent', 'exit', 'chain', 'lap', 'lapverdict', 'fault', 'run'];

/**
 * Family → index into the preallocated slot array. A `Map` would be tidier, but iterating one
 * allocates an iterator object, and this is walked twice per frame at 100 Hz.
 */
const FAMILY_INDEX: Record<CueFamily, number> = { entry: 0, flick: 1, angle: 2, accent: 3, exit: 4, chain: 5, lap: 6, lapverdict: 7, fault: 8, run: 9 };

export class DriftFeel {
  private sound: SoundPort | null = null;
  private haptics: HapticPort | null = null;
  private readonly now: () => number;
  private readonly maxVoices: number;
  private readonly keepLog: boolean;
  private readonly logLimit: number;

  /** Both settings, read at the moment of play. Never read from storage in the hot path. */
  private soundOn = true;
  private hapticsOn = true;

  private readonly voices: Voice[] = [];
  private readonly lastPlayed = new Map<SoundId, number>();
  private readonly slots: Slot[] = FAMILIES.map(() => ({ id: null, priority: -1 }));

  /** Frame-to-frame scratch. Never reallocated. */
  private prevPhase: DriftPhase = 'idle';
  private believable = false;
  /**
   * Recording seconds at which a pending exit beat is due, or NaN. See `EXIT_SETTLE_S`: the beat
   * is armed on the exit phase edge and disarmed if the car goes active again before it lands.
   */
  private exitDueAt = NaN;
  /** True once FAULT has been reported for the current stretch of disbelief. Cleared by RECOVERED. */
  private faulted = false;
  private bedGain = 0;
  private bedMix = 0;
  private bedPushedLow = -1;
  private bedPushedHigh = -1;
  private lastBedPush = -Infinity;
  private lastFrameT = NaN;
  private lastWallT = NaN;
  /** Recording seconds per wall second, measured over `RATE_WINDOW_S`. 1 on a phone, always. */
  private playRate = 1;
  private winRec = 0;
  private winWall = 0;
  private scrubbing = false;

  readonly stats: FeelStats = { frames: 0, cues: 0, played: 0, dropped: 0, stolen: 0, bedPushes: 0, worstDispatchMs: 0, lastDispatchMs: 0 };
  readonly decisions: CueDecision[] = [];

  constructor(opts: FeelOptions = {}) {
    this.now = opts.now ?? monotonicNow;
    this.maxVoices = opts.maxVoices ?? 2;
    this.keepLog = opts.log ?? true;
    this.logLimit = opts.logLimit ?? 64;
  }

  // ── wiring ────────────────────────────────────────────────────────────────────────────────
  attach(sound: SoundPort | null, haptics: HapticPort | null): void {
    this.sound = sound;
    this.haptics = haptics;
  }

  /** Called from the settings subscription — never from the hot path. */
  setSettings(sound: boolean, haptics: boolean): void {
    this.soundOn = sound;
    this.hapticsOn = haptics;
    if (!sound) this.closeBed();
  }

  get enabled(): { sound: boolean; haptics: boolean } {
    return { sound: this.soundOn, haptics: this.hapticsOn };
  }

  /** Forget the run: phase edges, the gate, the bed. Voices are left to expire on their own. */
  reset(): void {
    this.prevPhase = 'idle';
    this.believable = false;
    this.exitDueAt = NaN;
    this.faulted = false;
    this.lastFrameT = NaN;
    this.lastWallT = NaN;
    this.playRate = 1;
    this.winRec = 0;
    this.winWall = 0;
    this.scrubbing = false;
    this.lastPlayed.clear();
    this.closeBed();
  }

  /** Close the bed and release every voice. Called when the screen goes away. */
  release(): void {
    this.reset();
    this.voices.length = 0;
  }

  // ── the 100 Hz path ───────────────────────────────────────────────────────────────────────
  /**
   * One live frame. Allocation-free on every frame, including the ones that fire a cue: the
   * per-family candidate slots and the voice list are preallocated and reused.
   */
  frame(f: LiveFrame): void {
    this.stats.frames++;
    const t = this.now();
    const ft = f.t;
    // `dt` drives two exponential filters and the play-rate window, and none of the three has a
    // way back from NaN: one non-finite frame time would leave `bedGain`, `bedMix` and `winRec`
    // poisoned for the rest of the run. A non-finite step falls back to the nominal 10 ms — which
    // is also what the first frame of a run gets, so this replaces the old `lastFrameT` test
    // rather than adding to it.
    const step = ft - this.lastFrameT;
    const dt = Number.isFinite(step) ? Math.min(0.1, Math.max(0, step)) : 0.01;
    this.lastFrameT = ft;

    // Playback rate, measured rather than declared: see MAX_PLAY_RATE.
    const wallDt = Number.isFinite(this.lastWallT) ? Math.max(0, t - this.lastWallT) : dt;
    this.lastWallT = t;
    this.winRec += dt;
    this.winWall += wallDt;
    if (this.winRec >= RATE_WINDOW_S) {
      this.playRate = this.winRec / Math.max(1e-9, this.winWall);
      this.winRec = 0;
      this.winWall = 0;
      this.scrubbing = this.playRate > MAX_PLAY_RATE;
    }

    this.believable = f.integrity.believable;

    const phase = f.phase;
    const active = ACTIVE_PHASES.has(phase);
    const wasActive = ACTIVE_PHASES.has(this.prevPhase);
    const flick = phase === 'transition' && this.prevPhase !== 'transition';

    // A scrub still moves every piece of state — the phase edges, the gate latch, the bed
    // envelope — so that the instant the stream returns to real time the feel layer is already
    // where the run is. It simply does not speak on the way there.
    if (!this.scrubbing) {
      // Candidates. Cleared in place; `clearSlots` touches nine preallocated objects.
      this.clearSlots();

      // THE LANDING. The exit phase edge arms a beat rather than firing one: across 18 measured
      // runs, 95 of 197 exit edges were the dip in the middle of a flick (82 of them re-entered
      // within 150 ms), and a beat on each turns a manji into a stutter. Going active again
      // disarms it; surviving `EXIT_SETTLE_S` fires it. `f.completed` is no use here — the
      // detector publishes it 0.99–1.01 s after the edge, which is a verdict, not a landing.
      if (!active && wasActive) this.exitDueAt = ft + EXIT_SETTLE_S;
      else if (active) this.exitDueAt = NaN;
      if (Number.isFinite(this.exitDueAt) && ft >= this.exitDueAt) {
        this.exitDueAt = NaN;
        this.offer('exit-edge', t);
      }

      // The flick takes the phase edge, 410 ms ahead of the callout that names it.
      if (flick) this.offer('transition', t);
      // The entry chirp takes the phase edge too. It is offered even on a flick frame and then
      // dropped by the flick rule in `flushSlots`, rather than never offered, so the decision is
      // recorded and the lab can show the rule firing instead of an absence.
      if (active && !wasActive) this.offer('initiation', t);

      const callouts = f.score.callouts;
      for (let i = 0; i < callouts.length; i++) {
        const id = CALLOUT_SOUND[callouts[i].kind];
        if (id !== null) this.offer(id, t);
      }

      // Both are offered even though they arrive on the same frame: the family rule is what
      // decides, and it logs the loser, so "the spin outranks the chain it lost" is visible
      // rather than hidden in an `else`.
      if (f.completed !== null && f.completed.spin) this.offer('spin', t);
      if (f.score.lost) this.offer('lost', t);
      if (f.score.banked) this.offer('banked', t);
      if (f.lap.completed !== null) this.offer('lap', t);

      this.flushSlots(t, flick, true);
    }

    // The other half of rule 6: once the engine believes again, say so. Not gated, not offered —
    // a recovery has no family to lose to and nothing to be sceptical about.
    if (!this.scrubbing && this.faulted && this.believable) {
      this.faulted = false;
      const back = specFor('recovered');
      if (back) this.dispatch(back, t, false);
    }

    // ── the continuous layer ────────────────────────────────────────────────────────────────
    // β ARRIVES ON TRUST FROM THE ESTIMATOR, so it is clamped here. `bedGain` is a running
    // exponential filter: one non-finite β makes it NaN and it never recovers, every later frame
    // pushes `setBed(NaN, NaN)`, and on web assigning a non-finite float to an AudioParam throws
    // a TypeError inside the 100 Hz path. `guardMotion` does keep β finite across 30 000 frames
    // of the worst runs measured, so this is a latch that cannot be allowed to exist rather than
    // a bug being fixed: a filter with no way back is not allowed to take an unchecked input.
    const beta = f.state.beta;
    const absDeg = Number.isFinite(beta) ? Math.abs(radToDeg(beta)) : 0;
    // THE SAME NUMBER the drive display's ember glow uses, from the same function: `trustIn` is
    // 0 when the engine will not stand behind the reading and 0.65 when it believes it but calls
    // the input degraded. The bed used to be a plain open/closed, so through a dropout the glow
    // dimmed to 65 % and the bed played at full — two channels answering one question differently.
    const trust = trustIn(f.integrity);
    const open = active && trust > 0;
    const target = open ? clamp01((absDeg - BED_FLOOR_DEG) / BED_SPAN_DEG) * trust : 0;
    const tau = target > this.bedGain ? BED_ATTACK_TAU : BED_RELEASE_TAU;
    this.bedGain += (target - this.bedGain) * (1 - Math.exp(-dt / tau));
    const mixTarget = clamp01((absDeg - BED_MIX_FLOOR_DEG) / BED_MIX_SPAN_DEG);
    this.bedMix += (mixTarget - this.bedMix) * (1 - Math.exp(-dt / 0.12));
    this.pushBed(t);

    this.prevPhase = phase;
  }

  // ── cues ──────────────────────────────────────────────────────────────────────────────────
  /**
   * Fire a cue outside the frame stream: the STOP control, the grade reveal, the `/sound` lab.
   * Same gate, same priority, same voices.
   */
  cue(id: SoundId): CueOutcome {
    const t = this.now();
    const spec = specFor(id);
    if (!spec) return this.record(id, t, 'unknown', null, null);
    // No belief gate here. The gate exists to stop the FRAME STREAM from narrating a run the
    // engine does not stand behind; a cue that came from a control the driver pressed, from the
    // results screen, or from the `/sound` lab did not come from the frame stream and has
    // nothing to be sceptical about.
    return this.dispatch(spec, t, false);
  }

  /**
   * Several cues arriving on ONE instant, resolved exactly as `frame()` resolves them: the
   * family rule, the flick rule, the priority order, the two voices.
   *
   * This exists because of a specific lie. The `/sound` lab's THE SPIN button replays a moment
   * where CHAIN LOST and SPIN land on the same frame, under a caption that says "the cause
   * outranks the consequence, so you hear one" — and it used to call `cue()` once per step,
   * which is the OUTSIDE-the-frame-stream path with no slots in it. Both clips started, 0.1 ms
   * apart, and the decision log read `SPIN played` / `LOST played`. The rule the lab exists to
   * demonstrate was the one rule it could not show. Now the press goes through here and the log
   * reads `lost · family · vs spin`.
   *
   * `fromFrame` is false, for the same reason `cue()` sets it false: the belief gate exists to
   * stop the FRAME STREAM from narrating a run the engine does not stand behind, and a button a
   * person pressed has nothing to be sceptical about. Everything else is the shipping path.
   */
  offerAll(ids: readonly SoundId[]): void {
    const t = this.now();
    this.clearSlots();
    let flick = false;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === 'transition') flick = true;
      this.offer(ids[i], t);
    }
    this.flushSlots(t, flick, false);
  }

  /**
   * Offer a candidate for its family; the highest-priority offer in a frame is the one that
   * survives. The loser is logged as 'family' rather than dropped in silence, so the `/sound`
   * lab and the tests can see the rule fire — CHAIN LOST losing to SPIN is the case that matters.
   */
  private offer(id: SoundId, t: number): void {
    const spec = specFor(id);
    if (!spec) return;
    const slot = this.slots[FAMILY_INDEX[spec.family]];
    if (spec.priority > slot.priority) {
      if (slot.id !== null) this.record(slot.id, t, 'family', id, null);
      slot.id = id;
      slot.priority = spec.priority;
    } else {
      this.record(id, t, 'family', slot.id, null);
    }
  }

  private clearSlots(): void {
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i].id = null;
      this.slots[i].priority = -1;
    }
  }

  /**
   * Dispatch the surviving candidate of every family, highest priority first.
   *
   * `fromFrame` travels through to `dispatch`: it is what decides whether the belief gate
   * applies. True from `frame()`, false from `offerAll()` — see there.
   */
  private flushSlots(t: number, flick: boolean, fromFrame: boolean): void {
    // The flick rule, applied here rather than at the offer site so the lab can show it firing.
    if (flick) {
      const entry = this.slots[FAMILY_INDEX.entry];
      if (entry.id !== null) {
        this.record(entry.id, t, 'flick', 'transition', null);
        entry.id = null;
        entry.priority = -1;
      }
    }
    // Highest priority first, so a spin never loses its voice to a lap ping that shared the frame.
    for (;;) {
      let best: Slot | null = null;
      for (let i = 0; i < this.slots.length; i++) {
        const slot = this.slots[i];
        if (slot.id !== null && (best === null || slot.priority > best.priority)) best = slot;
      }
      if (best === null || best.id === null) return;
      const spec = specFor(best.id);
      best.id = null;
      best.priority = -1;
      if (spec) this.dispatch(spec, t, fromFrame);
    }
  }

  /**
   * The gate, the debounce, the voice. This is the moment of play, and the settings are read
   * HERE — one boolean field, so flipping the switch is instant and costs nothing.
   */
  private dispatch(spec: SoundSpec, t: number, fromFrame: boolean): CueOutcome {
    this.stats.cues++;

    if (fromFrame && spec.gated && !this.believable) {
      // The silence is right; being unable to tell it from a broken app is not. The FIRST drop
      // reports itself, once, and nothing after it does until the engine believes again.
      if (!this.faulted) {
        this.faulted = true;
        const fault = specFor('fault');
        if (fault) this.dispatch(fault, t, false);
      }
      return this.record(spec.id, t, 'gated', null, null);
    }

    const last = this.lastPlayed.get(spec.id);
    if (last !== undefined && t - last < spec.minGapS) return this.record(spec.id, t, 'debounce', null, null);

    // A row with no file is felt and never heard — it takes no voice, steals none and is not
    // stopped by anything. `exit-edge` is the only one, and the whole point of it is that a
    // driver with the phone on silent still gets a beat at the end of every slide.
    if (spec.file === null) {
      const only = this.fireHaptic(spec);
      // It debounces either way, so a driver with haptics off cannot be machine-gunned the
      // moment they turn them back on mid-slide.
      this.lastPlayed.set(spec.id, t);
      if (only === null) return this.record(spec.id, t, 'muted', null, null);
      this.stats.played++;
      return this.record(spec.id, t, 'felt', null, only);
    }

    // The haptic has its own setting and its own budget: it fires even with sound off, and it
    // is NOT subject to voice stealing, because a phone can only make one buzz at a time anyway
    // and the OS queues them. It does follow the priority decision, so a stolen cue stays silent
    // in both channels.
    const outcome = this.playSound(spec, t);
    const felt = outcome === 'played' || outcome === 'stole' || outcome === 'silent' || outcome === 'muted' ? this.fireHaptic(spec) : null;

    if (outcome === 'played' || outcome === 'stole' || outcome === 'silent') {
      this.lastPlayed.set(spec.id, t);
      this.voices.push({ id: spec.id, priority: spec.priority, endsAt: t + voiceLifetimeS(spec.id) });
      this.stats.played++;
    } else if (outcome === 'muted') {
      // Sound is off, but the haptic went out, so the event still has to debounce — otherwise a
      // chattering detector machine-guns the phone for a driver who only turned the sound off.
      this.lastPlayed.set(spec.id, t);
    } else {
      this.stats.dropped++;
    }
    return this.record(spec.id, t, outcome, this.lastAgainst, felt);
  }

  private lastAgainst: SoundId | null = null;

  private playSound(spec: SoundSpec, t: number): CueOutcome {
    this.lastAgainst = null;
    if (!this.soundOn) return 'muted';

    this.expireVoices(t);
    if (this.voices.length >= this.maxVoices) {
      let weakest: Voice | null = null;
      for (const v of this.voices) if (weakest === null || v.priority < weakest.priority) weakest = v;
      // Strictly lower: a tie means the voice already speaking keeps the floor, which is what
      // stops two equally important cues from chopping each other in half.
      if (weakest === null || weakest.priority >= spec.priority) {
        this.lastAgainst = weakest ? weakest.id : null;
        return 'busy';
      }
      this.lastAgainst = weakest.id;
      this.sound?.stop(weakest.id);
      this.voices.splice(this.voices.indexOf(weakest), 1);
      this.stats.stolen++;
      const startedAfterSteal = this.sound ? this.sound.play(spec.id) : false;
      return startedAfterSteal ? 'stole' : 'silent';
    }

    const started = this.sound ? this.sound.play(spec.id) : false;
    return started ? 'played' : 'silent';
  }

  private fireHaptic(spec: SoundSpec): HapticShape | null {
    if (!this.hapticsOn || spec.haptic === null) return null;
    const port = this.haptics;
    if (!port) return spec.haptic;
    emit(port, spec.haptic);
    if (spec.hapticThen) {
      const then = spec.hapticThen;
      // The only timer in the module, and it is off the hot path: the grade reveal's second beat.
      setTimeout(() => {
        if (this.hapticsOn) emit(port, then.shape);
      }, then.delayS * 1000);
    }
    return spec.haptic;
  }

  private expireVoices(t: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].endsAt <= t) this.voices.splice(i, 1);
  }

  /** Whether the engine currently stands behind the reading. Set from every frame. */
  get believes(): boolean {
    return this.believable;
  }

  /** Measured playback rate and whether the stream is being scrubbed rather than driven. */
  get playback(): { rate: number; scrubbing: boolean } {
    return { rate: this.playRate, scrubbing: this.scrubbing };
  }

  /** Voices still sounding, for the lab. */
  activeVoices(): readonly SoundId[] {
    this.expireVoices(this.now());
    return this.voices.map((v) => v.id);
  }

  // ── the bed ───────────────────────────────────────────────────────────────────────────────
  private pushBed(t: number): void {
    const closing = this.bedGain < 0.005;
    // The throttle is skipped while scrubbing: a warp delivers a hundred seconds of frames in
    // no wall time at all, and a throttled bed would be left holding whatever gain the first
    // frame of the burst happened to produce rather than the one the run actually ends on.
    if (!closing && !this.scrubbing && t - this.lastBedPush < BED_PUSH_INTERVAL_S) return;

    let g = closing ? 0 : this.bedGain * BED_LEVEL;
    if (g > 0 && !this.soundOn) g = 0;
    if (g > 0) {
      this.expireVoices(t);
      for (const v of this.voices) {
        if (v.priority >= BED_DUCK_PRIORITY) {
          g *= BED_DUCK;
          break;
        }
      }
    }
    // Equal-power cross-fade: a linear pair dips 3 dB in the middle, which reads as the bed
    // losing its nerve exactly where the angle is most interesting.
    const x = this.bedMix;
    // `clamp01` on the way out, not for the arithmetic — `g` is at most BED_LEVEL and the two
    // factors at most 1 — but because this is the last line before the port, and a port that is
    // handed a non-finite gain throws inside the 100 Hz path (see `audio.web.ts`).
    const low = clamp01(g * Math.cos((x * Math.PI) / 2));
    const high = clamp01(g * Math.sin((x * Math.PI) / 2));
    // The epsilon is skipped on the way to zero. Otherwise the last step — from a gain just
    // under the epsilon down to silence — is never pushed, the port never hears `(0, 0)`, and
    // the two loops run at a whisper for the rest of the drive. That is a drone.
    const closed = low === 0 && high === 0;
    if (!closed && Math.abs(low - this.bedPushedLow) < BED_EPSILON && Math.abs(high - this.bedPushedHigh) < BED_EPSILON) return;
    if (closed && this.bedPushedLow === 0 && this.bedPushedHigh === 0) return;
    this.bedPushedLow = low;
    this.bedPushedHigh = high;
    this.lastBedPush = t;
    this.stats.bedPushes++;
    this.sound?.setBed(low, high);
  }

  private closeBed(): void {
    this.bedGain = 0;
    this.bedMix = 0;
    if (this.bedPushedLow !== 0 || this.bedPushedHigh !== 0) {
      this.bedPushedLow = 0;
      this.bedPushedHigh = 0;
      this.sound?.setBed(0, 0);
    }
  }

  /**
   * Drive the bed directly, for the `/sound` lab's angle sweep. Takes |β| in degrees and the
   * elapsed time since the last call, and goes through exactly the same envelope and cross-fade
   * the run uses — the lab demonstrates the real thing, not a re-implementation of it.
   */
  bedFromAngle(absDeg: number, dtIn: number, open = true, trust = 1): { low: number; high: number; gain: number } {
    const t = this.now();
    // Same two clamps as `frame()`, for the same reason: these filters have no way back from NaN.
    const deg = Number.isFinite(absDeg) ? absDeg : 0;
    const dt = Number.isFinite(dtIn) ? Math.max(0, dtIn) : 0;
    const target = open ? clamp01((deg - BED_FLOOR_DEG) / BED_SPAN_DEG) * trust : 0;
    const tau = target > this.bedGain ? BED_ATTACK_TAU : BED_RELEASE_TAU;
    this.bedGain += (target - this.bedGain) * (1 - Math.exp(-dt / tau));
    const mixTarget = clamp01((deg - BED_MIX_FLOOR_DEG) / BED_MIX_SPAN_DEG);
    this.bedMix += (mixTarget - this.bedMix) * (1 - Math.exp(-dt / 0.12));
    this.pushBed(t);
    return { low: this.bedPushedLow, high: this.bedPushedHigh, gain: this.bedGain };
  }

  /** The bed's current gains, for the lab's meters. */
  bedState(): { low: number; high: number; gain: number; mix: number } {
    return { low: Math.max(0, this.bedPushedLow), high: Math.max(0, this.bedPushedHigh), gain: this.bedGain, mix: this.bedMix };
  }

  // ── bookkeeping ───────────────────────────────────────────────────────────────────────────
  private record(id: SoundId, t: number, outcome: CueOutcome, against: SoundId | null, haptic: HapticShape | null): CueOutcome {
    if (this.keepLog) {
      this.decisions.push({ id, t, outcome, against, haptic });
      if (this.decisions.length > this.logLimit) this.decisions.splice(0, this.decisions.length - this.logLimit);
    }
    return outcome;
  }

  /** Record how long a dispatch took, in ms. The bench and the lab both read these. */
  noteDispatch(ms: number): void {
    this.stats.lastDispatchMs = ms;
    if (ms > this.stats.worstDispatchMs) this.stats.worstDispatchMs = ms;
  }
}

function emit(port: HapticPort, shape: HapticShape): void {
  if (shape === 'success' || shape === 'warning' || shape === 'error') port.notify(shape);
  else port.impact(shape);
}

/** 0..1, and 0 for anything that is not a number: this is the last gate before the port. */
function clamp01(v: number): number {
  return v > 0 ? (v > 1 ? 1 : v) : 0;
}

export { BED_HIGH, BED_LOW };
