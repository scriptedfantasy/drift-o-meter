/**
 * DriftPipeline — wires the engine modules into one object the app talks to.
 *
 *   sensor adapter ──MotionSample──▶ MountCalibrator ──VehicleMotionSample──▶ SlipEstimator ──SlipState──▶
 *   DriftDetector ──DriftEvent/live──▶ LiveScorer ──points/callouts──▶ HUD
 *   GPS ──GpsSample──▶ (calibrator, estimator, integrity)      TrackBuilder / IntegrityMonitor observe.
 *
 * The app only ever sees `LiveFrame`s (at motion rate, ~100 Hz) and the final `Session`.
 *
 * ── Real-time contract ────────────────────────────────────────────────────────────────────
 * `pushMotion` runs at 100 Hz on a phone, so it is O(1): every stage is a fixed amount of
 * arithmetic, the two growing stores are amortised O(1) appends, and nothing is scanned.
 * The only per-sample allocations are the returned frame (plus its `live` / `score` / `lap`
 * literals) and whatever the modules allocate for their own return values; the calibration
 * snapshot is refreshed at `calibrationHz` and the integrity literal is reused while the
 * verdict does not change.
 *
 * ── No NaN, ever ──────────────────────────────────────────────────────────────────────────
 * Sensor streams on real phones contain NaN, ±Infinity, repeated and out-of-order timestamps.
 * They are guarded at the boundary: a sample whose `t` is not finite or not newer than the
 * last one is DROPPED (counted in `diagnostics.droppedSamples`, the previous frame is
 * returned); non-finite vector components are replaced by 0 and counted in
 * `diagnostics.nanGuards`. Every numeric field of every frame — and of the finished Session —
 * is therefore finite, which also means the Session survives `JSON.stringify` unchanged
 * (`NaN` would serialise to `null`).
 *
 * ── Storage footprint ─────────────────────────────────────────────────────────────────────
 * A 20-minute session at 100 Hz is 120 000 samples, and V8 does not unbox double fields, so
 * holding that as objects costs ~300 bytes per `SlipState` and ~250 per `MotionSample`
 * (≈ 44 MB for the run, live the whole time). Both streams are therefore kept COLUMNAR:
 *   motion  decimated to `storeMotionHz` (50 Hz, as docs/ARCHITECTURE.md says), Float64 `t`
 *           + Float32 components (sensors carry 3–4 digits)         → 22 bytes/sample @100 Hz
 *   states  Float64 throughout, so values stay bit-exact            → 89 bytes/sample
 * Both are materialised into the object arrays the Session declares only when something asks
 * (`finish()`, or a read of `states`), and each store then drops its columns, so the two
 * representations never both hold the whole run. `states[i]` stays aligned with the detector's
 * sample indices, which `DriftEvent.sampleStart/End` index into. Measured on a 2-lap harbor
 * run: see the metrics table printed by pipeline.test.ts.
 *
 * ── Known inter-module friction (see the report) ──────────────────────────────────────────
 * The detector re-uses a drift id when it re-opens a pending drift (a linked drift) and after
 * a drift its twitch rule discards. `LiveScorer` buries an id once the drift ends (`deadId`),
 * so it would ignore everything that came back under that id. The pipeline therefore hands
 * the scorer a REMAPPED id whenever a live id reappears (counted in
 * `diagnostics.reopenedDrifts`); `drifts` and the final `Session` keep the detector's ids.
 */
import {
  type DriftEvent,
  type DriftPhase,
  type GpsSample,
  type Lap,
  type MotionSample,
  type MountCalibration,
  type Quaternion,
  type Session,
  type SessionScore,
  type SlipState,
  type StyleCallout,
  type TrackModel,
  type Vec3,
} from './types';
import { MountCalibrator, type MountOptions } from './mount';
import { SlipEstimator, type SlipMotionInput, type SlipOptions } from './slip';
import { DriftDetector, type DetectOptions, type LiveDrift } from './detect';
import { LiveScorer, scoreSession, type ScoreOptions, type SessionBreakdown } from './score';
import { TrackBuilder, type TrackOptions } from './track';
import { IntegrityMonitor, type GpsState, type IntegrityOptions, type MountState, type PhysicsState } from './integrity';

