import { describe, expect, it } from 'vitest';
import { degToRad, type DriftEvent, type Lap, type SlipState, type StyleCallout, type StyleCalloutKind, type TrackModel } from '../types';
import { simulateRun } from '../../sim';
import {
  DEFAULT_SCORE_OPTIONS,
  LiveScorer,
  angleFactor,
  countTransitions,
  scoreDrift,
  scoreSession,
  speedFactor,
  type LiveDriftInfo,
  type LiveTick,
  type ScoredDrift,
} from './index';
import { eventFromRange, eventsFromTruth, statesFromTruth, trackFromRun } from './score.test-helpers';

// ------------------------------------------------------------------------------------------
// synthetic signal helpers

const RATE = 100;
const DT = 1 / RATE;

interface Piece {
  /** seconds */
  s: number;
  /** |β| profile in degrees as a function of time inside the piece (signed) */
  beta: number | ((t: number) => number);
  /** km/h */
  speed?: number;
  /** true while the detector would report a drift */
  drifting?: boolean;
}

interface Synth {
  states: SlipState[];
  /** drift id per sample (null = idle) */
  ids: Array<number | null>;
}

/** Concatenate pieces at 100 Hz. Every contiguous drifting run gets its own id (1, 2, …). */
function synth(pieces: Piece[], t0 = 0): Synth {
  const states: SlipState[] = [];
  const ids: Array<number | null> = [];
  let t = t0;
  let id = 0;
  let was = false;
  for (const p of pieces) {
    const n = Math.round(p.s * RATE);
    const drifting = p.drifting ?? true;
    if (drifting && !was) id++;
    for (let i = 0; i < n; i++) {
      const tl = i * DT;
      const deg = typeof p.beta === 'number' ? p.beta : p.beta(tl);
      const v = (p.speed ?? 60) / 3.6;
      // a plausible yaw rate: the shared transition rule (detect/options.ts) needs the car to
      // actually be rotating before a sign change counts, exactly as the detector does
      states.push({ t, beta: degToRad(deg), betaSigma: 0.01, heading: 0, course: 0, speed: v, yawRate: 0.6, ay: 0, ax: 0, x: v * t, y: 0, valid: true });
      ids.push(drifting ? id : null);
      t += DT;
    }
    was = drifting;
  }
  return { states, ids };
}

function idle(s: number, speed = 60): Piece {
  return { s, beta: 0, speed, drifting: false };
}

/** Feed a LiveScorer sample by sample; returns every tick and the DriftScores from onDriftCompleted. */
function feed(scorer: LiveScorer, syn: Synth, opts: { complete?: boolean; laps?: Lap[]; spinAt?: number } = {}) {
  const ticks: LiveTick[] = [];
  const scores: ScoredDrift[] = [];
  const { states, ids } = syn;
  let peak = 0;
  let lapIdx = 0;
  for (let i = 0; i < states.length; i++) {
    const id = ids[i];
    let live: LiveDriftInfo | null = null;
    if (id !== null) {
      const start = ids.indexOf(id);
      peak = Math.max(i === start ? 0 : peak, Math.abs(states[i].beta));
      live = { phase: 'drifting', angle: Math.abs(states[i].beta), peakAngle: peak, transitions: 0, durationS: states[i].t - states[start].t, id };
      if (opts.spinAt !== undefined && states[i].t >= opts.spinAt) live.spin = true;
    }
    ticks.push(scorer.push(states[i], live));
    if (opts.complete !== false && id !== null && (i + 1 >= ids.length || ids[i + 1] !== id)) {
      const a = ids.indexOf(id);
      scores.push(scorer.onDriftCompleted(eventFromRange(id, states, a, i)));
    }
    if (opts.laps) {
      while (lapIdx < opts.laps.length && states[i].t >= opts.laps[lapIdx].endT) {
        scorer.onLapCompleted(opts.laps[lapIdx]);
        lapIdx++;
      }
    }
  }
  return { ticks, scores };
}

function eventsOf(syn: Synth): DriftEvent[] {
  const out: DriftEvent[] = [];
  let a = -1;
  for (let i = 0; i <= syn.ids.length; i++) {
    const id = i < syn.ids.length ? syn.ids[i] : null;
    if (id !== null && a < 0) a = i;
    if ((id === null || (a >= 0 && syn.ids[a] !== id)) && a >= 0) {
      out.push(eventFromRange(syn.ids[a] as number, syn.states, a, i - 1));
      a = id === null ? -1 : i;
    }
  }
  return out;
}

const allCallouts = (ticks: LiveTick[]) => ticks.flatMap((t) => t.callouts);
const ofKind = (ticks: LiveTick[], kind: StyleCalloutKind) => allCallouts(ticks).filter((c) => c.kind === kind);
const last = <T>(a: T[]): T => a[a.length - 1];

/** A steady drift of `s` seconds at `deg`, ending in a gentle ramp-out (clean exit). */
function steady(s: number, deg: number, speed = 60): Piece[] {
  return [
    { s, beta: deg, speed },
    { s: 0.6, beta: (t) => deg * (1 - t / 0.6), speed },
  ];
}

