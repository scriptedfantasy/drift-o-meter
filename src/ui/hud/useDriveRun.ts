/**
 * The drive controller: sensors → pipeline → HUD, and the run's lifecycle.
 *
 * ── Frame budget ──────────────────────────────────────────────────────────────────────────
 * `onMotion` runs ~100 times a second. It pushes the sample into the engine and then does only
 * arithmetic and shared-value writes (≈20 per sample) — no `setState`, no allocation beyond the
 * frame the pipeline already returns. React re-renders come from three places only:
 *   • a 10 Hz snapshot ticker, for values that are words rather than motion (phase, integrity,
 *     lap, rounded speed, drift count);
 *   • discrete events (callouts, BANKED / CHAIN LOST banners) — a few per minute, pushed the
 *     instant they fire so nothing feels late;
 *   • the run's own status changes.
 * Everything continuous (angle, needle, glow, odometer, g-ball, edge bloom, mini-map head) is a
 * shared value read by the UI thread; the Skia canvases and animated styles never re-render.
 */
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useReducedMotion, withSequence, withSpring, withTiming } from 'react-native-reanimated';

import { toneFor, type EventTone } from '../callouts';

// Re-exported so the callout components keep one import site for the run's own types.
export type { EventTone };
import type { LiveFrame } from '../../engine/pipeline';
import { G, radToDeg, type DriftPhase, type GpsSample, type Grade, type MotionSample, type Session } from '../../engine/types';
import {
  currentSearch,
  describeSensorError,
  loadSettings,
  newSessionId,
  saveSession,
  selectSensorSource,
  SensorSourceError,
  subscribeSettings,
  type SensorSource,
  type SourceSelection,
} from '../../platform';
import { parseHudParams, type HudParams } from './hudParams';
import { createHudPipeline, idleFrame, type DriftPipelineApi } from './hudPipeline';
import { SimPlayer } from './simPlayer';
import { resetSignals, type HudSignals } from './signals';
import { createTrail, pushTrail, resetTrail, type Trail } from './trail';

/**
 * There is no 'ready'. Opening the screen IS the arming step (docs/DESIGN.md, "the whole app is
 * four steps"): the run starts on mount, and anything the engine has not worked out yet — the
 * forward axis, the first GPS fix — is reported while it records.
 */
export type RunStatus = 'starting' | 'running' | 'held' | 'ended' | 'saving' | 'discarded' | 'error';


/** One entry of the callout stack. */
export interface HudEvent {
  key: number;
  label: string;
  points: number;
  tone: EventTone;
  /** Recording time it fired at — the stack expires by frame time, so a frozen frame keeps it. */
  t: number;
}

export interface HudBanner {
  key: number;
  kind: 'banked' | 'lost';
  points: number;
  t: number;
}

/** Everything the HUD renders as words rather than motion. Refreshed at ~10 Hz. */
export interface HudSnapshot {
  phase: DriftPhase;
  integrity: LiveFrame['integrity'];
  speedKmh: number;
  totalPoints: number;
  multiplier: number;
  chainPoints: number;
  chainActive: boolean;
  transitions: number;
  /**
   * Peak |β| of the drift in progress. Held as a running max HERE rather than read from the
   * detector: the detector only publishes a peak once the entry has closed, which made the
   * strip read lower than the numeral directly above it during entry.
   */
  peakDeg: number;
  /** Seconds the drift in progress has been running (0 when idle). */
  driftDurationS: number;
  /**
   * Biggest |β| of the RUN so far, in degrees. A running max of the same value the gauge shows,
   * kept here so the middle of the screen has something true to say between slides instead of
   * going empty (measured: 0.71 % of that band was lit on a captured idle frame).
   */
  runPeakDeg: number;
  elapsedS: number;
  lapCount: number;
  lapProgress: number;
  driftCount: number;
  valid: boolean;
  calibrationQuality: number;
  /** The mount calibrator has resolved which way the car points; before that no mount verdict means anything. */
  forwardResolved: boolean;
  /** A usable fix has been seen at least once — "no GPS yet" and "GPS lost" are different states. */
  gpsEverGood: boolean;
  /** 0..1: how much of the reading the engine stands behind (see `HudSignals.trust`). */
  trust: number;
  /**
   * The gate the SCORER ran under on this frame (`LiveFrame.score.counting`): false means it
   * paid nothing, guaranteed, not inferred. Never guessed from `integrity` — through a GPS
   * dropout the engine dead-reckons β and keeps paying, and a HUD that guessed from
   * `gps: 'none'` told the driver their points had stopped while the results screen banked them.
   *
   * Not the same question as `trust`: a car waiting at a red light is not counting and is
   * perfectly believable. `integrity.believable` is the one the grey-out reads.
   */
  counting: boolean;
  /** Trail points committed so far (bumps the mini-map's memo). */
  trailCount: number;
}