export interface LiveFrame {
  t: number;
  state: SlipState;
  phase: DriftPhase;
  /** The in-progress drift, if any. */
  live: {
    id: number;
    durationS: number;
    /** Signed β in radians. */
    angle: number;
    peakAngle: number;
    direction: 1 | -1;
    transitions: number;
  } | null;
  /** Drift that just completed on this frame, if any. */
  completed: DriftEvent | null;
  score: {
    total: number;
    delta: number;
    multiplier: number;
    chainPoints: number;
    chainActive: boolean;
    banked: boolean;
    lost: boolean;
    /** Points that banked on this frame (0 unless `banked`), and points a spin discarded (0 unless `lost`). */
    bankedPoints: number;
    lostPoints: number;
    /**
     * THE GATE THE SCORER RAN THIS SAMPLE UNDER — `LiveTick.counting`, straight through, not a
     * second derivation of it. False while the integrity monitor does not believe the slide
     * (loose mount, impossible physics, uncalibrated, too slow) or while the estimator's state
     * is invalid (no usable GPS course — past `courseTimeoutS` the slip angle stops tracking).
     *
     * IT GUARANTEES SOMETHING, and that is the whole point of it: on a frame with
     * `counting: false` the scorer paid nothing, so `score.total` cannot have gone UP and the
     * frame's callouts are all worth 0. `honesty.test.ts` asserts exactly that over the whole
     * looseness sweep. It used to be `plausible && state.valid` computed HERE — what the
     * scorer was told, not what it did — and the scorer meanwhile paid 4 925 points of callout
     * bonus on a run every frame of which said `counting: false`.
     *
     * A display that wants to say "NOT SCORING" must read THIS, never guess from `integrity`:
     * a HUD that inferred it from `gps: 'none'` announced "NO FIX — NOT SCORING" through
     * dropouts in which the engine was scoring normally, and correctly so — see
     * docs/ARCHITECTURE.md § "What only a phone can settle". Pair it with
     * `integrity.message` for the reason to show.
     *
     * It is NOT a fault light: it is false whenever nothing would be paid for anyway (parked,
     * crawling, between slides). What the engine will not stand behind is `integrity.believable`.
     */
    counting: boolean;
    /** Callouts fired on this frame. Each carries the points it actually paid — 0 while not counting. */
    callouts: StyleCallout[];
  };
  calibration: MountCalibration;
  integrity: {
    mount: 'rigid' | 'suspect' | 'loose';
    physics: 'ok' | 'implausible';
    gps: 'good' | 'poor' | 'none';
    message: string;
    /**
     * Whether anything derived from this instant may be BELIEVED — the phone is in its mount,
     * the readings are physically possible and the estimator's state is valid.
     *
     * Two different questions, and a display needs both: `score.counting` answers "is the
     * scorer paying right now", which is false at every red light; this answers "is the
     * reading worth showing in colour", which is false only when something is actually wrong.
     * It lives here so no screen re-derives it — a HUD that kept its own copy (`mount ===
     * 'loose' || physics === 'implausible' || !valid`) disagreed with the engine by
     * construction, and that disagreement is what hid a scorer paying for slides it did not
     * believe.
     */
    believable: boolean;
  };
  lap: { count: number; progress: number; completed: Lap | null };
}

export interface DriftPipelineOptions {
  /** Assumed GPS delivery latency (s). Seeds both the mount calibrator and the slip estimator. */
  gpsLatencyS?: number;
  /** Per-stage passthroughs, so the app (and the tuning tools) can reach every knob. */
  mount?: Partial<MountOptions>;
  slip?: Partial<SlipOptions>;
  detect?: Partial<DetectOptions>;
  score?: Partial<ScoreOptions>;
  track?: Partial<TrackOptions>;
  integrity?: Partial<IntegrityOptions>;
  /** Raw-motion storage rate for the Session, Hz (0 or Infinity = keep every sample). Default 50. */
  storeMotionHz?: number;
  /** Keep raw motion at all. False saves the whole motion store; the Session then has `motion: []`. */
  keepMotion?: boolean;
  /** How often the frame's `calibration` snapshot is refreshed, Hz. Default 20. */
  calibrationHz?: number;
  /** Session identity used by `finish()` (deterministic runs pass both). */
  id?: string;
  name?: string;
  /** Wall-clock start in ms since epoch; defaults to `Date.now()` at the first sample. */
  startedAt?: number;
}

export interface PipelineDiagnostics {
  /** Motion samples accepted / rejected (non-finite or non-increasing `t`). */
  samples: number;
  droppedSamples: number;
  /** GPS fixes accepted / rejected (non-finite `t`, or no usable position). */
  gpsSamples: number;
  droppedGps: number;
  /** Non-finite values repaired at a module boundary. */
  nanGuards: number;
  /** Raw motion samples actually kept (decimated to `storeMotionHz`). */
  storedMotion: number;
  /** True once `states` has been materialised as objects (see `DriftPipeline.states`). */
  statesMaterialised: boolean;
  /** Live drift ids the detector re-used and the pipeline had to remap for the scorer. */
  reopenedDrifts: number;
  calibrationQuality: number;
  calibrationForwardResolved: boolean;
  mount: MountState;
  physics: PhysicsState;
  gps: GpsState;
  /** Newest driver-facing integrity message. */
  integrityMessage: string;
  drifts: number;
  laps: number;
  /** Seconds covered so far. */
  elapsedS: number;
  /** Retained bytes, estimated from what is actually stored (see the header). */
  approxBytes: number;
}

export interface DriftPipelineApi {
  pushMotion(m: MotionSample): LiveFrame;
  pushGps(g: GpsSample): void;
  /** Mark the phone as stationary for calibration (user tapped "calibrate"). */
  markStationary(): void;
  /** Finish the run: closes open drifts, builds the track model, scores the session. */
  finish(meta?: Record<string, string | number | boolean>): Session;
  readonly frame: LiveFrame | null;
  readonly states: SlipState[];
  readonly drifts: DriftEvent[];
  readonly track: TrackModel | null;
  reset(): void;
}

const EMPTY_CALLOUTS: StyleCallout[] = [];

function fin(v: number, fallback = 0): number {
  // `+ 0` also normalises −0 to +0, which keeps the JSON round-trip byte-identical.
  return Number.isFinite(v) ? v + 0 : fallback;
}

/**
 * Columnar store for the raw motion stream: t in Float64 (timestamps need the precision),
 * the nine sensor components in Float32 (phone sensors carry 3–4 significant digits).
 * Attitude is stored only if the platform reports it. Grows geometrically; materialised
 * into `MotionSample[]` once, in `finish()`.
 */
class MotionStore {
  private cap = 0;
  private n = 0;
  private t = new Float64Array(0);
  private v = new Float32Array(0);
  private q: Float32Array | null = null;

  get length(): number {
    return this.n;
  }

  /** Retained bytes (typed arrays only — that is the whole point of this class). */
  get bytes(): number {
    return this.t.byteLength + this.v.byteLength + (this.q ? this.q.byteLength : 0);
  }