/** Sign flip from +deg to −deg over `over` seconds (a transition). */
function flip(deg: number, over = 0.3, speed = 60): Piece {
  return { s: over, beta: (t) => deg - (2 * deg * t) / over, speed };
}

// ------------------------------------------------------------------------------------------

describe('rules: factors', () => {
  const o = DEFAULT_SCORE_OPTIONS;
  it('angleFactor ramps 0 @8° → 1 @35° → 1.3 @≥50°', () => {
    expect(angleFactor(5, o)).toBe(0);
    expect(angleFactor(8, o)).toBe(0);
    expect(angleFactor(21.5, o)).toBeCloseTo(0.5, 6);
    expect(angleFactor(35, o)).toBeCloseTo(1, 6);
    expect(angleFactor(50, o)).toBeCloseTo(1.3, 6);
    expect(angleFactor(70, o)).toBeCloseTo(1.3, 6);
  });
  it('speedFactor 0.5 @20 → 1 @55 → 1.5 @≥85 km/h, 0 below 10 (the speeds drifting happens at)', () => {
    expect(speedFactor(5, o)).toBe(0);
    expect(speedFactor(20, o)).toBeCloseTo(0.5, 6);
    expect(speedFactor(55, o)).toBeCloseTo(1, 6);
    expect(speedFactor(85, o)).toBeCloseTo(1.5, 6);
    expect(speedFactor(140, o)).toBeCloseTo(1.5, 6);
  });
  it('countTransitions applies THE shared rule: ±5°, held 0.4 s on both sides', () => {
    // one clean swing, each side held 1 s at 30°
    const hold = (deg: number, s: number) => new Array(Math.round(s * 100)).fill(degToRad(deg));
    expect(countTransitions([...hold(30, 1), ...hold(-30, 1)])).toBe(1);
    expect(countTransitions([...hold(30, 1), ...hold(-30, 1), ...hold(30, 1)])).toBe(2);
    // a 0.2 s flick the other way inside a 30° slide is a feint, not two direction changes —
    // the bare sign-change rule the scorer used to carry counted it as 2
    expect(countTransitions([...hold(30, 3), ...hold(-12, 0.2), ...hold(30, 3)])).toBe(0);
    // never beyond ±5°
    expect(countTransitions([...hold(4, 1), ...hold(-4, 1), ...hold(4, 1)])).toBe(0);
    // an explicit yaw channel gates it too: no rotation behind the swing, no transition
    const beta = [...hold(30, 1), ...hold(-30, 1)];
    expect(countTransitions(beta, { yawRate: beta.map(() => 0) })).toBe(0);
    expect(countTransitions(beta, { yawRate: beta.map(() => 0.6) })).toBe(1);
  });
});

describe('rules: base points', () => {
  it('more angle → more points, capped at 50°', () => {
    const pts = (deg: number) => scoreDrift(eventsOf(synth([{ s: 4, beta: deg }]))[0], synth([{ s: 4, beta: deg }]).states).base;
    expect(pts(20)).toBeGreaterThan(pts(12));
    expect(pts(35)).toBeGreaterThan(pts(20));
    expect(pts(50)).toBeGreaterThan(pts(35));
    expect(pts(65)).toBeCloseTo(pts(50), 6);
    expect(pts(6)).toBe(0);
  });
  it('more speed → more points, capped at 100 km/h', () => {
    const pts = (kmh: number) => {
      const syn = synth([{ s: 4, beta: 35, speed: kmh }]);
      return scoreDrift(eventsOf(syn)[0], syn.states).base;
    };
    expect(pts(60)).toBeGreaterThan(pts(30));
    expect(pts(100)).toBeGreaterThan(pts(60));
    expect(pts(120)).toBeCloseTo(pts(100), 6);
  });
  it('10 s at 35° / 60 km/h ≈ 1080 base, sustained bumps make the effective multiplier 1.3, total = base × mult + bonus', () => {
    const syn = synth([{ s: 10, beta: 35 }]);
    const d = scoreDrift(eventsOf(syn)[0], syn.states);
    // 100 pts/s × angleFactor 1.0 × speedFactor 1.083 (60 km/h on the drifting-speed scale)
    expect(d.base).toBeGreaterThan(1070);
    expect(d.base).toBeLessThan(1090);
    // +0.25 at 3 s, 6 s, 9 s → ∫mult = 3·1 + 3·1.25 + 3·1.5 + 1·1.75 = 13 → effective 1.3
    expect(d.multiplier).toBeGreaterThan(1.28);
    expect(d.multiplier).toBeLessThan(1.32);
    expect(d.peakMultiplier).toBeCloseTo(1.75, 6);
    expect(d.total).toBeCloseTo(d.base * d.multiplier + d.bonus, 6);
  });
});

