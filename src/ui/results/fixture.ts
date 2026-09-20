/**
 * Deterministic sessions for developing and verifying the results screen.
 *
 * The real screen renders a `Session` loaded from storage. Until the live pipeline writes
 * sessions, and for the screenshot harness afterwards, `/results/<anything>?fixture=<name>`
 * (or the id `fixture-<name>`) rebuilds one from the simulator: SAME simulator, SAME session
 * shape, and the numbers on screen come from the real scorer (`scoreSession`), never from
 * `sessionFromSimulation`'s placeholder score.
 *
 * Everything here is pure and seeded, so a given URL always produces the same pixels.
 */
import { DriftPipeline } from '../../engine/pipeline';
import { sessionFromSimulation } from '../../engine/replay/fixtures';
import { clamp, degToRad, radToDeg, type Session, type SlipState } from '../../engine/types';
import { simulateRun, type TrackId } from '../../sim';

export interface FixtureSpec {
  /** Named scenario (what the screenshot is about). */
  name: string;
  track: TrackId;
  seed: number;
  laps: number;
  /** Driver skill knobs handed to the simulator (0..1 nominal; > 1 = a hero lap). */
  aggression: number;
  consistency: number;
  /** Force this many of the biggest slides past the spin threshold (0 = none). */
  spins: number;
  /** Drive it on grip: |β| stays under 5°, so there is honestly nothing to detect. */
  noDrifts: boolean;
  /**
   * How badly the phone moves relative to the car: 0 rigid, 0.7 a rattling cradle, 1 hand-held.
   * Anything above 0 also turns on GPS dropouts and rough vibration, so the integrity notes have
   * something true to report. At 1 the pipeline's monitor refuses to trust the score at all.
   */
  looseness: number;
  /**
   * `sim` fills the session from simulator ground truth (fast, ~200 ms).
   * `pipeline` pushes the simulated sensors through the REAL engine pipeline — mount
   * calibration, slip estimator, detector, scorer — which is what the phone does, and takes
   * about a second.
   */
  source: 'sim' | 'pipeline';
  /** One-line, driver-facing description of what this scenario is. */
  blurb: string;
}

const BASE: Omit<FixtureSpec, 'name' | 'blurb'> = {
  source: 'sim',
  track: 'harbor',
  seed: 3,
  laps: 2,
  aggression: 0.85,
  consistency: 0.7,
  spins: 0,
  noDrifts: false,
  looseness: 0,
};

/**
 * The scenarios the harness shoots. The grade each one yields is whatever the scorer says today,
 * not what the fixture wishes for.
 *
 * The showcase scenarios run `source: 'pipeline'` on purpose. Ground truth replays the same lap
 * plan every lap, so cross-lap spreads come out at exactly 0.0 m and the screen would publish a
 * simulator artifact as the driver's repeatability. Through the real pipeline the estimator's
 * noise is in the numbers, which is what a phone would actually produce.
 */
export const FIXTURES: Record<string, FixtureSpec> = {
  /** S: a hero lap — huge held angles, repeatable corner after corner. */
  hero: { ...BASE, name: 'hero', source: 'pipeline', seed: 3, aggression: 1.3, consistency: 1, blurb: 'Best lap of the night' },
  /** A/B: the default, a good but human run. */
  good: { ...BASE, name: 'good', source: 'pipeline', seed: 7, aggression: 0.9, consistency: 0.8, blurb: 'Quick lap' },
  /** The bad night: no angle, no repeatability, and the rear let go three times. */
  sloppy: { ...BASE, name: 'sloppy', seed: 1, aggression: 0, consistency: 0, spins: 3, blurb: 'Bad night · lost it twice' },
  /** The chain-ending spin: the biggest slide goes past the spin threshold and takes its chain. */
  spin: { ...BASE, name: 'spin', seed: 4, aggression: 1.1, consistency: 0.75, spins: 1, blurb: 'Spun it · chain lost' },
  /** Nothing slid: a clean lap with no drift events at all. */
  clean: { ...BASE, name: 'clean', seed: 2, aggression: 0.2, consistency: 0.9, noDrifts: true, blurb: 'Clean lap · no slides' },
  /** Bad data: phone loose in the cradle, GPS dropping out — scored, but with warnings. */
  rough: { ...BASE, name: 'rough', source: 'pipeline', seed: 6, aggression: 0.9, consistency: 0.55, looseness: 0.2, blurb: 'Unsteady mount · poor GPS' },
  /** Worse: the phone was in someone's hand. The engine refuses to publish a score at all. */
  handheld: { ...BASE, name: 'handheld', source: 'pipeline', seed: 4, aggression: 0.9, consistency: 0.7, looseness: 1, blurb: 'Hand-held · not scored' },
  /** Point-to-point mountain road: no laps, so the lap table is correctly absent. */
  touge: { ...BASE, name: 'touge', track: 'touge', seed: 3, laps: 1, aggression: 1, consistency: 0.85, blurb: 'Touge run · one way' },
};