  clear(): void {
    this.cap = 0;
    this.n = 0;
    this.t = new Float64Array(0);
    this.v = new Float32Array(0);
    this.q = null;
  }

  push(t: number, a: Vec3, g: Vec3, r: Vec3, att: Quaternion | undefined): void {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    const k = i * 9;
    this.t[i] = t;
    const v = this.v;
    v[k] = a.x;
    v[k + 1] = a.y;
    v[k + 2] = a.z;
    v[k + 3] = g.x;
    v[k + 4] = g.y;
    v[k + 5] = g.z;
    v[k + 6] = r.x;
    v[k + 7] = r.y;
    v[k + 8] = r.z;
    if (att) {
      if (!this.q) this.q = new Float32Array(this.cap * 4);
      const j = i * 4;
      this.q[j] = att.w;
      this.q[j + 1] = att.x;
      this.q[j + 2] = att.y;
      this.q[j + 3] = att.z;
    }
  }

  toArray(): MotionSample[] {
    const out: MotionSample[] = new Array(this.n);
    const v = this.v;
    const q = this.q;
    for (let i = 0; i < this.n; i++) {
      const k = i * 9;
      const s: MotionSample = {
        t: this.t[i],
        accel: { x: v[k] + 0, y: v[k + 1] + 0, z: v[k + 2] + 0 },
        gravity: { x: v[k + 3] + 0, y: v[k + 4] + 0, z: v[k + 5] + 0 },
        rotationRate: { x: v[k + 6] + 0, y: v[k + 7] + 0, z: v[k + 8] + 0 },
      };
      if (q) {
        const j = i * 4;
        s.attitude = { w: q[j] + 0, x: q[j + 1] + 0, y: q[j + 2] + 0, z: q[j + 3] + 0 };
      }
      out[i] = s;
    }
    return out;
  }

  private grow(): void {
    const cap = this.cap === 0 ? 4096 : this.cap * 2;
    const t = new Float64Array(cap);
    t.set(this.t);
    const v = new Float32Array(cap * 9);
    v.set(this.v);
    this.t = t;
    this.v = v;
    if (this.q) {
      const q = new Float32Array(cap * 4);
      q.set(this.q);
      this.q = q;
    }
    this.cap = cap;
  }
}

/**
 * Columnar store for the 100 Hz estimator output.
 *
 * V8 does not unbox double fields, so a 12-field `SlipState` costs ~300 bytes (object +
 * one HeapNumber per field) — 36 MB for a 20-minute session, all of it live for the whole
 * run. The columns cost 89 bytes per sample instead, and the state objects the estimator
 * hands us die young (the cheap generation). `materialise()` builds the `SlipState[]` the
 * Session and the offline scorer need; it appends only what is new, so repeated reads stay
 * amortised O(1) per sample. Once the objects exist the columns are dropped and later
 * samples are stored as objects (`objectMode`), so the two representations never both hold
 * the whole run.
 */
class StateStore {
  private cap = 0;
  private n = 0;
  private t = new Float64Array(0);
  private v = new Float64Array(0);
  private ok = new Uint8Array(0);
  private objs: SlipState[] = [];
  private objectMode = false;

  get length(): number {
    return this.n;
  }

  get materialised(): boolean {
    return this.objectMode;
  }

  /** Timestamp of sample `i`, without materialising the whole history. */
  timeAt(i: number): number {
    if (i < 0 || i >= this.n) return NaN;
    return this.objectMode ? this.objs[i].t : this.t[i];
  }

  get bytes(): number {
    return this.t.byteLength + this.v.byteLength + this.ok.byteLength + this.objs.length * 304;
  }

  clear(): void {
    this.cap = 0;
    this.n = 0;
    this.t = new Float64Array(0);
    this.v = new Float64Array(0);
    this.ok = new Uint8Array(0);
    this.objs = [];
    this.objectMode = false;
  }

  push(s: SlipState): void {
    if (this.objectMode) {
      this.objs.push(s);
      this.n++;
      return;
    }
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    const k = i * 10;
    const v = this.v;
    this.t[i] = s.t;
    v[k] = s.beta;
    v[k + 1] = s.betaSigma;
    v[k + 2] = s.heading;
    v[k + 3] = s.course;
    v[k + 4] = s.speed;
    v[k + 5] = s.yawRate;
    v[k + 6] = s.ay;
    v[k + 7] = s.ax;
    v[k + 8] = s.x;
    v[k + 9] = s.y;
    this.ok[i] = s.valid ? 1 : 0;
  }

  /** The history as objects. Appends only the samples added since the last call. */
  materialise(): SlipState[] {
    if (this.objectMode) return this.objs;
    const v = this.v;
    for (let i = this.objs.length; i < this.n; i++) {
      const k = i * 10;
      this.objs.push({
        t: this.t[i],
        beta: v[k],
        betaSigma: v[k + 1],
        heading: v[k + 2],
        course: v[k + 3],
        speed: v[k + 4],
        yawRate: v[k + 5],
        ay: v[k + 6],
        ax: v[k + 7],
        x: v[k + 8],
        y: v[k + 9],
        valid: this.ok[i] === 1,
      });
    }
    // the objects now hold everything: drop the columns instead of paying for both
    this.objectMode = true;
    this.cap = 0;
    this.t = new Float64Array(0);
    this.v = new Float64Array(0);
    this.ok = new Uint8Array(0);
    return this.objs;
  }

  private grow(): void {
    const cap = this.cap === 0 ? 4096 : this.cap * 2;
    const t = new Float64Array(cap);
    t.set(this.t);
    const v = new Float64Array(cap * 10);
    v.set(this.v);
    const ok = new Uint8Array(cap);
    ok.set(this.ok);
    this.t = t;
    this.v = v;
    this.ok = ok;
    this.cap = cap;
  }
}