describe('rules: multiplier & transitions', () => {
  it('a transition bumps the multiplier by 0.5 and fires TRANSITION ×n worth 90 × the live multiplier; 3 → MANJI', () => {
    const syn = synth([{ s: 2, beta: 30 }, flip(30), { s: 2, beta: -30 }, flip(-30), { s: 2, beta: 30 }, flip(30), { s: 2, beta: -30 }]);
    const sc = new LiveScorer();
    const { ticks } = feed(sc, syn);
    const tr = ofKind(ticks, 'transition');
    expect(tr.map((c) => c.label)).toEqual(['TRANSITION ×1', 'TRANSITION ×2', 'TRANSITION ×3']);
    // FLAT per transition × the multiplier it was earned at (1.5, 2.0, 2.5 …) — the old rule
    // paid 200 × n with no cap, which is what made sawing the wheel worth 570 000 points
    const O = DEFAULT_SCORE_OPTIONS;
    const mults = tr.map((c) => c.points / O.calloutPoints.transition);
    expect(mults[0]).toBeCloseTo(1.5, 6); // flat points × the multiplier they were earned at
    expect(mults[1]).toBeGreaterThan(mults[0]);
    expect(mults[2]).toBeGreaterThan(mults[1]);
    expect(mults[2]).toBeLessThanOrEqual(O.multiplierCap);
    const manji = ofKind(ticks, 'manji');
    expect(manji).toHaveLength(1);
    expect(manji[0].label).toBe('MANJI');
    // MANJI fires on the same sample as the 3rd transition, at the multiplier that bump made
    expect(manji[0].points / O.calloutPoints.manji).toBeCloseTo(tr[2].points / O.calloutPoints.transition, 6);
    // multiplier right after the first transition is 1.5 (no sustained bump yet at 2.15 s)
    const iFirst = ticks.findIndex((t) => t.callouts.some((c) => c.kind === 'transition'));
    expect(ticks[iFirst].multiplier).toBeCloseTo(1.5, 6);
    // the manji moment fires the transition callout in the same tick and both ride on the drift
    const iManji = ticks.findIndex((t) => t.callouts.some((c) => c.kind === 'manji'));
    expect(ticks[iManji].callouts.map((c) => c.kind)).toContain('transition');
  });
  it('the multiplier is capped at 5.0', () => {
    const pieces: Piece[] = [];
    for (let i = 0; i < 12; i++) pieces.push({ s: 1, beta: i % 2 ? -30 : 30 }, flip(i % 2 ? -30 : 30, 0.2));
    const syn = synth(pieces);
    const sc = new LiveScorer();
    const { ticks } = feed(sc, syn);
    expect(Math.max(...ticks.map((t) => t.multiplier))).toBeCloseTo(5, 6);
    // every transition still grows the (capped) multiplier, but only the first few PAY: the
    // bonus is capped per drift, which is what stops a wheel-sawing driver banking 570 000
    const paid = ofKind(ticks, 'transition');
    expect(paid).toHaveLength(DEFAULT_SCORE_OPTIONS.transitionBonusMaxPerDrift);
    expect(sc.completedDrifts[0].transitions).toBeGreaterThanOrEqual(10);
  });
  it('sustained angle adds +0.25 every 3 s; time below 8° does not count', () => {
    const syn = synth([{ s: 7, beta: 30 }]);
    const { ticks } = feed(new LiveScorer(), syn);
    expect(ticks[299].multiplier).toBeCloseTo(1.0, 6);
    expect(ticks[301].multiplier).toBeCloseTo(1.25, 6);
    expect(ticks[601].multiplier).toBeCloseTo(1.5, 6);
    const low = synth([{ s: 7, beta: 5 }]);
    const t2 = feed(new LiveScorer(), low).ticks;
    expect(last(t2).multiplier).toBeCloseTo(1.0, 6);
    expect(last(t2).total).toBe(DEFAULT_SCORE_OPTIONS.calloutPoints.initiation); // initiation only — 5° earns no base points
  });
});