export const DEFAULT_FIXTURE = 'good';

function num(v: string | undefined, fallback: number, lo: number, hi: number, integer = false): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const c = clamp(n, lo, hi);
  return integer ? Math.round(c) : c;
}

function bool(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  const s = v.trim().toLowerCase();
  if (s === '' || s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return null;
}

/**
 * Decide whether this route should render a fixture, and which one.
 *
 *   /results/fixture-sloppy                     → the `sloppy` scenario
 *   /results/anything?fixture=spin              → the `spin` scenario
 *   /results/demo                               → the default scenario (the HUD's placeholder id)
 *   /results/anything?fixture=hero&seed=9&laps=3&agg=1.2&cons=0.4&spin=1&drifts=none
 *
 * Returns null when the id should be looked up in storage instead.
 */
export function resolveFixture(id: string | undefined, params: Record<string, string | undefined>): FixtureSpec | null {
  const raw = params.fixture ?? (id && id.startsWith('fixture-') ? id.slice('fixture-'.length) : id === 'fixture' || id === 'demo' ? DEFAULT_FIXTURE : undefined);
  if (raw === undefined) return null;
  const key = raw.trim().toLowerCase();
  const base = FIXTURES[key] ?? FIXTURES[DEFAULT_FIXTURE];
  const spinParam = params.spin === undefined ? null : Number.isFinite(Number(params.spin)) && params.spin.trim() !== '' ? Math.max(0, Math.min(8, Math.round(Number(params.spin)))) : bool(params.spin) === true ? 1 : 0;
  const noDrifts = params.drifts === 'none' || params.drifts === '0';
  const looseParam = params.loose === undefined ? null : Math.max(0, Math.min(1, Number(params.loose) || 0));
  const roughFlag = bool(params.rough);
  const track = params.track === 'touge' || params.track === 'harbor' ? params.track : base.track;
  const source = params.source === 'pipeline' ? 'pipeline' : params.source === 'sim' ? 'sim' : base.source;
  return {
    ...base,
    source,
    name: FIXTURES[key] ? base.name : key,
    track,
    seed: num(params.seed, base.seed, 0, 2 ** 31 - 1, true),
    laps: num(params.laps, base.laps, 1, 6, true),
    aggression: num(params.agg, base.aggression, 0, 2),
    consistency: num(params.cons, base.consistency, 0, 1),
    spins: spinParam === null ? base.spins : spinParam,
    noDrifts: noDrifts || base.noDrifts,
    looseness: looseParam !== null ? looseParam : roughFlag === null ? base.looseness : roughFlag ? 0.7 : 0,
  };
}

export function fixtureQuery(spec: FixtureSpec): string {
  const q = new URLSearchParams();
  q.set('fixture', spec.name);
  const base = FIXTURES[spec.name] ?? BASE;
  if (spec.track !== base.track) q.set('track', spec.track);
  if (spec.seed !== base.seed) q.set('seed', String(spec.seed));
  if (spec.laps !== base.laps) q.set('laps', String(spec.laps));
  if (spec.aggression !== base.aggression) q.set('agg', String(spec.aggression));
  if (spec.consistency !== base.consistency) q.set('cons', String(spec.consistency));
  if (spec.spins !== base.spins) q.set('spin', String(spec.spins));
  if (spec.noDrifts) q.set('drifts', 'none');
  if (spec.looseness !== base.looseness) q.set('loose', String(spec.looseness));
  if (spec.source !== base.source) q.set('source', spec.source);
  return q.toString();
}

/** Smooth 0→1 ramp. */
function smoothstep(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * After β has been rewritten, put the yaw rate back on the kinematic identity
 * β̇ ≈ a_y / v − r, so the trace stays a possible car rather than a drawing of one.
 */
function recomputeYaw(states: SlipState[], from: number, to: number): void {
  for (let i = from; i <= to; i++) {
    const s = states[i];
    const prev = states[Math.max(from, i - 1)];
    const next = states[Math.min(to, i + 1)];
    const dt = next.t - prev.t;
    const betaDot = dt > 1e-6 ? (next.beta - prev.beta) / dt : 0;
    states[i] = { ...s, yawRate: s.speed > 1 ? s.ay / s.speed - betaDot : s.yawRate };
  }
}

/**
 * Turn the run into a grip lap: the same line and speeds, but the rear never steps out — |β|
 * compressed to the few degrees of tyre slip a car actually carries when it is not sliding.
 * Nothing crosses the detector's 8° floor, so the session honestly has no drifts in it.
 */
function gripLap(session: Session): void {
  const ceiling = degToRad(4.2);
  const knee = degToRad(12);
  for (let i = 0; i < session.states.length; i++) {
    const s = session.states[i];
    const sign = s.beta >= 0 ? 1 : -1;
    session.states[i] = { ...s, beta: sign * ceiling * Math.tanh(Math.abs(s.beta) / knee) };
  }
  recomputeYaw(session.states, 0, session.states.length - 1);
  if (session.truth) {
    session.truth = session.truth.map((t, i) => ({ ...t, beta: session.states[i]?.beta ?? 0, drifting: false }));
  }
  session.drifts = [];
}

/**
 * Push one slide past the spin threshold, in the state trace itself rather than by setting a
 * flag: |β| ramps past 85° through the back half of the drift, the yaw rate follows from the
 * kinematic identity r = a_y/v − β̇, and the car scrubs speed like a real spin. The scorer then
 * finds the spin with its own rule and takes the chain's un-banked points away.
 */
function injectSpin(session: Session, skip: Set<number>): void {
  const candidates = session.drifts.filter((d) => !skip.has(d.id));
  if (candidates.length === 0) return;
  let target = candidates[0];
  for (const d of candidates) if (d.peakAngle > target.peakAngle) target = d;
  skip.add(target.id);
  const a = Math.max(0, Math.min(session.states.length - 1, target.sampleStart));
  const b = Math.max(a, Math.min(session.states.length - 1, target.sampleEnd));
  const t0 = session.states[a].t;
  const t1 = session.states[b].t;
  if (!(t1 > t0)) return;
  const spinPeak = degToRad(118);
  const startF = 0.5;
  const scaled: SlipState[] = [];
  for (let i = a; i <= b; i++) {
    const s = session.states[i];
    const f = (s.t - t0) / (t1 - t0);
    const k = smoothstep((f - startF) / (1 - startF));
    const sign = s.beta >= 0 ? 1 : -1;
    const mag = Math.abs(s.beta);
    const beta = sign * (mag + (spinPeak - mag) * k);
    const speed = s.speed * (1 - 0.38 * k);
    scaled.push({ ...s, beta, speed });
  }
  for (let j = 0; j < scaled.length; j++) session.states[a + j] = scaled[j];
  recomputeYaw(session.states, a, b);
  // the drift event has to agree with the trace it points at
  let peak = 0;
  let peakT = target.peakAngleT;
  let sum = 0;
  for (let i = a; i <= b; i++) {
    const v = Math.abs(session.states[i].beta);
    if (v > peak) {
      peak = v;
      peakT = session.states[i].t;
    }
    sum += v;
  }
  target.spin = true; // the trace says so; say it in the event too, which is what the scorer reads
  target.peakAngle = peak;
  target.peakAngleT = peakT;
  target.meanAngle = sum / Math.max(1, b - a + 1);
  target.minSpeed = Math.min(target.minSpeed, session.states[b].speed);
  // a car that has spun is stopped, not starting the next corner: drop anything that began
  // inside the spin, so the trace and the event list tell the same story
  const spinEndT = session.states[b].t;
  session.drifts = session.drifts.filter((d) => d === target || d.endT <= target.startT || d.startT > spinEndT + 0.4);
}

/**
 * The ground-truth fixture hard-codes a perfect calibration, which would be a lie for a run the
 * simulator was told to rattle. Only applied on the `sim` source: through the real pipeline the
 * mount calibrator produces its own number and nothing here may overwrite it.
 */
function degradeCalibration(session: Session): void {
  session.calibration = { ...session.calibration, quality: 0.41, forwardResolved: false };
}

const TRACK_TITLES: Record<TrackId, string> = {
  // These must match the simulator's own names in src/sim/track.ts; the app showed two
  // different names for the same track depending on which screen you were on.
  harbor: 'Harbor Circuit',
  touge: 'Mountain Pass',
};

/**
 * Feed the simulated sensors through the real `DriftPipeline`, exactly as the sensor source
 * does on the phone: mount calibration → slip estimator → detector → scorer. Slower than the
 * ground-truth fixture (about a second for two laps) and worth it when the point is to see the
 * screen render what the engine actually produces, estimator noise and all.
 */
function throughPipeline(run: ReturnType<typeof simulateRun>, spec: FixtureSpec, name: string): Session {
  const pipeline = new DriftPipeline({
    gpsLatencyS: 0.45,
    id: `fixture-${spec.name}`,
    name,
    startedAt: Date.UTC(2026, 8, 19, 21, 44) + spec.seed * 60_000,
  });
  const gps = run.gps.slice().sort((a, b) => a.t - b.t);
  let j = 0;
  for (const m of run.motion) {
    while (j < gps.length && gps[j].t <= m.t) pipeline.pushGps(gps[j++]);
    pipeline.pushMotion(m);
  }
  while (j < gps.length) pipeline.pushGps(gps[j++]);
  return pipeline.finish({ ...run.meta, trackId: run.trackId, source: 'simulation', engine: 'pipeline' });
}

/**
 * Build the fixture session. Deterministic: same spec → same session, every time, on every
 * platform. Takes 200–300 ms through the simulator, about a second through the real pipeline.
 */
export function buildFixtureSession(spec: FixtureSpec): Session {
  const run = simulateRun(spec.track, {
    seed: spec.seed,
    laps: spec.laps,
    aggression: spec.aggression,
    consistency: spec.consistency,
    looseness: spec.looseness,
    vibration: spec.looseness > 0 ? 2 : 1,
    gpsDropouts: spec.looseness > 0,
    mount: spec.looseness > 0 ? 'flat-console' : 'portrait-vent',
  });
  const name = `${TRACK_TITLES[spec.track]} · ${spec.blurb}`;
  const session = spec.source === 'pipeline' ? throughPipeline(run, spec, name) : sessionFromSimulation(run, { name });
  if (spec.noDrifts) gripLap(session);
  const spun = new Set<number>();
  for (let i = 0; i < spec.spins; i++) injectSpin(session, spun);
  if (spec.looseness > 0 && spec.source === 'sim') degradeCalibration(session);
  session.id = `fixture-${spec.name}`;
  session.startedAt = Date.UTC(2026, 8, 19, 21, 44) + spec.seed * 60_000;
  session.meta = {
    ...session.meta,
    fixture: spec.name,
    fixtureQuery: fixtureQuery(spec),
    track: TRACK_TITLES[spec.track],
    peakAngleDeg: Math.round(session.drifts.reduce((m, d) => Math.max(m, radToDeg(d.peakAngle)), 0)),
  };
  return session;
}