export class DriftPipeline implements DriftPipelineApi {
  readonly opts: DriftPipelineOptions;
  readonly calibrator: MountCalibrator;
  readonly estimator: SlipEstimator;
  readonly detector: DriftDetector;
  readonly scorer: LiveScorer;
  readonly trackBuilder: TrackBuilder;
  readonly integrity: IntegrityMonitor;

  private readonly stateStore = new StateStore();
  /** Newest state, for the NaN-guard fallbacks (the store does not keep objects). */
  private lastState: SlipState | null = null;
  private readonly _drifts: DriftEvent[] = [];
  private readonly _gps: GpsSample[] = [];
  private readonly motionStore = new MotionStore();

  private _frame: LiveFrame | null = null;
  private built: TrackModel | null = null;
  /**
   * Full session breakdown (components, chains, per-drift stats, integrity), populated by
   * `finish()`. THE accessor — there is no second name for it.
   */
  breakdown: SessionBreakdown | null = null;

  // ---- time
  private lastT = NaN;
  private firstT = NaN;
  private startedAt = 0;
  private lastStoredT = -Infinity;
  private sinceStored = 0;
  /** Smoothed input sample interval, s — drives the storage stride (0 until the second sample). */
  private dtEma = 0;
  private readonly storeIntervalS: number;

  // ---- cached snapshots (refreshed at a slow rate, reused in between: see the header)
  private cal: MountCalibration;
  private calT = -Infinity;
  private readonly calIntervalS: number;
  private integritySnapshot: LiveFrame['integrity'];

  // ---- the estimator input is one reused scratch object (no per-sample allocation)
  private readonly motionIn: SlipMotionInput = {
    t: 0,
    ax: 0,
    ay: 0,
    az: 0,
    yawRate: 0,
    rollRate: 0,
    pitchRate: 0,
    calibrationQuality: 0,
  };

  // ---- drift-id bookkeeping (see the header)
  private liveId: number | null = null;
  private readonly usedIds = new Set<number>();
  private readonly idRemap = new Map<number, number>();
  private nextSyntheticId = 1_000_001;

  // ---- diagnostics
  /** 1 per state sample where the integrity monitor believed the slide. Aligned with `states`. */
  private plausibleMask = new BitMask();
  private nSamples = 0;
  private nDropped = 0;
  private nGps = 0;
  private nDroppedGps = 0;
  private nGuards = 0;
  private nReopened = 0;

  constructor(opts: DriftPipelineOptions = {}) {
    this.opts = opts;
    const latency = opts.gpsLatencyS;
    this.calibrator = new MountCalibrator({ ...(latency !== undefined ? { gpsLatency: latency } : {}), ...opts.mount });
    this.estimator = new SlipEstimator({ ...(latency !== undefined ? { gpsLatencyS: latency } : {}), ...opts.slip });
    this.detector = new DriftDetector(opts.detect);
    this.scorer = new LiveScorer(opts.score);
    this.trackBuilder = new TrackBuilder(opts.track);
    this.integrity = new IntegrityMonitor(opts.integrity);
    const hz = opts.storeMotionHz ?? 50;
    this.storeIntervalS = hz > 0 && Number.isFinite(hz) ? 1 / hz : 0;
    const calHz = opts.calibrationHz ?? 20;
    this.calIntervalS = calHz > 0 && Number.isFinite(calHz) ? 1 / calHz : 0;
    this.cal = this.calibrator.calibration;
    this.integritySnapshot = { mount: 'rigid', physics: 'ok', gps: 'none', message: '', believable: true };
    this.integritySnapshot = this.readIntegrity();
  }

  // ═══════════════════════════════════════════════════════════════════ inputs