describe('rules: chain, bank, spin', () => {
  it('banks 2 s after a clean exit: BANKED +N, total unchanged, chain points → 0', () => {
    const syn = synth([...steady(3, 30), idle(4)]);
    const { ticks } = feed(new LiveScorer(), syn);
    const exitT = 3.6; // first idle sample
    const iBank = ticks.findIndex((t) => t.banked);
    expect(iBank).toBeGreaterThan(0);
    expect(syn.states[iBank].t).toBeCloseTo(exitT + 2, 2);
    expect(ticks[iBank - 1].chainPoints).toBeGreaterThan(0);
    expect(ticks[iBank].bankedPoints).toBeCloseTo(ticks[iBank - 1].chainPoints, 6);
    expect(ticks[iBank].total).toBeCloseTo(ticks[iBank - 1].total, 6);
    expect(ticks[iBank].chainPoints).toBe(0);
    expect(ticks[iBank].banner).toMatch(/^BANKED \+[\d,]+$/);
    expect(ticks.filter((t) => t.banked)).toHaveLength(1);
    expect(ticks.some((t) => t.lost)).toBe(false);
  });
  it('a drift starting within 3 s inherits the multiplier and the chain count; after 3 s it starts fresh', () => {
    const chained = synth([...steady(4, 30), idle(1), ...steady(2, 30)]);
    const t1 = feed(new LiveScorer(), chained).ticks;
    const i2 = chained.ids.indexOf(2);
    expect(t1[i2].multiplier).toBeCloseTo(1.25, 6); // 4 s sustained → +0.25, carried
    expect(t1[i2].chainDrifts).toBe(2);
    const fresh = synth([...steady(4, 30), idle(4), ...steady(2, 30)]);
    const t2 = feed(new LiveScorer(), fresh).ticks;
    const j2 = fresh.ids.indexOf(2);
    expect(t2[j2].multiplier).toBeCloseTo(1.0, 6);
    expect(t2[j2].chainDrifts).toBe(1);
  });
  it('LINK ×n fires from the 3rd chained drift', () => {
    const syn = synth([...steady(2, 30), idle(1), ...steady(2, 30), idle(1), ...steady(2, 30), idle(1), ...steady(2, 30), idle(4)]);
    const { ticks } = feed(new LiveScorer(), syn);
    const links = ofKind(ticks, 'link');
    expect(links.map((c) => c.label)).toEqual(['LINK ×3', 'LINK ×4']);
    // worth the live multiplier, like every callout: chaining compounds instead of paying a fee
    expect(links.every((c) => c.points >= DEFAULT_SCORE_OPTIONS.calloutPoints.link)).toBe(true);
    // points were still at risk (gaps < 2 s) and bank once at the end, all together
    const banks = ticks.filter((t) => t.banked);
    expect(banks).toHaveLength(1);
    expect(banks[0].bankedPoints).toBeCloseTo(last(ticks).total, 6);
  });
  it('a spin (|β| ≥ 85°) loses the un-banked chain: CHAIN LOST, total drops, multiplier resets', () => {
    const syn = synth([...steady(3, 30), idle(1), { s: 2, beta: 30 }, { s: 0.5, beta: (t) => 30 + (120 * t) / 0.5 }, idle(3), ...steady(2, 30), idle(4)]);
    const sc = new LiveScorer();
    const { ticks, scores } = feed(sc, syn);
    const iLost = ticks.findIndex((t) => t.lost);
    expect(iLost).toBeGreaterThan(0);
    expect(ticks[iLost - 1].chainPoints).toBeGreaterThan(300);
    expect(ticks[iLost].lostPoints).toBeCloseTo(ticks[iLost - 1].chainPoints, 6);
    expect(ticks[iLost].total).toBe(0); // nothing had banked yet
    expect(ticks[iLost].delta).toBeLessThan(-300);
    expect(ticks[iLost].multiplier).toBe(1);
    expect(ticks[iLost].banner).toMatch(/^CHAIN LOST −[\d,]+$/);
    expect(ticks[iLost].chainDrifts).toBe(0);
    expect(ticks[iLost].chainPoints).toBe(0);
    // the rest of the spun drift's samples (same id) earn nothing
    expect(ticks[iLost + 1].delta).toBe(0);
    expect(sc.chain.active).toBe(false);
    expect(scores[0].lost).toBe(true);
    expect(scores[1].lost).toBe(true);
    expect(scores[1].spun).toBe(true);
    expect(scores[1].callouts.some((c) => c.kind === 'perfect-exit')).toBe(false);
    // the third drift starts a fresh chain and banks normally
    expect(scores[2].lost).toBe(false);
    expect(scores[2].chainIndex).toBe(1);
    expect(last(ticks).total).toBeCloseTo(scores[2].total, 6);
    expect(ticks.filter((t) => t.lost)).toHaveLength(1);
  });
  it("the detector's spin flag also loses the chain", () => {
    const syn = synth([{ s: 3, beta: 30 }, idle(3)]);
    const { ticks } = feed(new LiveScorer(), syn, { spinAt: 2 });
    const iLost = ticks.findIndex((t) => t.lost);
    expect(syn.states[iLost].t).toBeCloseTo(2, 2);
    expect(last(ticks).total).toBe(0);
  });
  it('points already banked survive a later spin', () => {
    const syn = synth([...steady(3, 30), idle(2.5), { s: 2, beta: 30 }, { s: 0.5, beta: (t) => 30 + (120 * t) / 0.5 }, idle(3)]);
    const { ticks } = feed(new LiveScorer(), syn);
    const bank = ticks.find((t) => t.banked) as LiveTick;
    expect(bank.bankedPoints).toBeGreaterThan(300);
    const lost = ticks.find((t) => t.lost) as LiveTick;
    expect(lost.total).toBeCloseTo(bank.bankedPoints, 6);
    expect(lost.multiplier).toBe(1);
  });
});