export interface RunError {
  title: string;
  body: string;
  /** True when trying again might work (permissions, storage). */
  retryable: boolean;
  /** The label for that retry — a storage failure is not an access request. */
  retryLabel: string;
  /** Set when the run FINISHED and only the save failed: the verdict is still in hand. */
  verdict: RunVerdict | null;
}

/** The run's own result, shown when a completed run cannot be written to storage. */
export interface RunVerdict {
  grade: Grade;
  points: number;
  drifts: number;
  peakDeg: number;
  durationS: number;
}

export interface DriveRun {
  status: RunStatus;
  error: RunError | null;
  /** `SIM · HARBOR · 2×` or `DEVICE · LIVE SENSORS`. */
  sourceLabel: string | null;
  sourceKind: 'device' | 'simulated' | null;
  snapshot: HudSnapshot;
  events: HudEvent[];
  banner: HudBanner | null;
  trail: Trail;
  params: HudParams;
  /** Retry after a failed start or a failed save. */
  retry(): void;
  /** Throw the run away and start a new one without leaving the display. */
  restart(): void;
  /** Leave without saving (used by the save-failed verdict and the discarded-run notice). */
  leave(): void;
  stop(): void;
}

const IDLE_SNAPSHOT: HudSnapshot = {
  phase: 'idle',
  integrity: { mount: 'rigid', physics: 'ok', gps: 'none', message: 'Waiting for GPS', believable: false },
  speedKmh: 0,
  totalPoints: 0,
  multiplier: 1,
  chainPoints: 0,
  chainActive: false,
  transitions: 0,
  peakDeg: 0,
  driftDurationS: 0,
  runPeakDeg: 0,
  elapsedS: 0,
  lapCount: 0,
  lapProgress: NaN,
  driftCount: 0,
  valid: false,
  calibrationQuality: 0,
  forwardResolved: false,
  gpsEverGood: false,
  trust: 0,
  counting: false,
  trailCount: 0,
};

/** How long a callout stays on the stack, in RECORDING seconds (so a frozen frame keeps it). */
export const CALLOUT_HOLD_S = 3.2;
export const BANNER_HOLD_S = 2.4;
const MAX_CALLOUTS = 3;
/** Minimum recording-time spacing between mini-map trail points. */
const TRAIL_INTERVAL_S = 0.12;
/** Chain-bar scale: points at which the bar is ~63 % full. */
const CHAIN_SCALE = 2500;
/** Below this top speed, with no drift found, the "run" was the walk to the car: 10 km/h. */
const WALKING_PACE_MPS = 2.8;

const ACTIVE_PHASES: ReadonlySet<DriftPhase> = new Set<DriftPhase>(['entry', 'drifting', 'transition']);


function errorFor(err: unknown): RunError {
  const code = err instanceof SensorSourceError ? err.code : null;
  switch (code) {
    case 'permission-denied':
      return { title: 'Motion access denied', body: 'Drift-O-Meter needs Motion & Fitness and Location to judge a run. Turn them on in Settings → Drift-O-Meter, then try again.', retryable: true, retryLabel: 'Allow access', verdict: null };
    case 'unsupported':
      return { title: 'No sensors here', body: 'This device has no usable gyroscope or GPS. Switch to the simulated source in Settings to see how a run is scored.', retryable: false, retryLabel: '', verdict: null };
    case 'services-disabled':
      return { title: 'Location is off', body: 'Turn Location Services on — without GPS there is no direction of travel, and without that there is no slip angle.', retryable: true, retryLabel: 'Allow access', verdict: null };
    case 'unavailable':
      return { title: 'Sensors unavailable', body: describeSensorError(err), retryable: true, retryLabel: 'Try again', verdict: null };
    default:
      return { title: 'Could not start the run', body: describeSensorError(err), retryable: true, retryLabel: 'Try again', verdict: null };
  }
}