  pushMotion(m: MotionSample): LiveFrame {
    const t = m.t;
    if (!Number.isFinite(t) || (Number.isFinite(this.lastT) && t <= this.lastT)) {
      // unusable or out-of-order timestamp: nothing downstream could place it in time
      this.nDropped++;
      return this._frame ?? this.blankFrame();
    }
    if (!Number.isFinite(this.firstT)) {
      this.firstT = t;
      if (!this.startedAt) this.startedAt = this.opts.startedAt ?? Date.now();
    }
    const dt = Number.isFinite(this.lastT) ? t - this.lastT : 0;
    if (dt > 0 && dt < 1) this.dtEma = this.dtEma > 0 ? this.dtEma + (dt - this.dtEma) * 0.05 : dt;
    this.lastT = t;
    this.nSamples++;

    // ---- 1. guard the raw vectors, then phone frame → vehicle frame
    const raw = this.guardMotion(m, t);
    const vm = this.calibrator.push(raw);
    if (this.calIntervalS === 0 || t - this.calT >= this.calIntervalS) {
      this.cal = this.calibrator.calibration;
      this.calT = t;
      // the calibrator's own confidence is an independent integrity cue: an unresolved forward
      // axis means nothing downstream knows which way the car points
      this.integrity.pushCalibration(this.cal);
    }

    // ---- 2. vehicle motion → slip state
    //  `gravity` is deliberately NOT forwarded: the estimator's gravity branch reconstructs the
    //  specific force from OS user-accel + OS gravity, but the calibrator has ALREADY separated
    //  gravity with its own inertial up (ax = R·(f + g·û)), so adding the OS gravity back would
    //  re-inject exactly the gravity-lean error the calibrator removed.
    const mi = this.motionIn;
    mi.t = vm.t;
    mi.ax = fin(vm.ax);
    mi.ay = fin(vm.ay);
    mi.az = fin(vm.az);
    mi.yawRate = fin(vm.yawRate);
    mi.rollRate = fin(vm.rollRate);
    mi.pitchRate = fin(vm.pitchRate);
    mi.calibrationQuality = Number.isFinite(vm.calibrationQuality) ? vm.calibrationQuality : 0;
    if (mi.ax !== vm.ax || mi.ay !== vm.ay || mi.yawRate !== vm.yawRate) this.nGuards++;
    const state = this.guardState(this.estimator.pushMotion(mi), t);
    this.stateStore.push(state);
    this.lastState = state;

    // ---- 3. integrity watches the raw stream, the calibrated stream and the state
    //  (`mi` is `vm` with every component guarded, and the monitor does not retain it)
    this.integrity.pushMotion(raw, mi);
    this.integrity.pushState(state);

    // ---- 4. drift state machine → live phase + finished events
    const det = this.detector.push(state);
    const live = det.live;
    const scorerId = this.scorerIdFor(live);

    // ---- 5. live scoring
    //  The integrity monitor's verdict for THIS instant gates the points: while it does not
    //  believe the slide (phone loose in its mount, impossible physics, no GPS, too slow) the
    //  drift earns nothing. Nothing used to ask it, so hand-holding the phone scored 40 % MORE
    //  than the same drive with the phone bolted down.
    const plausible = this.integrity.plausible;
    this.plausibleMask.push(plausible);
    const tick = this.scorer.push(
      state,
      live
        ? {
            phase: det.phase,
            angle: fin(live.angle),
            peakAngle: fin(live.peakAngle),
            transitions: live.transitions | 0,
            durationS: fin(live.durationS),
            spin: live.spin,
            id: scorerId,
          }
        : null,
      plausible,
    );
    const callouts = tick.callouts.length ? this.guardCallouts(tick.callouts) : EMPTY_CALLOUTS;
    let completed = det.completed;
    if (completed) {
      completed = this.stampSuppressed(this.guardEvent(completed));
      this._drifts.push(completed);
      const id = this.idRemap.get(completed.id) ?? completed.id;
      this.idRemap.delete(completed.id);
      this.scorer.onDriftCompleted({ ...completed, id });
    }

    // ---- 6. laps (CLEAN LAP surfaces on the next frame, with the scorer's other pending callouts)
    //  The lap bonus is a PAYMENT, so it is handed the same two things every other payment in
    //  this engine is judged on — the state and the monitor's verdict for this instant — and it
    //  refuses itself when they say the scorer would not pay. It used to be given the lap alone,
    //  and a harbor run whose crossing fell inside a 0.23 s stretch the monitor refused drew
    //  `CLEAN LAP +1,425` on a frame stamped `counting: false`.
    const trackTick = this.trackBuilder.push(state);
    if (trackTick.lapCompleted) this.scorer.onLapCompleted(trackTick.lapCompleted, state, plausible);

    // ---- 7. keep the raw sample (decimated) for re-analysis
    //  Stride, not a time threshold: phone timestamps jitter by a few ms, and `t − last ≥ 20 ms`
    //  against a jittery 100 Hz stream skips a third sample and stores 38 Hz, not 50.
    if (this.opts.keepMotion !== false) {
      if (this.dtEma > 0) {
        const stride = Math.max(1, Math.min(1000, Math.round(this.storeIntervalS / this.dtEma)));
        if (++this.sinceStored >= stride || t - this.lastStoredT >= 1.5 * this.storeIntervalS) {
          this.sinceStored = 0;
          this.lastStoredT = t;
          this.motionStore.push(t, raw.accel, raw.gravity, raw.rotationRate, raw.attitude);
        }
      } else {
        this.lastStoredT = t;
        this.motionStore.push(t, raw.accel, raw.gravity, raw.rotationRate, raw.attitude);
      }
    }

    // ---- 8. the frame the app renders
    const integrity = this.readIntegrity(state.valid);
    const frame: LiveFrame = {
      t,
      state,
      phase: det.phase,
      live: live
        ? {
            id: live.id,
            durationS: fin(live.durationS),
            // the detector's magnitude (filtered, so it does not flicker) with the state's sign
            angle: (state.beta < 0 ? -1 : 1) * fin(live.angle),
            peakAngle: fin(live.peakAngle),
            direction: live.direction,
            transitions: live.transitions | 0,
          }
        : null,
      completed,
      score: {
        total: fin(tick.total),
        delta: fin(tick.delta),
        multiplier: fin(tick.multiplier, 1),
        chainPoints: fin(tick.chainPoints),
        // exactly the scorer's own chainActive: it sets chainDrifts ≥ 1 with it and 0 without it
        chainActive: tick.chainDrifts > 0,
        banked: tick.banked,
        lost: tick.lost,
        bankedPoints: fin(tick.bankedPoints),
        lostPoints: fin(tick.lostPoints),
        // the scorer's own gate, straight through: the frame cannot claim to be counting while
        // the scorer refused to pay, nor the other way round
        counting: tick.counting,
        callouts,
      },
      calibration: this.cal,
      integrity,
      lap: {
        count: trackTick.lapCount,
        // NaN until a closed reference lap exists; the app gets 0 = "unknown", never NaN
        progress: Number.isFinite(trackTick.progress) ? trackTick.progress : 0,
        completed: trackTick.lapCompleted,
      },
    };
    this._frame = frame;
    return frame;
  }