describe('callouts: each fires exactly once per drift with a HUD label', () => {
  it('INITIATION, EXTREME ANGLE, LONG DRIFT, SMOOTH, HIGH SPEED, PERFECT EXIT', () => {
    const syn = synth([
      { s: 2, beta: 40, speed: 100 },
      { s: 1, beta: 47, speed: 100 },
      { s: 1, beta: 40, speed: 100 },
      { s: 1, beta: 47, speed: 100 },
      { s: 4, beta: 40, speed: 100 },
      // feathered out over 3 s: slow enough to be a PERFECT EXIT, not just a clean one
      { s: 3, beta: (t) => 40 * (1 - t / 3), speed: 100 },
      idle(3),
    ]);
    const { ticks, scores } = feed(new LiveScorer(), syn);
    const kinds: StyleCalloutKind[] = ['initiation', 'extreme-angle', 'long-drift', 'smooth', 'high-speed', 'perfect-exit'];
    const labels: Record<string, string> = {
      initiation: 'INITIATION',
      'extreme-angle': 'EXTREME ANGLE',
      'long-drift': 'LONG DRIFT',
      smooth: 'SMOOTH',
      'high-speed': 'HIGH SPEED',
      'perfect-exit': 'PERFECT EXIT',
    };
    const pts = DEFAULT_SCORE_OPTIONS.calloutPoints;
    for (const k of kinds) {
      const c = ofKind(ticks, k);
      expect(c, k).toHaveLength(1);
      expect(c[0].label).toBe(labels[k]);
      // points × the live multiplier: a callout is worth what the driver has earned, so
      // chaining compounds instead of paying a flat participation fee
      expect(c[0].points / pts[k], k).toBeGreaterThanOrEqual(1);
      expect(c[0].points / pts[k], k).toBeLessThanOrEqual(DEFAULT_SCORE_OPTIONS.multiplierCap);
    }
    expect(ofKind(ticks, 'transition')).toHaveLength(0);
    expect(ofKind(ticks, 'manji')).toHaveLength(0);
    // moments: initiation at the first sample, long-drift at 5 s, extreme angle when 47° is first held
    expect(ofKind(ticks, 'initiation')[0].t).toBe(0);
    expect(ofKind(ticks, 'long-drift')[0].t).toBeCloseTo(DEFAULT_SCORE_OPTIONS.longDriftS, 1);
    expect(ofKind(ticks, 'extreme-angle')[0].t).toBeGreaterThan(2);
    expect(ofKind(ticks, 'extreme-angle')[0].t).toBeLessThan(2.6);
    expect(scores[0].bonus).toBeGreaterThanOrEqual(kinds.reduce((a, k) => a + pts[k], 0));
    expect(scores[0].total).toBeCloseTo(scores[0].base * scores[0].multiplier + scores[0].bonus, 6);
  });
  it('no SMOOTH when the angle wobbles, no HIGH SPEED at 60 km/h, no LONG DRIFT under 5 s, no EXTREME ANGLE under 45°', () => {
    const syn = synth([{ s: 4, beta: (t) => 30 + 6 * Math.sin(2 * Math.PI * 0.5 * t) }, idle(3)]);
    const { ticks } = feed(new LiveScorer(), syn);
    for (const k of ['smooth', 'high-speed', 'long-drift', 'extreme-angle'] as StyleCalloutKind[]) expect(ofKind(ticks, k), k).toHaveLength(0);
  });
  it('PERFECT EXIT is a flourish, a CLEAN exit is the normal way out, and a snap-back is neither', () => {
    // a snap-back: 45° pulled out in 0.15 s — neither perfect nor clean
    const snap = synth([{ s: 3, beta: 30 }, { s: 0.15, beta: (t) => 30 - (45 * t) / 0.15 }, idle(3)]);
    const { ticks, scores } = feed(new LiveScorer(), snap);
    expect(ofKind(ticks, 'perfect-exit')).toHaveLength(0);
    expect(scores[0].cleanExit).toBe(false);
    expect(scores[0].stats.exitRateDegS).toBeGreaterThan(DEFAULT_SCORE_OPTIONS.cleanExitMaxRateDegS);
    // steady()'s ramp-out unwinds 30° in 0.6 s = 50°/s: driven out clean, but no flourish.
    // The two thresholds are deliberately different — tying the quality term to the callout
    // threshold meant tuning the callout to be rare took 30 % off everyone's quality score.
    const gentle = synth([...steady(3, 30), idle(3)]);
    const g = feed(new LiveScorer(), gentle);
    expect(ofKind(g.ticks, 'perfect-exit')).toHaveLength(0);
    expect(g.scores[0].cleanExit).toBe(true);
    // a genuinely feathered exit — 30° unwound over 3 s — earns the callout
    const feathered = synth([{ s: 3, beta: 30 }, { s: 3, beta: (t) => 30 * (1 - t / 3) }, idle(3)]);
    const f = feed(new LiveScorer(), feathered);
    expect(ofKind(f.ticks, 'perfect-exit')).toHaveLength(1);
    expect(f.scores[0].cleanExit).toBe(true);
  });
  it('CLEAN LAP fires live via onLapCompleted and offline via the TrackModel, never without laps', () => {
    const syn = synth([...steady(2, 30), idle(2.5), ...steady(2, 30), idle(2.5), ...steady(2, 30), idle(3)]);
    const lap: Lap = { index: 0, startT: 0, endT: 15, durationS: 15, sampleStart: 0, sampleEnd: syn.states.length - 1 };
    const sc = new LiveScorer();
    const { ticks, scores } = feed(sc, syn, { laps: [lap] });
    const live = ofKind(ticks, 'clean-lap');
    expect(live).toHaveLength(1);
    expect(live[0].label).toBe('CLEAN LAP');
    expect(live[0].points).toBeGreaterThanOrEqual(DEFAULT_SCORE_OPTIONS.calloutPoints['clean-lap']);
    expect(scores[2].callouts.some((c) => c.kind === 'clean-lap')).toBe(true);
    const track: TrackModel = { originLat: 0, originLon: 0, refPath: [], closed: true, lengthM: 0, corners: [], laps: [lap] };
    const withTrack = scoreSession(eventsOf(syn), syn.states, track);
    const without = scoreSession(eventsOf(syn), syn.states, null);
    expect(withTrack.cleanLaps).toBe(1);
    expect(withTrack.total - without.total).toBeGreaterThanOrEqual(DEFAULT_SCORE_OPTIONS.calloutPoints['clean-lap']);
    expect(withTrack.perDrift[3].callouts.some((c) => c.kind === 'clean-lap')).toBe(true);
    expect(without.perDrift[3].callouts.some((c) => c.kind === 'clean-lap')).toBe(false);
    expect(sc.total).toBeCloseTo(withTrack.total, 0);
  });
  it('a lap with a spin or fewer than 3 drifts is not clean', () => {
    const syn = synth([...steady(2, 30), idle(2.5), { s: 2, beta: 30 }, { s: 0.5, beta: (t) => 30 + (120 * t) / 0.5 }, idle(2.5), ...steady(2, 30), idle(3)]);
    const lap: Lap = { index: 0, startT: 0, endT: 15, durationS: 15, sampleStart: 0, sampleEnd: syn.states.length - 1 };
    const { ticks } = feed(new LiveScorer(), syn, { laps: [lap] });
    expect(ofKind(ticks, 'clean-lap')).toHaveLength(0);
    const two = synth([...steady(2, 30), idle(2.5), ...steady(2, 30), idle(3)]);
    expect(ofKind(feed(new LiveScorer(), two, { laps: [lap] }).ticks, 'clean-lap')).toHaveLength(0);
  });
});

