import { describe, expect, it } from 'vitest';
import { simulateRun, type TrackId } from '../../sim';
import { type DriftEvent, type DriftPhase, type SlipState, type TruthSample, degToRad, radToDeg } from '../types';
import { DriftDetector, type DetectorOutput } from './index';
import { aggregate, evaluateRun, formatMetricsTable, noisyStream, truthEvents, type RunMetrics } from './eval';

// ---------- helpers ----------

function runDetector(states: SlipState[], det = new DriftDetector()): { events: DriftEvent[]; outputs: DetectorOutput[]; det: DriftDetector } {
  const outputs: DetectorOutput[] = [];
  for (const s of states) outputs.push(det.push(s));
  det.finish();
  return { events: det.events, outputs, det };
}

interface SynthSample {
  beta: number;
  speed?: number;
  yawRate?: number;
  ay?: number;
  valid?: boolean;
}

/** 100 Hz synthetic stream from a piecewise description. Units: radians, m/s. */
function synth(durationS: number, f: (t: number) => SynthSample, rate = 100): SlipState[] {
  const out: SlipState[] = [];
  const n = Math.round(durationS * rate);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const s = f(t);
    const speed = s.speed ?? 15;
    out.push({
      t,
      beta: s.beta,
      betaSigma: 0.01,
      heading: -s.beta,
      course: 0,
      speed,
      yawRate: s.yawRate ?? (Math.abs(s.beta) > 0.02 ? 0.4 : 0),
      ay: s.ay ?? (Math.abs(s.beta) > 0.02 ? 4 : 0),
      ax: 0,
      x: speed * t,
      y: 0,
      valid: s.valid ?? speed > 2,
    });
  }
  return out;
}

/** Trapezoid |β| profile: ramp up over `ramp`, hold `hold`, ramp down over `ramp`, starting at t0. */
function trapezoid(t: number, t0: number, ramp: number, hold: number, amp: number): number {
  const u = t - t0;
  if (u < 0) return 0;
  if (u < ramp) return (amp * u) / ramp;
  if (u < ramp + hold) return amp;
  if (u < 2 * ramp + hold) return amp * (1 - (u - ramp - hold) / ramp);
  return 0;
}

/**
 * True when the scripted driver opened this initiation with a Scandinavian-flick FEINT: |β|
 * leaves straight running (2.5°) briefly on one side, stays small, and reverses into the slide.
 */
function startsWithFeint(truth: TruthSample[], startT: number, level = degToRad(2.5)): boolean {
  let i = truth.findIndex((x) => x.t >= startT);
  if (i < 0) return false;
  while (i < truth.length && Math.abs(truth[i].beta) < level && truth[i].t < startT + 2) i++;
  if (i >= truth.length || truth[i].t >= startT + 2) return false;
  const sign = Math.sign(truth[i].beta);
  const up = truth[i].t;
  let peak = 0;
  let j = i;
  while (j < truth.length && Math.abs(truth[j].beta) >= level * 0.8 && Math.sign(truth[j].beta) === sign) {
    peak = Math.max(peak, Math.abs(truth[j].beta));
    j++;
  }
  const down = truth[j - 1].t;
  if (peak > degToRad(9) || down - up > 0.6) return false; // a real slide, not a flick
  let k = j;
  while (k < truth.length && (Math.abs(truth[k].beta) < level || Math.sign(truth[k].beta) === sign) && truth[k].t < down + 0.6) k++;
  return k < truth.length && truth[k].t < down + 0.6;
}

const phasesOf = (outputs: DetectorOutput[]) => new Set<DriftPhase>(outputs.map((o) => o.phase));
const phaseAt = (outputs: DetectorOutput[], t: number) => outputs[Math.round(t * 100)].phase;

// ---------- simulator-based metrics ----------