  pushGps(g: GpsSample): void {
    if (!Number.isFinite(g.t) || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) {
      this.nDroppedGps++;
      return;
    }
    // `speed`/`course` are documented as "NaN or negative when unavailable": normalise NaN to −1
    // so the stored Session stays JSON-clean (NaN would serialise to null).
    const fix: GpsSample = {
      t: g.t + 0,
      lat: g.lat + 0,
      lon: g.lon + 0,
      speed: Number.isFinite(g.speed) ? g.speed + 0 : -1,
      course: Number.isFinite(g.course) ? g.course + 0 : -1,
      hAcc: Number.isFinite(g.hAcc) && g.hAcc > 0 ? g.hAcc + 0 : 999,
    };
    if (g.alt !== undefined && Number.isFinite(g.alt)) fix.alt = g.alt + 0;
    if (fix.speed !== g.speed || fix.course !== g.course || fix.hAcc !== g.hAcc) this.nGuards++;
    this.nGps++;
    this._gps.push(fix);
    this.calibrator.pushGps(fix);
    this.estimator.pushGps(fix);
    this.integrity.pushGps(fix);
    const origin = this.estimator.origin;
    if (origin) this.trackBuilder.setOrigin(origin.lat, origin.lon);
  }

  markStationary(): void {
    this.calibrator.markStationary();
    this.cal = this.calibrator.calibration;
    // before the first sample `lastT` is NaN, and a NaN deadline would freeze the refresh
    this.calT = Number.isFinite(this.lastT) ? this.lastT : -Infinity;
  }

  // ═══════════════════════════════════════════════════════════════════ outputs

  get frame(): LiveFrame | null {
    return this._frame;
  }

  get states(): SlipState[] {
    return this.stateStore.materialise();
  }

  get drifts(): DriftEvent[] {
    return this._drifts;
  }

  get gps(): GpsSample[] {
    return this._gps;
  }

  get track(): TrackModel | null {
    return this.built ?? this.trackBuilder.model;
  }

  get diagnostics(): PipelineDiagnostics {
    const s = this.integrity.state;
    return {
      samples: this.nSamples,
      droppedSamples: this.nDropped,
      gpsSamples: this.nGps,
      droppedGps: this.nDroppedGps,
      nanGuards: this.nGuards,
      storedMotion: this.motionStore.length,
      reopenedDrifts: this.nReopened,
      calibrationQuality: this.cal.quality,
      calibrationForwardResolved: this.cal.forwardResolved,
      mount: s.mount,
      physics: s.physics,
      gps: s.gps,
      integrityMessage: s.message,
      drifts: this._drifts.length,
      laps: this.trackBuilder.laps.length,
      elapsedS: Number.isFinite(this.firstT) ? this.lastT - this.firstT : 0,
      statesMaterialised: this.stateStore.materialised,
      approxBytes: this.motionStore.bytes + this.stateStore.bytes + this._gps.length * 96,
    };
  }

  finish(meta: Record<string, string | number | boolean> = {}): Session {
    const closing = this.detector.finish();
    if (closing) {
      const e = this.stampSuppressed(this.guardEvent(closing));
      this._drifts.push(e);
      const id = this.idRemap.get(e.id) ?? e.id;
      this.idRemap.delete(e.id);
      this.scorer.onDriftCompleted({ ...e, id });
    }
    const track = this.trackBuilder.build();
    this.built = track;
    const states = this.stateStore.materialise();
    const iState = this.integrity.state;
    const b = scoreSession(this._drifts, states, track, this.opts.score, {
      plausible: this.plausibleMask.toArray(states.length),
      integrity: { mount: iState.mount, physics: iState.physics, gps: iState.gps, message: iState.message },
    });
    this.breakdown = b;
    const score: SessionScore = {
      total: b.total,
      grade: b.grade,
      angle: b.angle,
      consistency: b.consistency,
      quality: b.quality,
      speed: b.speed,
      style: b.style,
      bestDriftId: b.bestDriftId,
      longestChainPoints: b.longestChainPoints,
      // ScoredDrift is a DriftScore plus per-drift stats the results screen wants; it is plain
      // JSON, so the on-disk format stays a superset of the declared one.
      perDrift: b.perDrift,
      trusted: b.integrity.scoreTrusted,
    };
    const startedAt = this.startedAt || this.opts.startedAt || Date.now();
    const durationS = Number.isFinite(this.firstT) ? fin(this.lastT - this.firstT) : 0;
    const diag = this.diagnostics;
    return {
      version: 1,
      id: this.opts.id ?? `session-${startedAt.toString(36)}`,
      name: this.opts.name ?? 'Session',
      startedAt,
      durationS,
      motion: this.motionStore.toArray(),
      gps: this._gps,
      states,
      drifts: this._drifts,
      score,
      track,
      integrity: b.integrity,
      calibration: this.calibrator.calibration,
      // the pipeline's own provenance first, the caller's keys last: an app that knows better
      // (the track id, the driver, the phone model) wins over anything derived here
      meta: {
        engine: 'pipeline',
        samples: diag.samples,
        droppedSamples: diag.droppedSamples,
        nanGuards: diag.nanGuards,
        motionHz: this.storeIntervalS > 0 ? Math.round(1 / this.storeIntervalS) : 0,
        gpsFixes: diag.gpsSamples,
        calibrationQuality: Math.round(diag.calibrationQuality * 1000) / 1000,
        forwardResolved: diag.calibrationForwardResolved,
        gpsLatencyS: Math.round(this.estimator.gpsLatency * 1000) / 1000,
        lapsDetected: this.trackBuilder.laps.length,
        driftTimeS: Math.round(b.driftTimeS * 100) / 100,
        spins: b.spins,
        transitions: b.transitions,
        cleanLaps: b.cleanLaps,
        combined: b.combined,
        steadiness: b.steadiness,
        crossLapConsistency: b.crossLapConsistency ?? -1,
        mount: diag.mount,
        physics: diag.physics,
        integrity: diag.integrityMessage,
        // The integrity BLOCK the score depends on. These belong on `Session` as one
        // `SessionIntegrity` object; types.ts is owned elsewhere, so they ride in `meta`
        // (string | number | boolean only) until the field exists. See the report.
        scoreTrusted: b.integrity.scoreTrusted,
        integrityImplausibleFraction: b.integrity.implausibleDriftFraction,
        integritySuppressedS: b.integrity.suppressedS,
        integrityVerdict: b.integrity.message,
        bestShare: b.bestShare,
        medianDriftPoints: b.medianDriftPoints,
        pointsPerDriftSecond: b.pointsPerDriftSecond,
        ...meta,
      },
    };
  }