describe('live scorer API', () => {
  it('onDriftCompleted returns the live-accumulated score, closes an open drift, and replays unknown ids', () => {
    const syn = synth([...steady(3, 30), idle(3)]);
    const sc = new LiveScorer();
    const { ticks, scores } = feed(sc, syn, { complete: false });
    const e = eventsOf(syn)[0];
    const a = sc.onDriftCompleted(e);
    expect(a.total).toBeCloseTo(last(ticks).total, 6);
    expect(sc.onDriftCompleted(e)).toBe(a); // idempotent
    expect(scores).toHaveLength(0);
    // an id the scorer never saw live is replayed from its recent-state ring
    const ghost = { ...e, id: 99 };
    const g = sc.onDriftCompleted(ghost);
    expect(g.total).toBeCloseTo(a.total, 6);
    // closing a drift through onDriftCompleted before the feed goes idle reports end callouts on the next tick
    const sc2 = new LiveScorer();
    const s2 = synth([{ s: 3.6, beta: 30 }, idle(1)]);
    let lastTick: LiveTick | null = null;
    for (let i = 0; i < 360; i++) lastTick = sc2.push(s2.states[i], { phase: 'drifting', angle: 0.5, peakAngle: 0.5, transitions: 0, durationS: i / 100, id: 1 });
    const d = sc2.onDriftCompleted(eventFromRange(1, s2.states, 0, 359));
    const pe = d.callouts.find((c) => c.kind === 'perfect-exit');
    expect(pe).toBeDefined();
    const next = sc2.push(s2.states[360], null);
    expect(next.callouts.some((c) => c.kind === 'perfect-exit')).toBe(true);
    expect(next.total).toBeCloseTo((lastTick as LiveTick).total + (pe as StyleCallout).points, 6);
  });
  it('reset() clears everything', () => {
    const syn = synth([...steady(3, 30), idle(3)]);
    const sc = new LiveScorer();
    feed(sc, syn);
    expect(sc.total).toBeGreaterThan(0);
    sc.reset();
    expect(sc.total).toBe(0);
    expect(sc.multiplier).toBe(1);
    expect(sc.chain).toEqual({ points: 0, drifts: 0, active: false });
    expect(sc.completedDrifts).toHaveLength(0);
  });
  it('the running total climbs every tick while sliding and rate > 0', () => {
    const syn = synth([{ s: 3, beta: 30 }]);
    const { ticks } = feed(new LiveScorer(), syn, { complete: false });
    for (let i = 2; i < ticks.length; i++) {
      expect(ticks[i].delta).toBeGreaterThan(0);
      expect(ticks[i].rate).toBeGreaterThan(0);
      expect(ticks[i].driftId).toBe(1);
    }
    expect(last(ticks).driftPoints).toBeCloseTo(last(ticks).total, 6);
  });
});