describe('DriftDetector on simulated runs (noisy estimator)', () => {
  const scenarios: Array<{ name: string; track: TrackId; opts: Parameters<typeof simulateRun>[1] }> = [
    { name: 'harbor s1 L2', track: 'harbor', opts: { seed: 1, laps: 2 } },
    { name: 'harbor s2 L2', track: 'harbor', opts: { seed: 2, laps: 2 } },
    { name: 'harbor s3 L2', track: 'harbor', opts: { seed: 3, laps: 2 } },
    { name: 'harbor s4 L2', track: 'harbor', opts: { seed: 4, laps: 2 } },
    { name: 'touge s1', track: 'touge', opts: { seed: 1 } },
    { name: 'touge s2', track: 'touge', opts: { seed: 2 } },
    { name: 'harbor s5 sloppy c=0.2', track: 'harbor', opts: { seed: 5, laps: 2, consistency: 0.2 } },
  ];
  const DELAY = 0.08;
  const rows: RunMetrics[] = [];
  const perRun = new Map<string, { events: DriftEvent[]; states: SlipState[]; outputs: DetectorOutput[] }>();
  let feintStarts = 0;
  for (const sc of scenarios) {
    const run = simulateRun(sc.track, sc.opts);
    const states = noisyStream(run.truth, { seed: (sc.opts?.seed ?? 1) * 11 + (sc.track === 'touge' ? 100 : 0), delayS: DELAY });
    const truth = truthEvents(run.truth);
    const { events, outputs } = runDetector(states);
    perRun.set(sc.name, { events, states, outputs });
    rows.push(evaluateRun(sc.name, events, truth));
    feintStarts += truth.filter((e) => startsWithFeint(run.truth, e.startT)).length;
  }
  const all = aggregate(rows);

  it('prints the metrics table', () => {
    const table = formatMetricsTable([...rows, all]);
    const lines = [
      `\nDrift detector vs simulator truth (β noise 1.5° 1σ, ${DELAY * 1000} ms lag, 300 ms valid:false gaps every ~4 s; IoU ≥ 0.5)`,
      table,
      `entry latency minus injected lag: mean ${((all.entryMean - DELAY) * 1000).toFixed(0)} ms`,
      `feint-started initiations in these runs: ${feintStarts}/${all.truthN} (drift backdated to the flick)`,
    ];
    for (const r of rows) {
      for (const u of r.unmatchedTruth) lines.push(`  MISSED  ${r.name}: truth [${u.startT.toFixed(2)}..${u.endT.toFixed(2)}] peak ${radToDeg(u.peak).toFixed(1)}°`);
      for (const u of r.unmatchedEvents) lines.push(`  SPURIOUS ${r.name}: event [${u.startT.toFixed(2)}..${u.endT.toFixed(2)}] peak ${radToDeg(u.peakAngle).toFixed(1)}°`);
      for (const p of r.pairs)
        if (p.event.transitions !== p.truth.transitions)
          lines.push(`  TRANS   ${r.name}: event [${p.event.startT.toFixed(2)}..${p.event.endT.toFixed(2)}] got ${p.event.transitions} truth ${p.truth.transitions}`);
    }
    // vitest 5 defaults to `silent: 'passed-only'`, which hides console.log from passing tests;
    // a direct stdout write is not captured, so the table is visible under the default config.
    process.stdout.write(`${lines.join('\n')}\n`);
    expect(rows.length).toBe(scenarios.length);
  });

  it('precision ≥ 0.9 and recall ≥ 0.9 overall', () => {
    expect(all.truthN).toBeGreaterThanOrEqual(30);
    expect(all.precision).toBeGreaterThanOrEqual(0.9);
    expect(all.recall).toBeGreaterThanOrEqual(0.9);
    for (const r of rows) {
      // small runs (3-6 events): one boundary disagreement with the truth segmentation is tolerated
      expect(r.precision, r.name).toBeGreaterThanOrEqual(0.7);
      expect(r.recall, r.name).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('mean entry latency < 300 ms after the injected lag; exit latency bounded', () => {
    expect(all.entryMean - DELAY).toBeLessThan(0.3);
    expect(all.entryMean).toBeGreaterThan(0); // never fires before the slide
    expect(all.entryMax).toBeLessThan(1.0);
    const exits = all.pairs.map((p) => Math.abs(p.event.endT - p.truth.endT)).sort((a, b) => a - b);
    const q = (f: number) => exits[Math.min(exits.length - 1, Math.floor(f * exits.length))];
    expect(q(0.5)).toBeLessThan(0.4); // median
    expect(q(0.9)).toBeLessThan(1.0); // p90; the max can be a whole corner when a 1.0 s gap is judged differently
  });

  it('transition counts are exact on ≥ 90 % of matched events', () => {
    expect(all.transitionsExact).toBeGreaterThanOrEqual(0.9);
    expect(all.pairs.some((p) => p.truth.transitions > 0)).toBe(true);
  });

  it('peak angle is within 2° on average and never wildly off', () => {
    expect(radToDeg(all.peakErrMean)).toBeLessThan(2);
    expect(radToDeg(all.peakErrMax)).toBeLessThan(5);
  });

  it('event stats are physically consistent', () => {
    for (const [name, r] of perRun) {
      let prevEnd = -Infinity;
      for (const ev of r.events) {
        expect(ev.endT, name).toBeGreaterThan(ev.startT);
        expect(ev.startT, name).toBeGreaterThanOrEqual(prevEnd);
        prevEnd = ev.endT;
        expect(ev.durationS).toBeCloseTo(ev.endT - ev.startT, 6);
        expect(ev.durationS).toBeGreaterThanOrEqual(0.7);
        expect(ev.peakAngle).toBeGreaterThanOrEqual(ev.meanAngle);
        expect(ev.peakAngleT).toBeGreaterThanOrEqual(ev.startT);
        expect(ev.peakAngleT).toBeLessThanOrEqual(ev.endT);
        expect(ev.angleStdDev).toBeGreaterThanOrEqual(0);
        expect(ev.minSpeed).toBeLessThanOrEqual(ev.meanSpeed);
        expect(ev.minSpeed).toBeGreaterThan(2);
        expect(ev.entrySpeed).toBeGreaterThan(5);
        // ∫v dt ≈ meanSpeed × duration (gaps use last known speed)
        expect(ev.distanceM).toBeGreaterThan(ev.meanSpeed * ev.durationS * 0.85);
        expect(ev.distanceM).toBeLessThan(ev.meanSpeed * ev.durationS * 1.15);
        expect(ev.peakYawRate).toBeGreaterThan(0.15);
        expect(ev.peakLateralG).toBeGreaterThan(1.5);
        expect([1, -1]).toContain(ev.initialDirection);
        // boundaries are interpolated between samples, so the index is the nearest sample
        expect(Math.abs(r.states[ev.sampleStart].t - ev.startT)).toBeLessThanOrEqual(0.011);
        expect(Math.abs(r.states[ev.sampleEnd].t - ev.endT)).toBeLessThanOrEqual(0.011);
        expect(r.outputs.filter((o) => o.completed?.id === ev.id).length).toBe(1);
      }
      // ids are contiguous and match the spins map
      r.events.forEach((ev, i) => {
        expect(ev.id).toBe(i + 1);
      });
    }
  });

  it('live phase is coherent with the events', () => {
    const r = perRun.get('harbor s1 L2')!;
    const ph = phasesOf(r.outputs);
    expect(ph.has('entry')).toBe(true);
    expect(ph.has('drifting')).toBe(true);
    expect(ph.has('exit')).toBe(true);
    expect(ph.has('transition')).toBe(true);
    for (const o of r.outputs) {
      if (o.phase === 'idle') expect(o.live).toBeNull();
      else expect(o.live).not.toBeNull();
    }
    // the live drift's id matches the event it becomes
    for (const ev of r.events) {
      const mid = r.outputs[Math.round((ev.sampleStart + ev.sampleEnd) / 2)];
      expect(mid.live?.id).toBe(ev.id);
      expect(mid.phase).not.toBe('idle');
    }
  });

  it('is deterministic', () => {
    const run = simulateRun('harbor', { seed: 2, laps: 2 });
    const states = noisyStream(run.truth, { seed: 7 });
    const a = runDetector(states).events;
    const b = runDetector(states).events;
    expect(a).toEqual(b);
  });
});

// ---------- rule unit tests ----------

describe('DriftDetector rules', () => {
  it('fires nothing on a stationary or straight-driving stream', () => {
    const rng = { s: 42 };
    const noise = () => {
      rng.s = (rng.s * 1103515245 + 12345) & 0x7fffffff;
      return ((rng.s / 0x7fffffff) * 2 - 1) * degToRad(3); // ±3° uniform ≈ worse than 1.5σ
    };
    const parked = synth(10, () => ({ beta: noise(), speed: 0 }));
    const straight = synth(20, () => ({ beta: noise(), speed: 25, yawRate: 0.02, ay: 0.3 }));
    const cornering = synth(20, () => ({ beta: degToRad(3) + noise() * 0.3, speed: 15, yawRate: 0.35, ay: 5 }));
    for (const stream of [parked, straight, cornering]) {
      const { events, outputs } = runDetector(stream);
      expect(events).toEqual([]);
      expect(outputs.every((o) => o.phase === 'idle' && o.live === null && o.completed === null)).toBe(true);
    }
  });

  it('entry: phase is entry during the 150 ms debounce, then drifting; start is backdated to the onset', () => {
    const stream = synth(5, (t) => ({ beta: trapezoid(t, 1, 0.2, 2, degToRad(25)) }));
    const { events, outputs } = runDetector(stream);
    expect(events.length).toBe(1);
    // β crosses 8° at t≈1.064 (+50 ms filter lag); entry phase for 150 ms after
    expect(phaseAt(outputs, 1.05)).toBe('idle');
    expect(phaseAt(outputs, 1.15)).toBe('entry');
    expect(phaseAt(outputs, 1.24)).toBe('entry');
    expect(phaseAt(outputs, 1.32)).toBe('drifting');
    // start backdated to the 4° crossing (t≈1.032 + filter lag)
    expect(events[0].startT).toBeGreaterThan(1.0);
    expect(events[0].startT).toBeLessThan(1.12);
    expect(events[0].initialDirection).toBe(1);
    expect(events[0].peakAngle).toBeCloseTo(degToRad(25), 1);
    expect(events[0].meanAngle).toBeGreaterThan(degToRad(22));
    expect(events[0].angleStdDev).toBeLessThan(degToRad(3));
  });

  it('entry gates: angle alone is not enough (needs speed and lateral accel or yaw rate)', () => {
    const slow = synth(5, (t) => ({ beta: trapezoid(t, 1, 0.2, 2, degToRad(25)), speed: 4 }));
    const noDynamics = synth(5, (t) => ({ beta: trapezoid(t, 1, 0.2, 2, degToRad(25)), yawRate: 0.05, ay: 0.5 }));
    expect(runDetector(slow).events).toEqual([]);
    expect(runDetector(noDynamics).events).toEqual([]);
    const yawOnly = synth(5, (t) => ({ beta: trapezoid(t, 1, 0.2, 2, degToRad(25)), yawRate: 0.3, ay: 0.5 }));
    expect(runDetector(yawOnly).events.length).toBe(1);
  });

  it('exit: phase is exit during the 600 ms hold; event ends where |β| dropped under 4°', () => {
    const stream = synth(6, (t) => ({ beta: trapezoid(t, 1, 0.2, 2, degToRad(25)) }));
    const { events, outputs } = runDetector(stream);
    // ramp-down 3.2→3.4; 4° crossing at t≈3.368 (+ filter lag)
    expect(phaseAt(outputs, 3.5)).toBe('exit');
    expect(phaseAt(outputs, 3.9)).toBe('exit');
    expect(phaseAt(outputs, 4.1)).toBe('idle');
    expect(events[0].endT).toBeGreaterThan(3.35);
    expect(events[0].endT).toBeLessThan(3.5);
    // completed arrives after the merge window, exactly once
    const completedAt = outputs.filter((o) => o.completed).map((o) => o.sampleIndex);
    expect(completedAt.length).toBe(1);
    expect(completedAt[0] / 100).toBeGreaterThan(events[0].endT + 1.0);
    expect(completedAt[0] / 100).toBeLessThan(events[0].endT + 1.2);
  });

  it('exit: speed under 3 m/s ends the drift at once', () => {
    const stream = synth(6, (t) => ({ beta: t > 1 ? degToRad(20) : 0, speed: t < 3 ? 12 : 2.5 }));
    const { events, outputs } = runDetector(stream);
    expect(events.length).toBe(1);
    expect(events[0].endT).toBeCloseTo(3.0, 1);
    expect(outputs[300].phase).toBe('exit');
    expect(outputs[300].completed?.id).toBe(1);
    expect(outputs[301].phase).toBe('idle');
  });

  it('twitch: a slide shorter than 0.7 s is discarded', () => {
    const twitch = synth(4, (t) => ({ beta: trapezoid(t, 1, 0.1, 0.3, degToRad(20)) }));
    const { events, outputs } = runDetector(twitch);
    expect(events).toEqual([]);
    expect(outputs.some((o) => o.phase === 'drifting')).toBe(true); // it was live for a moment...
    expect(outputs.every((o) => o.completed === null)).toBe(true); // ...but never became an event
    const keeper = synth(4, (t) => ({ beta: trapezoid(t, 1, 0.1, 0.7, degToRad(20)) }));
    expect(runDetector(keeper).events.length).toBe(1);
  });

  it('merge: two slides less than 1 s apart become one linked event; further apart stay separate', () => {
    const amp = degToRad(22);
    const close = synth(8, (t) => ({ beta: trapezoid(t, 1, 0.2, 1.5, amp) + trapezoid(t, 3.4, 0.2, 1.5, amp) }));
    const { events, outputs } = runDetector(close);
    expect(events.length).toBe(1);
    expect(events[0].startT).toBeLessThan(1.15);
    expect(events[0].endT).toBeGreaterThan(5.2);
    expect(events[0].transitions).toBe(0);
    expect(events[0].meanAngle).toBeLessThan(amp); // the gap counts toward the mean
    // the live id is the same before and after the gap
    expect(outputs[200].live?.id).toBe(1);
    expect(outputs[450].live?.id).toBe(1);
    expect(outputs[450].live?.startT).toBeCloseTo(events[0].startT, 6);

    const far = synth(9, (t) => ({ beta: trapezoid(t, 1, 0.2, 1.5, amp) + trapezoid(t, 4.4, 0.2, 1.5, amp) }));
    const sep = runDetector(far).events;
    expect(sep.length).toBe(2);
    expect(sep[1].startT - sep[0].endT).toBeGreaterThan(1.0);
    expect(sep.map((e) => e.id)).toEqual([1, 2]);
  });

  it('merge across a direction change counts the transition', () => {
    const amp = degToRad(22);
    const stream = synth(8, (t) => ({ beta: trapezoid(t, 1, 0.2, 1.5, amp) - trapezoid(t, 3.4, 0.2, 1.5, amp) }));
    const { events } = runDetector(stream);
    expect(events.length).toBe(1);
    expect(events[0].transitions).toBe(1);
    expect(events[0].initialDirection).toBe(1);
  });

  it('transition: a quick swing through zero keeps the drift and increments transitions', () => {
    const amp = degToRad(25);
    // +25° for 2 s, swing to −25° in 0.3 s, hold 2 s, exit
    const stream = synth(8, (t) => {
      let beta: number;
      if (t < 1) beta = 0;
      else if (t < 1.2) beta = (amp * (t - 1)) / 0.2;
      else if (t < 3.2) beta = amp;
      else if (t < 3.5) beta = amp - (2 * amp * (t - 3.2)) / 0.3;
      else if (t < 5.5) beta = -amp;
      else if (t < 5.7) beta = -amp * (1 - (t - 5.5) / 0.2);
      else beta = 0;
      return { beta, yawRate: t > 3.2 && t < 3.5 ? -3 : 0.4 };
    });
    const { events, outputs } = runDetector(stream);
    expect(events.length).toBe(1);
    expect(events[0].transitions).toBe(1);
    expect(events[0].initialDirection).toBe(1);
    expect(events[0].durationS).toBeGreaterThan(4.4);
    expect(outputs[400].phase).toBe('drifting');
    expect(outputs[400].live?.direction).toBe(-1);
    expect(outputs[400].live?.transitions).toBe(1);
    const transitionSamples = outputs.filter((o) => o.phase === 'transition');
    expect(transitionSamples.length).toBeGreaterThan(20);
    expect(transitionSamples[0].sampleIndex / 100).toBeGreaterThan(3.3);
    expect(transitionSamples[0].sampleIndex / 100).toBeLessThan(3.6);
    // the momentary pass through |β|<4° never showed as idle
    expect(outputs.slice(130, 570).every((o) => o.phase !== 'idle')).toBe(true);
  });

  it('transition: a sign change without significant yaw rate is not a transition', () => {
    const amp = degToRad(25);
    const stream = synth(8, (t) => {
      let beta: number;
      if (t < 1) beta = 0;
      else if (t < 1.2) beta = (amp * (t - 1)) / 0.2;
      else if (t < 3.2) beta = amp;
      else if (t < 3.5) beta = amp - (2 * amp * (t - 3.2)) / 0.3;
      else if (t < 5.5) beta = -amp;
      else if (t < 5.7) beta = -amp * (1 - (t - 5.5) / 0.2);
      else beta = 0;
      return { beta, yawRate: 0.05, ay: 4 };
    });
    const { events } = runDetector(stream);
    expect(events.length).toBe(1);
    expect(events[0].transitions).toBe(0);
  });

  it('transition: a slow wander through zero (> 1.5 s from side to side) is not a transition', () => {
    const amp = degToRad(20);
    const hover = degToRad(4.5); // above the 4° exit boundary: the drift never exits
    const stream = synth(10, (t) => {
      let beta: number;
      if (t < 1) beta = 0;
      else if (t < 1.2) beta = (amp * (t - 1)) / 0.2;
      else if (t < 3) beta = amp;
      else if (t < 3.3) beta = amp - ((amp - hover) * (t - 3)) / 0.3; // down to 4.5°
      else if (t < 4.3) beta = hover; // hover 1 s
      else if (t < 4.4) beta = hover - (2 * hover * (t - 4.3)) / 0.1; // quick pass through zero
      else if (t < 5.4) beta = -hover; // hover 1 s on the other side
      else if (t < 5.7) beta = -hover - ((amp - hover) * (t - 5.4)) / 0.3;
      else if (t < 7.5) beta = -amp;
      else if (t < 7.7) beta = -amp * (1 - (t - 7.5) / 0.2);
      else beta = 0;
      return { beta, yawRate: 0.5, ay: 4 };
    });
    const { events, outputs } = runDetector(stream);
    expect(events.length).toBe(1);
    expect(events[0].transitions).toBe(0);
    expect(outputs[700].live?.direction).toBe(-1); // the side still updates
    expect(outputs.some((o) => o.phase === 'transition')).toBe(false);
  });

  it('feint: an initiation that flicks the wrong way first is ONE event, counted from the real swings only', () => {
    // Scandinavian flick: |β| goes the WRONG way to 5° for ~0.3 s, reverses into a 25° left-hand
    // slide, then ONE genuine transition to the right. This is what the scripted driver does.
    const FLICK = degToRad(5);
    const AMP = degToRad(25);
    const feint = (t: number): number => {
      if (t < 1) return 0;
      if (t < 1.42) return FLICK * Math.sin((Math.PI * (t - 1)) / 0.42); // flick out and back
      if (t < 1.8) return (-AMP * (t - 1.42)) / 0.38; // the real initiation (β̈-limited ramp)
      if (t < 3.8) return -AMP;
      if (t < 4.1) return -AMP + (2 * AMP * (t - 3.8)) / 0.3; // one real transition
      if (t < 6.1) return AMP;
      if (t < 6.3) return AMP * (1 - (t - 6.1) / 0.2);
      return 0;
    };
    const yawOf = (t: number) => (t > 3.8 && t < 4.1 ? 3 : t < 1.42 ? 0.5 : 0.4);
    const stream = synth(7, (t) => ({ beta: feint(t), yawRate: yawOf(t) }));
    const { events, outputs } = runDetector(stream);
    expect(events.length).toBe(1);
    const ev = events[0];
    // ONE transition: the flick is part of the initiation, the swing at 3.8 s is the real one
    expect(ev.transitions).toBe(1);
    expect(ev.initialDirection).toBe(-1); // the side the car actually ends up on, not the flick
    // the drift starts where the car left straight running — inside the flick, not after it
    expect(ev.startT).toBeGreaterThan(1.05); // |β| crosses 2.5° at t ≈ 1.07
    expect(ev.startT).toBeLessThan(1.2);
    expect(ev.startT).toBeLessThan(1.42); // i.e. before the real slide even begins
    expect(ev.peakAngle).toBeCloseTo(AMP, 1);
    expect(radToDeg(ev.peakAngle)).toBeLessThan(26);
    // it never counts as an exit or a second event in between
    expect(outputs.slice(120, 620).every((o) => o.phase !== 'idle')).toBe(true);
    expect(outputs.filter((o) => o.completed).length).toBe(1);

    // control: the same slide WITHOUT the flick — same event, same transition count, later start
    const plain = synth(7, (t) => ({ beta: t < 1.42 ? 0 : feint(t), yawRate: yawOf(t) }));
    const bare = runDetector(plain).events;
    expect(bare.length).toBe(1);
    expect(bare[0].transitions).toBe(1);
    expect(bare[0].startT).toBeGreaterThan(1.42);
    expect(bare[0].startT - ev.startT).toBeGreaterThan(0.3); // the flick really did move the start
  });

  it('feint: a flick in the middle of a drift is not a transition either', () => {
    const AMP = degToRad(25);
    const mid = (t: number): number => {
      if (t < 1) return 0;
      if (t < 1.2) return (-AMP * (t - 1)) / 0.2;
      if (t < 3.0) return -AMP;
      if (t < 3.15) return -AMP + ((AMP + degToRad(6)) * (t - 3.0)) / 0.15; // out to +6°...
      if (t < 3.3) return degToRad(6);
      if (t < 3.45) return degToRad(6) - ((AMP + degToRad(6)) * (t - 3.3)) / 0.15; // ...and back
      if (t < 5.45) return -AMP;
      if (t < 5.65) return -AMP * (1 - (t - 5.45) / 0.2);
      return 0;
    };
    const stream = synth(6.5, (t) => ({ beta: mid(t), yawRate: t > 3 && t < 3.45 ? 3 : 0.4 }));
    const { events, outputs } = runDetector(stream);
    expect(events.length).toBe(1);
    expect(events[0].transitions).toBe(0); // +6° held 0.16 s: a flick, not a direction change
    expect(events[0].durationS).toBeGreaterThan(4.3);
    expect(outputs.slice(120, 550).every((o) => o.phase !== 'idle')).toBe(true);
    expect(outputs[500].live?.direction).toBe(-1); // back on the side it came from
    // held for 0.5 s instead, the very same swing IS a transition
    const held = (t: number): number => (t >= 3.15 && t < 3.65 ? degToRad(6) : t >= 3.65 && t < 3.8 ? degToRad(6) - ((AMP + degToRad(6)) * (t - 3.65)) / 0.15 : mid(t < 3.15 ? t : t - 0.35));
    const long = runDetector(synth(7, (t) => ({ beta: held(t), yawRate: t > 3 && t < 3.8 ? 3 : 0.4 })));
    expect(long.events.length).toBe(1);
    expect(long.events[0].transitions).toBe(2); // out and back, both sides held
  });

  it('feint: the simulator\'s flicked initiations are timed and counted like the plain ones', () => {
    const run = simulateRun('harbor', { seed: 2, laps: 2 });
    const states = noisyStream(run.truth, { seed: 22, delayS: 0.08 });
    const truth = truthEvents(run.truth);
    const { events } = runDetector(states);
    const flicked = truth.filter((e) => startsWithFeint(run.truth, e.startT));
    expect(flicked.length).toBeGreaterThanOrEqual(4); // this run really does contain feints
    const m = evaluateRun('feint', events, truth);
    for (const p of m.pairs) {
      if (!startsWithFeint(run.truth, p.truth.startT)) continue;
      const latency = p.event.startT - p.truth.startT;
      expect(latency, `start ${p.truth.startT.toFixed(2)}`).toBeGreaterThan(0);
      expect(latency, `start ${p.truth.startT.toFixed(2)}`).toBeLessThan(0.5); // flick included, not skipped
      expect(p.event.transitions, `start ${p.truth.startT.toFixed(2)}`).toBe(p.truth.transitions);
    }
    expect(m.matched).toBe(truth.length);
  });

  it('spin: |β| beyond 75° ends the drift, flags it, and blocks re-entry until recovered', () => {
    const stream = synth(8, (t) => {
      let beta = 0;
      if (t >= 1 && t < 2) beta = degToRad(30) * (t - 1);
      else if (t >= 2 && t < 3.5) beta = degToRad(30) + degToRad(100) * (t - 2); // through 75° at t≈2.45
      else if (t >= 3.5 && t < 5) beta = degToRad(180) - degToRad(180) * (t - 3.5) * 0.9; // unwinding backwards
      return { beta, speed: t < 3.5 ? 15 : 15 - (t - 3.5) * 8, yawRate: 1.5, ay: 3 };
    });
    const { events, outputs, det } = runDetector(stream);
    expect(events.length).toBe(1);
    expect(det.spins.get(events[0].id)).toBe(true);
    expect(events[0].endT).toBeGreaterThan(2.4);
    expect(events[0].endT).toBeLessThan(2.55);
    expect(radToDeg(events[0].peakAngle)).toBeGreaterThan(74);
    const spinOut = outputs.find((o) => o.live?.spin);
    expect(spinOut).toBeDefined();
    expect(spinOut!.phase).toBe('exit');
    expect(spinOut!.completed?.id).toBe(1);
    // no second drift while the car is still rotating / sliding backwards
    expect(outputs.slice(spinOut!.sampleIndex + 1).every((o) => o.phase === 'idle')).toBe(true);
  });

  it('spin: speed collapsing under 3 m/s while |β| > 30° is a spin; a normal slow-down is not', () => {
    const spin = synth(6, (t) => ({ beta: t > 1 ? degToRad(40) : 0, speed: t < 2.5 ? 12 : Math.max(0, 12 - (t - 2.5) * 20) }));
    const a = runDetector(spin);
    expect(a.events.length).toBe(1);
    expect(a.det.spins.get(1)).toBe(true);
    const mild = synth(6, (t) => ({ beta: t > 1 ? degToRad(20) : 0, speed: t < 2.5 ? 12 : Math.max(0, 12 - (t - 2.5) * 20) }));
    const b = runDetector(mild);
    expect(b.events.length).toBe(1);
    expect(b.det.spins.get(1)).toBe(false);
  });

  it('spin: a spun slide is kept even if shorter than the twitch limit', () => {
    const stream = synth(5, (t) => ({ beta: t > 1 ? Math.min(degToRad(120), degToRad(200) * (t - 1)) : 0, yawRate: 2 }));
    const { events, det } = runDetector(stream);
    expect(events.length).toBe(1);
    expect(events[0].durationS).toBeLessThan(0.7);
    expect(det.spins.get(1)).toBe(true);
  });

  it('valid:false never creates a drift and holds the phase for up to 1 s', () => {
    // 1. invalid throughout: nothing, even at 30°
    const blind = synth(6, (t) => ({ beta: t > 1 ? degToRad(30) : 0, valid: false }));
    const b = runDetector(blind);
    expect(b.events).toEqual([]);
    expect(b.outputs.every((o) => o.phase === 'idle')).toBe(true);

    // 2. a 0.5 s gap mid-drift (β reported as garbage) is bridged: one event, phase held
    const bridged = synth(7, (t) => {
      const gap = t >= 2.5 && t < 3.0;
      return { beta: gap ? 0 : trapezoid(t, 1, 0.2, 3, degToRad(25)), valid: !gap };
    });
    const r = runDetector(bridged);
    expect(r.events.length).toBe(1);
    expect(r.events[0].endT).toBeGreaterThan(4.3);
    expect(r.outputs.slice(250, 300).every((o) => o.phase === 'drifting' && o.live?.id === 1)).toBe(true);
    expect(r.events[0].meanAngle).toBeGreaterThan(degToRad(23)); // garbage samples excluded from the stats
    expect(r.events[0].distanceM).toBeGreaterThan(15 * 3.2 * 0.95); // distance keeps integrating through the gap

    // 3. a 1.3 s gap ends the drift at the last valid sample
    const cut = synth(8, (t) => {
      const gap = t >= 2.5 && t < 3.8;
      return { beta: gap ? 0 : trapezoid(t, 1, 0.2, 3, degToRad(25)), valid: !gap };
    });
    const c = runDetector(cut);
    expect(c.events.length).toBeGreaterThanOrEqual(1);
    expect(c.events[0].endT).toBeCloseTo(2.49, 1);
    expect(c.outputs.slice(250, 350).every((o) => o.phase === 'drifting')).toBe(true);
    expect(c.outputs[360].phase).toBe('idle');

    // 4. a gap during the exit hold does not shorten or extend the event
    const holdGap = synth(7, (t) => {
      const gap = t >= 3.5 && t < 3.8;
      return { beta: gap ? degToRad(30) : trapezoid(t, 1, 0.2, 2, degToRad(25)), valid: !gap };
    });
    const h = runDetector(holdGap);
    expect(h.events.length).toBe(1);
    expect(h.events[0].endT).toBeGreaterThan(3.35);
    expect(h.events[0].endT).toBeLessThan(3.5);
  });

  it('finish() closes an open drift and reset() clears everything', () => {
    const stream = synth(3, (t) => ({ beta: t > 1 ? degToRad(20) : 0 }));
    const det = new DriftDetector();
    for (const s of stream) det.push(s);
    expect(det.events.length).toBe(0);
    const ev = det.finish();
    expect(ev).not.toBeNull();
    expect(det.events.length).toBe(1);
    expect(ev!.endT).toBeCloseTo(2.99, 2);
    expect(det.finish()).toBeNull();
    det.reset();
    expect(det.events.length).toBe(0);
    expect(det.spins.size).toBe(0);
    for (const s of stream) det.push(s);
    expect(det.finish()!.id).toBe(1);
  });

  it('finish() during the exit hold ends the event at the hold start', () => {
    const stream = synth(3.7, (t) => ({ beta: trapezoid(t, 1, 0.2, 2, degToRad(25)) })); // ends 0.3 s into the hold
    const det = new DriftDetector();
    for (const s of stream) det.push(s);
    const ev = det.finish();
    expect(ev).not.toBeNull();
    expect(ev!.endT).toBeLessThan(3.5);
  });

  it('is robust to white noise on β at ±1.5° with only 8°/4° thresholds', () => {
    // a 9.5° slide (barely over the entry threshold) held for 2 s must still be one event, not many
    const rng = { s: 7 };
    const noise = () => {
      rng.s = (rng.s * 1103515245 + 12345) & 0x7fffffff;
      const u1 = (rng.s + 1) / 0x80000000;
      rng.s = (rng.s * 1103515245 + 12345) & 0x7fffffff;
      const u2 = (rng.s + 1) / 0x80000000;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * degToRad(1.5);
    };
    const stream = synth(6, (t) => ({ beta: trapezoid(t, 1, 0.3, 2, degToRad(9.5)) + noise() }));
    const { events } = runDetector(stream);
    expect(events.length).toBe(1);
    expect(events[0].transitions).toBe(0);
    expect(events[0].durationS).toBeGreaterThan(1.8);
  });

  it('entrySigmaK: an uncertain estimator must clear the threshold by k·σ', () => {
    const stream = synth(5, (t) => ({ beta: trapezoid(t, 1, 0.2, 2, degToRad(10)) })).map((s) => ({ ...s, betaSigma: degToRad(3) }));
    expect(runDetector(stream).events.length).toBe(1); // default k = 0: 10° > 8°
    expect(runDetector(stream, new DriftDetector({ entrySigmaK: 1 })).events.length).toBe(0); // needs > 11°
    const sure = stream.map((s) => ({ ...s, betaSigma: degToRad(0.5) }));
    expect(runDetector(sure, new DriftDetector({ entrySigmaK: 1 })).events.length).toBe(1); // needs > 8.5°
  });

  it('honours custom options', () => {
    const stream = synth(5, (t) => ({ beta: trapezoid(t, 1, 0.1, 0.4, degToRad(20)) }));
    expect(runDetector(stream).events.length).toBe(0);
    expect(runDetector(stream, new DriftDetector({ minDurationS: 0.3 })).events.length).toBe(1);
    const gentle = synth(5, (t) => ({ beta: trapezoid(t, 1, 0.2, 2, degToRad(6)) }));
    expect(runDetector(gentle).events.length).toBe(0);
    expect(runDetector(gentle, new DriftDetector({ entryAngle: degToRad(5), exitAngle: degToRad(2.5) })).events.length).toBe(1);
  });
});