  reset(): void {
    this.calibrator.reset();
    this.estimator.reset();
    this.detector.reset();
    this.scorer.reset();
    this.trackBuilder.reset();
    if (this.opts.track?.originLat !== undefined || this.opts.track?.originLon !== undefined) {
      this.trackBuilder.setOrigin(this.opts.track.originLat ?? 0, this.opts.track.originLon ?? 0);
    }
    this.integrity.reset();
    this.stateStore.clear();
    this.plausibleMask.clear();
    this.lastState = null;
    this._drifts.length = 0;
    this._gps.length = 0;
    this.motionStore.clear();
    this._frame = null;
    this.built = null;
    this.breakdown = null;
    this.lastT = NaN;
    this.firstT = NaN;
    this.startedAt = 0;
    this.lastStoredT = -Infinity;
    this.sinceStored = 0;
    this.dtEma = 0;
    this.cal = this.calibrator.calibration;
    this.calT = -Infinity;
    this.integritySnapshot = this.readIntegrity();
    this.liveId = null;
    this.usedIds.clear();
    this.idRemap.clear();
    this.nextSyntheticId = 1_000_001;
    this.nSamples = 0;
    this.nDropped = 0;
    this.nGps = 0;
    this.nDroppedGps = 0;
    this.nGuards = 0;
    this.nReopened = 0;
  }

  // ═══════════════════════════════════════════════════════════════════ internals

  /** Replace non-finite components with 0 (counted). Returns `m` itself when it is already clean. */
  private guardMotion(m: MotionSample, t: number): MotionSample {
    const a = m.accel;
    const g = m.gravity;
    const r = m.rotationRate;
    if (
      m.t === t &&
      Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z) &&
      Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.z) &&
      Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    ) {
      return m;
    }
    this.nGuards++;
    const out: MotionSample = {
      t,
      accel: { x: fin(a.x), y: fin(a.y), z: fin(a.z) },
      gravity: { x: fin(g.x), y: fin(g.y), z: fin(g.z) },
      rotationRate: { x: fin(r.x), y: fin(r.y), z: fin(r.z) },
    };
    if (m.attitude) out.attitude = m.attitude;
    return out;
  }

  /** Hard NaN guard on the estimator's output (counted). Returns `s` itself when it is clean. */
  private guardState(s: SlipState, t: number): SlipState {
    if (
      s.t === t &&
      Number.isFinite(s.beta) && Number.isFinite(s.betaSigma) && Number.isFinite(s.heading) &&
      Number.isFinite(s.course) && Number.isFinite(s.speed) && Number.isFinite(s.yawRate) &&
      Number.isFinite(s.ay) && Number.isFinite(s.ax) && Number.isFinite(s.x) && Number.isFinite(s.y)
    ) {
      return s;
    }
    this.nGuards++;
    const prev = this.lastState;
    return {
      t,
      beta: fin(s.beta),
      betaSigma: fin(s.betaSigma, 1),
      heading: fin(s.heading, prev ? prev.heading : 0),
      course: fin(s.course, prev ? prev.course : 0),
      speed: fin(s.speed),
      yawRate: fin(s.yawRate),
      ay: fin(s.ay),
      ax: fin(s.ax),
      x: fin(s.x, prev ? prev.x : 0),
      y: fin(s.y, prev ? prev.y : 0),
      valid: false,
    };
  }

  /** Hard NaN guard on a finished DriftEvent's numeric fields (rare path: once per drift). */
  private guardEvent(e: DriftEvent): DriftEvent {
    let clean = true;
    for (const k of EVENT_NUMS) if (!Number.isFinite(e[k])) clean = false;
    if (clean) return e;
    this.nGuards++;
    const out = { ...e };
    for (const k of EVENT_NUMS) out[k] = fin(e[k]);
    return out;
  }

  /**
   * Seconds of this drift the integrity monitor refused to believe, read off the per-sample
   * mask and written onto the event so it SURVIVES STORAGE. The mask itself is not part of a
   * stored `Session` — it is indexed by sample, so it could not survive decimation without
   * silently misaligning — and this number is what lets a re-score, and a results screen,
   * know that part of the slide did not count. Once per drift, not per sample.
   */
  private stampSuppressed(e: DriftEvent): DriftEvent {
    const store = this.stateStore;
    const n = store.length;
    if (n === 0) return e;
    const a = Math.max(0, Math.min(n - 1, e.sampleStart | 0));
    const b = Math.max(a, Math.min(n - 1, e.sampleEnd | 0));
    const maxDt = this.scorer.options.maxDtS;
    let suppressed = 0;
    for (let i = a + 1; i <= b; i++) {
      if (this.plausibleMask.get(i)) continue;
      const dt = store.timeAt(i) - store.timeAt(i - 1);
      if (dt > 0 && dt <= maxDt) suppressed += dt;
    }
    if (!(suppressed > 0)) return e.suppressedS === 0 ? e : { ...e, suppressedS: 0 };
    return { ...e, suppressedS: Math.round(suppressed * 1000) / 1000 };
  }

  /** Hard NaN guard on the callouts of one frame (rare path: a few per drift). */
  private guardCallouts(cs: StyleCallout[]): StyleCallout[] {
    for (const c of cs) {
      if (!Number.isFinite(c.t) || !Number.isFinite(c.points)) {
        this.nGuards++;
        c.t = fin(c.t, this.lastT);
        c.points = fin(c.points);
      }
    }
    return cs;
  }

  /**
   * Id the LiveScorer should see for the drift the detector is reporting live. Detector ids are
   * re-used (linked drifts re-open a pending drift; a twitch-discarded drift frees its id), and
   * the scorer permanently buries an id once that drift ends — so a re-used id is remapped.
   */
  private scorerIdFor(live: LiveDrift | null): number {
    if (!live) {
      this.liveId = null;
      return 0;
    }
    if (live.id !== this.liveId) {
      this.liveId = live.id;
      if (this.usedIds.has(live.id)) {
        this.nReopened++;
        this.idRemap.set(live.id, this.nextSyntheticId++);
      } else {
        this.usedIds.add(live.id);
      }
    }
    return this.idRemap.get(live.id) ?? live.id;
  }

  /** Integrity verdict for the frame; the literal is reused while nothing changes. */
  private readIntegrity(valid = true): LiveFrame['integrity'] {
    const s = this.integrity.state;
    // ONE place decides whether the reading may be believed (see `LiveFrame.integrity.believable`).
    // It deliberately omits the speed and fix-freshness gates that `driftPlausible` also applies:
    // a car stopped at a red light is not a fault, and a screen that greyed out for one would be
    // lying in the other direction.
    const believable = s.mount !== 'loose' && s.physics === 'ok' && valid;
    const prev = this.integritySnapshot;
    if (prev && prev.mount === s.mount && prev.physics === s.physics && prev.gps === s.gps && prev.message === s.message && prev.believable === believable) {
      return prev;
    }
    const next = { mount: s.mount, physics: s.physics, gps: s.gps, message: s.message, believable };
    this.integritySnapshot = next;
    return next;
  }

  /** A valid, all-zero frame for the pathological case of a dropped very first sample. */
  private blankFrame(): LiveFrame {
    const f = idleLiveFrame(0);
    f.calibration = this.cal;
    f.integrity = this.integritySnapshot;
    return f;
  }
}