describe('live vs offline agreement', () => {
  it('synthetic chain with bank, inherit, spin and fresh start: per-drift totals match within 1 % (in fact exactly)', () => {
    const syn = synth([
      ...steady(4, 30),
      idle(1),
      { s: 2, beta: 30 },
      flip(30),
      { s: 2, beta: -30 },
      { s: 0.6, beta: (t) => -30 * (1 - t / 0.6) },
      idle(2.5),
      ...steady(3, 40),
      idle(5),
      { s: 2, beta: 30 },
      { s: 0.5, beta: (t) => 30 + (120 * t) / 0.5 },
      idle(2),
      ...steady(3, 35),
      idle(3),
    ]);
    const sc = new LiveScorer();
    const { scores } = feed(sc, syn);
    const ss = scoreSession(eventsOf(syn), syn.states, null);
    expect(scores).toHaveLength(5);
    for (const s of scores) {
      const o = ss.perDrift[s.id];
      expect(Math.abs(o.total - s.total)).toBeLessThanOrEqual(0.01 * Math.max(1, o.total));
      expect(o.lost).toBe(s.lost);
      expect(o.chainIndex).toBe(s.chainIndex);
      expect(o.callouts.map((c) => c.kind)).toEqual(s.callouts.map((c) => c.kind));
    }
    expect(ss.perDrift[2].chainIndex).toBe(2);
    expect(ss.perDrift[3].chainIndex).toBe(3);
    expect(ss.perDrift[4].lost).toBe(true);
    expect(ss.perDrift[3].lost).toBe(false); // banked during the 5 s gap before the spin
    expect(Math.abs(ss.total - sc.total)).toBeLessThanOrEqual(0.01 * ss.total);
  });
  it('simulated harbor run: LiveScorer reproduces scoreSession per drift and in total', () => {
    const run = simulateRun('harbor', { seed: 1, aggression: 0.8, consistency: 0.85, laps: 2 });
    const states = statesFromTruth(run.truth, 1, 1);
    const events = eventsFromTruth(run.truth, states);
    const track = trackFromRun(run, states);
    const ss = scoreSession(events, states, track);
    const sc = new LiveScorer();
    const byStart = new Map<number, DriftEvent>();
    for (const e of events) byStart.set(e.sampleStart, e);
    let cur: DriftEvent | null = null;
    let lapIdx = 0;
    const liveScores: ScoredDrift[] = [];
    for (let i = 0; i < states.length; i++) {
      if (byStart.has(i)) cur = byStart.get(i) as DriftEvent;
      const s = states[i];
      const live: LiveDriftInfo | null = cur
        ? { phase: 'drifting', angle: Math.abs(s.beta), peakAngle: cur.peakAngle, transitions: cur.transitions, durationS: s.t - cur.startT, id: cur.id }
        : null;
      sc.push(s, live);
      if (cur && i === cur.sampleEnd) {
        liveScores.push(sc.onDriftCompleted(cur));
        cur = null;
      }
      while (lapIdx < track.laps.length && s.t >= track.laps[lapIdx].endT) sc.onLapCompleted(track.laps[lapIdx++]);
    }
    expect(liveScores).toHaveLength(events.length);
    for (const s of liveScores) {
      const o = ss.perDrift[s.id];
      expect(Math.abs(o.total - s.total), `drift ${s.id}`).toBeLessThanOrEqual(0.01 * Math.max(1, o.total));
      expect(o.callouts.map((c) => c.kind)).toEqual(s.callouts.map((c) => c.kind));
    }
    expect(Math.abs(ss.total - sc.total)).toBeLessThanOrEqual(0.01 * ss.total);
    expect(sc.chain.points).toBe(0); // everything banked by the time the car is parked
  });
});

describe('session components', () => {
  it('no drifts → zeros and D', () => {
    const ss = scoreSession([], [], null);
    expect(ss.total).toBe(0);
    expect(ss.grade).toBe('D');
    expect(ss.angle).toBe(0);
    expect(ss.bestDriftId).toBeNull();
  });
  it('a spin lowers quality and the session total; bestDriftId is a kept drift', () => {
    const clean = synth([...steady(3, 30), idle(4), ...steady(3, 30), idle(4)]);
    const spun = synth([...steady(3, 30), idle(4), { s: 3, beta: 30 }, { s: 0.5, beta: (t) => 30 + (120 * t) / 0.5 }, idle(4)]);
    const a = scoreSession(eventsOf(clean), clean.states, null);
    const b = scoreSession(eventsOf(spun), spun.states, null);
    expect(b.quality).toBeLessThan(a.quality * 0.6);
    expect(b.total).toBeLessThan(a.total);
    expect(b.spins).toBe(1);
    expect(b.bestDriftId).toBe(1);
    expect(b.longestChainPoints).toBeCloseTo(b.perDrift[1].total, 0);
  });
  it('angle / speed components follow their maps', () => {
    const at = (deg: number, kmh: number) => {
      const syn = synth([...steady(6, deg, kmh), idle(3)]);
      return scoreSession(eventsOf(syn), syn.states, null);
    };
    // both curves are written for the range real drifting lives in: held peaks of 24–43°
    // (the whole skill grid spans 27–42) and drifting speeds of 44–66 km/h (measured 48–61).
    expect(at(20, 60).angle).toBe(0);
    expect(at(29, 60).angle).toBeCloseTo(30, 0);
    expect(at(33, 60).angle).toBeCloseTo(65, 0);
    expect(at(37, 60).angle).toBeCloseTo(92, 0);
    expect(at(60, 60).angle).toBeCloseTo(100, 0);
    expect(at(30, 44).speed).toBe(0);
    expect(at(30, 55).speed).toBeCloseTo(55, 0);
    expect(at(30, 60).speed).toBeCloseTo(92, 0);
    expect(at(30, 120).speed).toBeCloseTo(100, 0);
  });
  it('a wobbly driver scores lower steadiness/consistency than a steady one', () => {
    const steadyRun = synth([...steady(10, 30), idle(3)]);
    const wobbly = synth([{ s: 10, beta: (t) => 30 + 4 * Math.sin(2 * Math.PI * 0.5 * t) + 3 * Math.sin(2 * Math.PI * 0.9 * t) }, { s: 0.6, beta: (t) => 30 * (1 - t / 0.6) }, idle(3)]);
    const a = scoreSession(eventsOf(steadyRun), steadyRun.states, null);
    const b = scoreSession(eventsOf(wobbly), wobbly.states, null);
    // no track model → nothing to be cross-lap consistent WITH, so this is steadiness alone
    expect(a.consistency).toBeGreaterThan(95);
    expect(b.consistency).toBeLessThan(40);
    expect(a.steadiness).toBeGreaterThan(b.steadiness + 50);
  });
});