export function useDriveRun(signals: HudSignals): DriveRun {
  useKeepAwake();
  const router = useRouter();

  const [params] = useState<HudParams>(() => parseHudParams(currentSearch()));

  const [status, setStatus] = useState<RunStatus>('starting');
  const [error, setError] = useState<RunError | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [sourceKind, setSourceKind] = useState<'device' | 'simulated' | null>(null);
  const [snapshot, setSnapshot] = useState<HudSnapshot>(IDLE_SNAPSHOT);
  const [events, setEvents] = useState<HudEvent[]>([]);
  const [banner, setBanner] = useState<HudBanner | null>(null);

  const pipelineRef = useRef<DriftPipelineApi | null>(null);
  const playerRef = useRef<SimPlayer | null>(null);
  const sourceRef = useRef<SensorSource | null>(null);
  const selectionRef = useRef<SourceSelection | null>(null);
  const frameRef = useRef<LiveFrame>(idleFrame());
  const [trail] = useState<Trail>(createTrail);
  const startedRef = useRef(false);
  const stoppingRef = useRef(false);
  const sessionIdRef = useRef<string>('');
  /** The finished session, kept so a failed save can be retried without re-scoring the run. */
  const sessionRef = useRef<Session | null>(null);

  // Hot-path scratch state (never triggers a render).
  const hot = useRef({
    t0: NaN,
    tLast: NaN,
    prevPhase: 'idle' as DriftPhase,
    intensity: 0,
    lastTrailT: -Infinity,
    eventKey: 1,
    displayTotal: 0,
    warping: false,
    maxSpeed: 0,
    peakDeg: 0,
    runPeakDeg: 0,
    driftId: -1,
    gpsEverGood: false,
    trust: 0,
  });

  const haptics = useRef({ enabled: false });
  const prefersReducedMotion = useReducedMotion();
  const reduceMotion = useRef(false);
  reduceMotion.current = prefersReducedMotion;

  const pushEvents = useCallback((next: HudEvent[], t: number) => {
    setEvents((prev) => [...next.slice().reverse(), ...prev].filter((e) => t - e.t <= CALLOUT_HOLD_S).slice(0, MAX_CALLOUTS));
  }, []);

  const fireHaptic = useCallback((kind: 'entry' | 'transition' | 'exit') => {
    if (!haptics.current.enabled || Platform.OS === 'web') return;
    const style = kind === 'entry' ? Haptics.ImpactFeedbackStyle.Heavy : kind === 'transition' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light;
    Haptics.impactAsync(style).catch(() => {});
  }, []);

  /** The 100 Hz path: engine push, shared-value writes, edge detection. No setState unless an event fired. */
  const applyFrame = useCallback(
    (f: LiveFrame) => {
      const h = hot.current;
      if (!Number.isFinite(h.t0)) h.t0 = f.t;
      const dt = Number.isFinite(h.tLast) ? Math.min(0.1, Math.max(0, f.t - h.tLast)) : 0.01;
      h.tLast = f.t;

      const betaDeg = radToDeg(f.state.beta);
      const abs = Math.abs(betaDeg);
      const active = ACTIVE_PHASES.has(f.phase);

      // Trust: what the engine is willing to stand behind. THE ENGINE'S OWN VERDICT — the HUD
      // used to re-derive it (`mount === 'loose' || physics === 'implausible' || !valid`) and so
      // kept a second copy that disagreed with `score.counting` by construction; two verdicts
      // for one question is how a scorer paying for slides it did not believe stayed hidden.
      // 0.65 is not a second opinion but a degree: the engine believes the reading and says the
      // input is degraded (shaking mount, weak fix, β dead-reckoned through a dropout).
      const integrity = params.integrity ?? f.integrity;
      if (integrity.gps === 'good') h.gpsEverGood = true;
      const degraded = integrity.mount === 'suspect' || integrity.gps === 'poor' || integrity.gps === 'none';
      h.trust = !integrity.believable ? 0 : degraded ? 0.65 : 1;

      // Running peak of the drift in progress (the detector publishes its own only after entry).
      if (f.live) {
        if (f.live.id !== h.driftId) {
          h.driftId = f.live.id;
          h.peakDeg = 0;
        }
        if (abs > h.peakDeg) h.peakDeg = abs;
        // the run's own best, and only from a slide the engine believes: a hand-held phone
        // must not leave a 68° trophy on the screen
        if (abs > h.runPeakDeg && integrity.believable) h.runPeakDeg = abs;
      } else {
        h.driftId = -1;
        h.peakDeg = 0;
      }

      signals.betaDeg.value = betaDeg;
      signals.absDeg.value = abs;
      if (abs > 3) signals.side.value = betaDeg >= 0 ? 1 : -1;
      signals.peakDeg.value = f.live ? h.peakDeg * f.live.direction : 0;
      signals.trust.value = h.trust;
      signals.speedKmh.value = f.state.speed * 3.6;
      signals.ayG.value = f.state.ay / G;
      signals.active.value = active ? 1 : 0;
      signals.total.value = f.score.total;
      // The odometer's own value: one exponential filter at sample rate. It converges during a
      // warp, tracks a fast climb with ~0.12 s of lag, and snaps once it is within half a point
      // so a parked score reads exactly.
      const dTotal = f.score.total - h.displayTotal;
      // Snap generously (25 points, or 0.2 % of a big score): while the score climbs the gap is
      // far wider than that, and the moment it plateaus the digits park on the exact figure
      // instead of hovering a fraction below it.
      const snapAt = Math.max(25, f.score.total * 0.002);
      // Snapping rounds: the engine's total is fractional (callout bonuses carry the multiplier),
      // and a settled odometer must sit on a whole digit, not 0.3 of the way past it.
      h.displayTotal = Math.abs(dTotal) < snapAt ? Math.round(f.score.total) : h.displayTotal + dTotal * (1 - Math.exp(-dt / 0.12));
      signals.totalDisplay.value = h.displayTotal;
      signals.chainPoints.value = f.score.chainPoints;
      signals.multiplier.value = f.score.multiplier;
      signals.chainRatio.value = 1 - Math.exp(-f.score.chainPoints / CHAIN_SCALE);
      signals.elapsedS.value = f.t - h.t0;
      signals.carX.value = f.state.x;
      signals.carY.value = f.state.y;
      signals.carHeading.value = f.state.heading;
      signals.valid.value = f.state.valid ? 1 : 0;
      if (f.state.speed > h.maxSpeed) h.maxSpeed = f.state.speed;

      // Glow intensity: blooms fast, fades slowly (design: entry 220 ms, exit 420 ms), and never
      // blooms at all for a slide the engine is not scoring.
      const target = active ? Math.min(1, Math.max(0, (abs - 6) / 44)) * h.trust : 0;
      const tau = target > h.intensity ? 0.09 : 0.24;
      h.intensity += (target - h.intensity) * (1 - Math.exp(-dt / tau));
      signals.intensity.value = h.intensity;

      // ── edges ──────────────────────────────────────────────────────────────────────
      // A warp (`?at=`) replays minutes of data in one synchronous burst. The STATE changes
      // (callouts land on the stack, the multiplier grows), but the impulses do not: firing a
      // flash and a haptic for every transition in the skipped minutes would leave the screen
      // mid-flash the instant it appears, and buzz the phone for drifts nobody drove.
      const quiet = h.warping;
      const phase = f.phase;
      const wasActive = ACTIVE_PHASES.has(h.prevPhase);
      if (active && !wasActive) {
        // Entry: the numeral punches to 1.08× and springs back.
        if (!reduceMotion.current && !quiet) {
          signals.punch.value = withSequence(withTiming(1, { duration: 70 }), withSpring(0, { damping: 11, stiffness: 150, mass: 0.6 }));
        }
        if (!quiet) fireHaptic('entry');
      } else if (!active && wasActive) {
        if (!quiet) fireHaptic('exit');
      }
      if (phase === 'transition' && h.prevPhase !== 'transition') {
        // Transition: 120 ms magenta flash, 100 ms 2 px shake. Reduce-motion keeps the state
        // change (the callout, the multiplier, the chevron) and drops both of these.
        if (!reduceMotion.current && !quiet) {
          signals.flash.value = withSequence(withTiming(1, { duration: 40 }), withTiming(0, { duration: 140 }));
          signals.shake.value = withSequence(
            withTiming(1, { duration: 24 }),
            withTiming(-0.8, { duration: 24 }),
            withTiming(0.5, { duration: 26 }),
            withTiming(0, { duration: 26 }),
          );
        }
        if (!quiet) fireHaptic('transition');
      }
      h.prevPhase = phase;

      // ── discrete events: rare, so they go straight to React ────────────────────────
      if (f.score.callouts.length > 0) {
        const next = f.score.callouts.map((c) => ({ key: h.eventKey++, label: c.label, points: c.points, tone: toneFor(c.kind), t: f.t }));
        pushEvents(next, f.t);
      }
      // The ENGINE's own figures (`LiveTick.bankedPoints` / `lostPoints`), not the previous
      // frame's chain total re-read a frame late: the two agree only because a bank can fire
      // only on an idle frame, which is a property of today's chain rules, not a guarantee.
      // A banner for nothing is not shown at all — a run the scorer never paid for has no
      // points to bank and none to lose, and "CHAIN LOST −965" over a score of 0 is a lie.
      if (f.score.banked && f.score.bankedPoints >= 1) setBanner({ key: h.eventKey++, kind: 'banked', points: Math.round(f.score.bankedPoints), t: f.t });
      else if (f.score.lost && f.score.lostPoints >= 1) setBanner({ key: h.eventKey++, kind: 'lost', points: Math.round(f.score.lostPoints), t: f.t });

      // ── mini-map trail ─────────────────────────────────────────────────────────────
      if (f.state.valid && f.t - h.lastTrailT >= TRAIL_INTERVAL_S) {
        h.lastTrailT = f.t;
        pushTrail(trail, f.state.x, f.state.y, active);
      }
    },
    [fireHaptic, params.integrity, pushEvents, signals, trail],
  );

  const onMotion = useCallback(
    (m: MotionSample) => {
      const pipe = pipelineRef.current;
      if (!pipe) return;
      const f = pipe.pushMotion(m);
      frameRef.current = f;
      applyFrame(f);
    },
    [applyFrame],
  );

  const onGps = useCallback((g: GpsSample) => {
    pipelineRef.current?.pushGps(g);
  }, []);

  const finishAndSave = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    playerRef.current?.stop();
    sourceRef.current?.stop();
    const pipe = pipelineRef.current;
    if (!pipe) {
      router.back();
      return;
    }
    setStatus('saving');
    try {
      const sel = selectionRef.current;
      const meta: Record<string, string | number | boolean> = { source: sel?.kind ?? 'device' };
      if (sel?.sim) {
        meta.track = sel.sim.params.track;
        meta.seed = sel.sim.params.seed;
        meta.rate = sel.sim.params.rate;
      }
      const session = sessionRef.current ?? pipe.finish(meta);
      sessionRef.current = session;
      // A run that never got above walking pace and never found a drift is the walk to the car,
      // not a session. Say so and go back rather than filing it — and rather than gating the
      // start on a tap.
      if (hot.current.maxSpeed < WALKING_PACE_MPS && session.drifts.length === 0) {
        setStatus('discarded');
        return;
      }
      const entry = await saveSession(session);
      router.replace({ pathname: '/results/[id]', params: { id: entry.id } });
    } catch (err) {
      stoppingRef.current = false;
      setStatus('error');
      // The run is FINISHED — only the write failed. Hand the driver the verdict rather than
      // stranding them on the display with a completed run trapped behind a dialog.
      const s = sessionRef.current;
      setError({
        title: 'Could not save the run',
        body: `${err instanceof Error ? err.message : String(err)} The run itself is intact — free some space and try again, or take the verdict as it stands.`,
        retryable: true,
        retryLabel: 'Try again',
        verdict: s
          ? {
              grade: s.score.grade,
              points: s.score.total,
              drifts: s.drifts.length,
              peakDeg: s.drifts.reduce((m, d) => Math.max(m, radToDeg(d.peakAngle)), 0),
              durationS: s.durationS,
            }
          : null,
      });
    }
  }, [router]);

  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setError(null);
    setStatus('starting');
    (async () => {
      try {
        const selection = await selectSensorSource({ loop: false, onEnd: () => void finishAndSave() });
        selectionRef.current = selection;
        setSourceLabel(selection.label);
        setSourceKind(selection.kind);
        sessionIdRef.current = newSessionId();
        const name = selection.sim ? `${title(selection.sim.params.track)} run` : 'Night run';
        pipelineRef.current = createHudPipeline({ id: sessionIdRef.current, name });
        resetSignals(signals);
        resetTrail(trail);
        hot.current = {
          t0: NaN,
          tLast: NaN,
          prevPhase: 'idle',
          intensity: 0,
          lastTrailT: -Infinity,
          eventKey: hot.current.eventKey,
          displayTotal: 0,
          warping: false,
          maxSpeed: 0,
          peakDeg: 0,
          runPeakDeg: 0,
          driftId: -1,
          gpsEverGood: false,
          trust: 0,
        };

        if (selection.sim) {
          const player = new SimPlayer(selection.sim.run, {
            rate: selection.sim.params.rate,
            onMotion,
            onGps,
            onEnd: () => void finishAndSave(),
          });
          playerRef.current = player;
          if (Number.isFinite(params.at)) {
            hot.current.warping = true;
            try {
              player.warpTo(params.at);
            } finally {
              hot.current.warping = false;
            }
            // The odometer's filter has no more samples to converge on after a warp that ends in
            // a freeze, so land it on the figure the engine actually reports.
            hot.current.displayTotal = Math.round(frameRef.current.score.total);
            signals.totalDisplay.value = hot.current.displayTotal;
          }
          if (params.hold) {
            setStatus('held');
          } else {
            player.start();
            setStatus('running');
          }
        } else {
          await selection.source.start({ onMotion, onGps });
          sourceRef.current = selection.source;
          setStatus('running');
        }
      } catch (err) {
        startedRef.current = false;
        console.warn('[hud] run failed to start', err);
        setError(errorFor(err));
        setStatus('error');
      }
    })();
  }, [finishAndSave, onGps, onMotion, params.at, params.hold, signals, trail]);

  const stop = useCallback(() => {
    void finishAndSave();
  }, [finishAndSave]);

  /** Retry whatever failed: a denied permission before the run, or the write after it. */
  const retry = useCallback(() => {
    setError(null);
    if (sessionRef.current) {
      void finishAndSave();
      return;
    }
    startedRef.current = false;
    start();
  }, [finishAndSave, start]);

  /**
   * Start a fresh run on this screen. DRIVE AGAIN after a discarded run is the four-step flow
   * (docs/DESIGN.md): the driver is already on the drive display with the phone mounted, and
   * sending them to the garage to press DRIVE is a detour out of step 3 and back into step 2.
   */
  const restart = useCallback(() => {
    sessionRef.current = null;
    stoppingRef.current = false;
    startedRef.current = false;
    setError(null);
    start();
  }, [start]);

  const leave = useCallback(() => {
    router.replace('/');
  }, [router]);

  // Haptics follow the setting; read once and on change, never inside the hot path.
  useEffect(() => {
    let alive = true;
    void loadSettings().then((s) => {
      if (alive) haptics.current.enabled = s.haptics;
    });
    const unsubscribe = subscribeSettings((s) => {
      haptics.current.enabled = s.haptics;
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  // Opening the screen starts the run. No GO button, no countdown: the driver already decided
  // when they tapped DRIVE. (`?at=` still seeks and `?hold=1` still freezes, for the harness.)
  useEffect(() => {
    start();
  }, [start]);

  // The ~10 Hz snapshot: words, not motion.
  useEffect(() => {
    if (status !== 'running' && status !== 'held') return;
    const publish = () => {
      const f = frameRef.current;
      const h = hot.current;
      const t0 = Number.isFinite(h.t0) ? h.t0 : f.t;
      setSnapshot({
        phase: f.phase,
        integrity: params.integrity ?? f.integrity,
        speedKmh: f.state.speed * 3.6,
        totalPoints: f.score.total,
        multiplier: f.score.multiplier,
        chainPoints: f.score.chainPoints,
        chainActive: f.score.chainActive,
        transitions: f.live?.transitions ?? 0,
        peakDeg: h.peakDeg,
        driftDurationS: f.live?.durationS ?? 0,
        runPeakDeg: h.runPeakDeg,
        elapsedS: f.t - t0,
        lapCount: f.lap.count,
        lapProgress: f.lap.progress,
        driftCount: pipelineRef.current?.drifts.length ?? 0,
        valid: f.state.valid,
        calibrationQuality: f.calibration.quality,
        forwardResolved: f.calibration.forwardResolved,
        gpsEverGood: h.gpsEverGood,
        trust: h.trust,
        counting: f.score.counting,
        trailCount: trail.n,
      });
      setEvents((prev) => (prev.length === 0 ? prev : prev.filter((e) => f.t - e.t <= CALLOUT_HOLD_S)));
      setBanner((prev) => (prev && f.t - prev.t > BANNER_HOLD_S ? null : prev));
    };
    publish();
    if (status === 'held') return; // frozen: one publish is the whole story
    const id = setInterval(publish, 100);
    return () => clearInterval(id);
  }, [params.integrity, status, trail]);

  // Tear down with the screen.
  useEffect(
    () => () => {
      playerRef.current?.stop();
      sourceRef.current?.stop();
    },
    [],
  );

  return {
    status,
    error,
    sourceLabel,
    sourceKind,
    snapshot,
    events,
    banner,
    trail,
    params,
    stop,
    retry,
    restart,
    leave,
  };
}

function title(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