/**
 * One bit per sample. A 120 000-sample run costs 15 KB here instead of 120 KB of booleans,
 * and `toArray` materialises the Uint8Array the offline scorer indexes with.
 */
class BitMask {
  private words = new Uint32Array(1024);
  private n = 0;
  push(v: boolean): void {
    const w = this.n >>> 5;
    if (w >= this.words.length) {
      const next = new Uint32Array(this.words.length * 2);
      next.set(this.words);
      this.words = next;
    }
    if (v) this.words[w] |= 1 << (this.n & 31);
    else this.words[w] &= ~(1 << (this.n & 31));
    this.n++;
  }
  clear(): void {
    this.words = new Uint32Array(1024);
    this.n = 0;
  }
  get length(): number {
    return this.n;
  }
  /** True when sample `i` was believed (samples past the end count as believed). */
  get(i: number): boolean {
    if (i < 0) return true;
    if (i >= this.n) return true;
    return ((this.words[i >>> 5] >>> (i & 31)) & 1) === 1;
  }
  /** Dense 0/1 bytes for the first `len` samples (missing tail = believed). */
  toArray(len = this.n): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = i < this.n ? (this.words[i >>> 5] >>> (i & 31)) & 1 : 1;
    return out;
  }
}

/**
 * A frame that claims nothing: what a display shows before the first sample arrives.
 *
 * Exported so nothing outside the engine hand-rolls a `LiveFrame` literal. Every field added to
 * the frame has to be answered here, and a consumer that built its own idle frame would other-
 * wise keep compiling with the new field missing — which is how a HUD ends up guessing at a
 * value the engine could have told it.
 */
export function idleLiveFrame(t = 0): LiveFrame {
  return {
    t,
    state: { t, beta: 0, betaSigma: 1, heading: 0, course: 0, speed: 0, yawRate: 0, ay: 0, ax: 0, x: 0, y: 0, valid: false },
    phase: 'idle',
    live: null,
    completed: null,
    score: {
      total: 0,
      delta: 0,
      multiplier: 1,
      chainPoints: 0,
      chainActive: false,
      banked: false,
      lost: false,
      bankedPoints: 0,
      lostPoints: 0,
      counting: false,
      callouts: EMPTY_CALLOUTS,
    },
    calibration: { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], quality: 0, forwardResolved: false, t: 0 },
    // nothing has arrived yet, so there is nothing to disbelieve: the state is simply not valid
    integrity: { mount: 'rigid', physics: 'ok', gps: 'none', message: 'Waiting for GPS', believable: false },
    lap: { count: 0, progress: 0, completed: null },
  };
}

type EventNumKey =
  | 'startT' | 'endT' | 'durationS' | 'peakAngle' | 'peakAngleT' | 'meanAngle' | 'angleStdDev'
  | 'transitions' | 'entrySpeed' | 'meanSpeed' | 'minSpeed' | 'distanceM' | 'peakYawRate'
  | 'peakLateralAccel' | 'sampleStart' | 'sampleEnd';

const EVENT_NUMS: EventNumKey[] = [
  'startT', 'endT', 'durationS', 'peakAngle', 'peakAngleT', 'meanAngle', 'angleStdDev',
  'transitions', 'entrySpeed', 'meanSpeed', 'minSpeed', 'distanceM', 'peakYawRate',
  'peakLateralAccel', 'sampleStart', 'sampleEnd',
];