describe('simulator-derived sessions', () => {
  const session = (track: 'harbor' | 'touge', aggression: number, consistency: number, seed = 1) => {
    const run = simulateRun(track, { seed, aggression, consistency, laps: 2 });
    const states = statesFromTruth(run.truth, 1, seed);
    const events = eventsFromTruth(run.truth, states);
    return scoreSession(events, states, trackFromRun(run, states));
  };
  it('consistency 0.95 scores higher consistency than 0.25 (same seed / aggression)', () => {
    const hi = session('harbor', 0.7, 0.95);
    const lo = session('harbor', 0.7, 0.25);
    expect(hi.consistency).toBeGreaterThan(lo.consistency + 20);
    expect(hi.crossLapConsistency as number).toBeGreaterThan(lo.crossLapConsistency as number);
    expect(hi.steadiness).toBeGreaterThan(lo.steadiness);
  });
  it('aggression 1.0 scores higher angle than 0.3', () => {
    expect(session('harbor', 1.0, 0.7).angle).toBeGreaterThan(session('harbor', 0.3, 0.7).angle + 15);
  });
  it('a good run (aggression .8, consistency .85, harbor 2 laps) grades A or S; a weak run (.3/.3) grades C or D', () => {
    const good = session('harbor', 0.8, 0.85);
    const weak = session('harbor', 0.3, 0.3);
    expect(['A', 'S']).toContain(good.grade);
    expect(['C', 'D']).toContain(weak.grade);
    expect(good.combined).toBeGreaterThan(weak.combined + 15);
    expect(good.cleanLaps).toBe(2);
  });
  it('prints the component table for the critic', () => {
    const rows: string[] = [];
    // `—` in the xlap column = an open road with no second lap to be consistent with. Never
    // print NaN in a metrics table: a real NaN would then be indistinguishable from a legitimate
    // "not applicable", which is exactly how one hides.
    rows.push('scenario                | seed | total  | grade | comb | angle | cons (xlap/steady) | qual (steady/t15/exitF/spinF) | speed | style | drifts | tr | callout kinds');
    const scen = [
      ['good harbor .8/.85', 'harbor', 0.8, 0.85],
      ['weak harbor .3/.3', 'harbor', 0.3, 0.3],
      ['harbor cons .95', 'harbor', 0.7, 0.95],
      ['harbor cons .25', 'harbor', 0.7, 0.25],
      ['harbor agg 1.0', 'harbor', 1.0, 0.7],
      ['harbor agg 0.3', 'harbor', 0.3, 0.7],
      ['good touge .8/.85', 'touge', 0.8, 0.85],
      ['weak touge .3/.3', 'touge', 0.3, 0.3],
    ] as const;
    for (const seed of [1, 2, 3]) {
      for (const [name, track, agg, cons] of scen) {
        const ss = session(track, agg, cons, seed);
        const q = ss.qualityParts;
        const kinds = new Set<string>();
        for (const d of Object.values(ss.perDrift)) for (const c of d.callouts) kinds.add(c.kind);
        rows.push(
          `${name.padEnd(23)} | ${seed}    | ${String(ss.total).padStart(6)} | ${ss.grade}     | ${ss.combined.toFixed(1).padStart(4)} | ${ss.angle.toFixed(0).padStart(5)} | ${ss.consistency.toFixed(0).padStart(4)} (${(ss.crossLapConsistency === null ? '—' : ss.crossLapConsistency.toFixed(0)).padStart(3)}/${ss.steadiness.toFixed(0).padStart(3)}) | ${ss.quality.toFixed(0).padStart(4)} (${q.steadiness.toFixed(0).padStart(3)}/${q.timeAtAngle.toFixed(0).padStart(3)}/${q.exitFactor.toFixed(2)}/${q.spinFactor.toFixed(2)}) | ${ss.speed.toFixed(0).padStart(5)} | ${ss.style.toFixed(0).padStart(5)} | ${String(ss.drifts).padStart(6)} | ${String(ss.transitions).padStart(2)} | ${[...kinds].join(',')}`,
        );
      }
    }
    // process.stdout.write, never the console: vitest 5 swallows console output by default
    process.stdout.write('\n' + rows.join('\n') + '\n');
    expect(rows.length).toBe(25);
  });
});
