/**
 * Tests for the parts of the feel layer that can be checked without a phone.
 *
 * Four things are worth testing here and each one has failed in some app somewhere:
 *   1. the bank agrees with the event stream and with `src/ui/callouts.ts`;
 *   2. the committed WAVs are the ones the code thinks they are (an INDEPENDENT reader, not the
 *      renderer's own, so a bug in `tools/audio/dsp.mjs` cannot make this pass by agreeing with
 *      itself);
 *   3. the mixer's priority, family, flick and gate rules do what the bank's prose claims;
 *   4. the two settings each govern their own channel, at the moment of play.
 *
 * Every test here is written so it CAN fail: the level assertions are against the tier targets
 * rather than against the numbers that happen to be in `waveforms.ts`, the mixer tests drive the
 * real `DriftFeel` with a recording port, and the run-level test pushes a real simulated run
 * through the real pipeline.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DriftPipeline, type LiveFrame } from '../../engine/pipeline';
import type { Grade, StyleCalloutKind } from '../../engine/types';
import { MIN_GAP_SLACK_S, REWIND_MARGIN_S } from '../../platform/audioTypes';
import { simulateRun, type TrackId } from '../../sim';
import { toneFor } from '../callouts';
import { AUDIO_FILES, BED_HIGH, BED_LOW, CALLOUT_SOUND, EXIT_SETTLE_S, gradeCueFor, SOUND_BANK, specFor, voiceLifetimeS, type SoundId, type SoundSpec } from './bank';
import { DriftFeel, trustIn } from './mixer';
import { SOUND_SEQUENCES } from './sequences';
import { CLIP_MEASUREMENTS, TIER_TARGETS } from './waveforms';

/** The rows that name a file. `exit-edge` is felt and never heard, so it has no WAV to measure. */
const CLIPS: readonly SoundSpec[] = SOUND_BANK.filter((s) => s.file !== null);

const AUDIO_DIR = path.resolve(__dirname, '../../../assets/audio');

// ── an independent WAV reader ─────────────────────────────────────────────────────────────────
/**
 * Deliberately NOT `tools/audio/dsp.mjs`. If the renderer and the test shared a decoder, a bug in
 * it would make both agree and the test would pass while the shipped files were wrong.
 */
function readWav(file: string): { samples: Float64Array; sampleRate: number; channels: number; bits: number; bytes: number } {
  const buf = readFileSync(file);
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
  let pos = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      format = buf.readUInt16LE(pos + 8);
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === 'data') {
      data = buf.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`${file}: no data chunk`);
  const n = Math.floor(data.length / 2 / Math.max(1, channels));
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2 * channels) / 32768;
  return { samples, sampleRate, channels, bits, bytes: buf.length, ...(format === 1 ? {} : { format }) } as never;
}

const db = (x: number) => 20 * Math.log10(Math.max(1e-9, x));
const peakOf = (s: Float64Array) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rmsOf = (s: Float64Array) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / Math.max(1, s.length));

/**
 * An independent spectral centroid, for the same reason as the independent WAV reader: the
 * renderer and `tools/audio/analyse.mjs` share `dsp.mjs`, so a centroid computed with THEIR code
 * could only ever agree with itself. This is a plain Hann-windowed radix-2 DFT over the same
 * frames, written here from scratch.
 *
 * WHAT IT CATCHES. The two disagreed by up to 7 % (initiation 844 Hz in `waveforms.ts` against
 * 903 Hz from the analyser) — not because the algorithms differed but because they measured
 * DIFFERENT SIGNALS: the renderer measured its float buffer and the analyser the dithered 16-bit
 * file that actually ships. Broadband dither is a far bigger share of a −27.9 dBFS clip than of
 * a −17 dBFS one, which is why the quietest clips disagreed most. This reads the file.
 */
function centroidOf(samples: Float64Array, sampleRate: number): number {
  const N = 4096;
  const hop = Math.max(1, Math.floor(samples.length / 24));
  let num = 0;
  let den = 0;
  for (let start = 0; start + N <= samples.length || start === 0; start += hop) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const j = start + i;
      re[i] = (j < samples.length ? samples[j] : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    }
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k);
          const wi = Math.sin(ang * k);
          const ur = re[i + k];
          const ui = im[i + k];
          const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
          const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr;
          im[i + k + len / 2] = ui - vi;
        }
      }
    }
    for (let k = 1; k < N / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      num += ((k * sampleRate) / N) * mag;
      den += mag;
    }
    if (start + N > samples.length) break;
  }
  return den > 0 ? num / den : 0;
}

/**
 * The worst spread of a LOOP's short-term RMS, measured around the loop rather than along the
 * buffer — a loop has no ends, so a window that stops at the last sample measures something the
 * driver never hears.
 */
function loopRmsSpreadDb(samples: Float64Array, sampleRate: number, windowS: number): number {
  const n = samples.length;
  const w = Math.max(2, Math.round(windowS * sampleRate));
  let sum = 0;
  for (let i = 0; i < w; i++) sum += samples[i % n] ** 2;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = db(Math.sqrt(sum / w));
    if (d < lo) lo = d;
    if (d > hi) hi = d;
    sum -= samples[i % n] ** 2;
    sum += samples[(i + w) % n] ** 2;
  }
  return hi - lo;
}

// ── a recording port ──────────────────────────────────────────────────────────────────────────
function recorder() {
  const played: SoundId[] = [];
  const stopped: SoundId[] = [];
  const beds: Array<[number, number]> = [];
  const haptics: string[] = [];
  return {
    played,
    stopped,
    beds,
    haptics,
    sound: {
      play(id: string) {
        played.push(id as SoundId);
        return true;
      },
      stop(id: string) {
        stopped.push(id as SoundId);
      },
      setBed(low: number, high: number) {
        beds.push([low, high]);
      },
    },
    haptic: {
      impact(shape: string) {
        haptics.push(shape);
      },
      notify(shape: string) {
        haptics.push(shape);
      },
    },
  };
}

/** A minimal `LiveFrame` with everything quiet, so a test states only what it is about. */
function frameAt(t: number, over: Partial<LiveFrame> = {}): LiveFrame {
  const base: LiveFrame = {
    t,
    state: { t, beta: 0, betaSigma: 0, heading: 0, course: 0, speed: 20, yawRate: 0, ay: 0, ax: 0, x: 0, y: 0, valid: true },
    phase: 'idle',
    live: null,
    completed: null,
    score: { total: 0, delta: 0, multiplier: 1, chainPoints: 0, chainActive: false, banked: false, lost: false, bankedPoints: 0, lostPoints: 0, counting: true, callouts: [] },
    calibration: { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], quality: 1, forwardResolved: true, t },
    integrity: { mount: 'rigid', physics: 'ok', gps: 'good', message: '', believable: true },
    lap: { count: 0, progress: 0, completed: null },
  };
  return { ...base, ...over, score: { ...base.score, ...(over.score ?? {}) }, integrity: { ...base.integrity, ...(over.integrity ?? {}) } };
}

function callout(kind: StyleCalloutKind, t: number) {
  return { t, kind, label: kind.toUpperCase(), points: 100 };
}

/** A clock the test moves by hand, so debounce windows and voice lifetimes are exact. */
function clock() {
  const state = { t: 0 };
  return { state, now: () => state.t };
}

// ── 1. the bank ───────────────────────────────────────────────────────────────────────────────
describe('the sound bank covers the event stream', () => {
  const ALL_KINDS: StyleCalloutKind[] = [
    'initiation',
    'transition',
    'extreme-angle',
    'long-drift',
    'smooth',
    'high-speed',
    'manji',
    'link',
    'perfect-exit',
    'clean-lap',
  ];

  it('maps every callout kind the engine can emit', () => {
    for (const kind of ALL_KINDS) expect(CALLOUT_SOUND).toHaveProperty(kind);
    expect(Object.keys(CALLOUT_SOUND).sort()).toEqual(ALL_KINDS.slice().sort());
  });

  it('has a clip for every one of the moments the design names', () => {
    // The list the brief calls the minimum, plus the two that only the UI can fire.
    for (const id of ['initiation', 'transition', 'extreme', 'exit', 'banked', 'lost', 'spin', 'lap', 'stop', 'grade'] as SoundId[]) {
      expect(specFor(id), `${id} is missing from the bank`).toBeDefined();
    }
  });

  it('is silent for the two kinds that duplicate a phase edge, and only those', () => {
    // These are deliberate silences, not gaps: both events already sound off the phase edge,
    // which is 0 ms (initiation) and 410 ms (transition) earlier. Clips of both names exist —
    // that is what makes this an intentional mapping rather than an omission.
    expect(CALLOUT_SOUND.initiation).toBeNull();
    expect(CALLOUT_SOUND.transition).toBeNull();
    expect(specFor('initiation')).toBeDefined();
    expect(specFor('transition')).toBeDefined();
    const silent = Object.entries(CALLOUT_SOUND).filter(([, v]) => v === null).map(([k]) => k);
    expect(silent.sort()).toEqual(['initiation', 'transition']);
  });

  it('wears the colour `src/ui/callouts.ts` gives the same event', () => {
    for (const [kind, id] of Object.entries(CALLOUT_SOUND)) {
      if (id === null) continue;
      const spec = specFor(id);
      expect(spec, `${id}`).toBeDefined();
      expect(spec!.tone, `${kind} -> ${id}`).toBe(toneFor(kind));
    }
    // And the two that come off phase edges rather than callouts still follow the same rule.
    expect(specFor('initiation')!.tone).toBe(toneFor('initiation'));
    expect(specFor('transition')!.tone).toBe(toneFor('transition'));
  });

  it('gives the event that fires on every drift the lowest priority in the bank', () => {
    const lowest = SOUND_BANK.reduce((a, b) => (a.priority <= b.priority ? a : b));
    expect(lowest.id).toBe('initiation');
    expect(specFor('initiation')!.tone).toBe('muted');
    // and the quietest tier
    expect(CLIP_MEASUREMENTS.initiation.tier).toBe('D');
    for (const spec of CLIPS) {
      if (spec.id === 'initiation') continue;
      expect(CLIP_MEASUREMENTS[spec.id].rmsDb, `${spec.id} should not be quieter than initiation`).toBeGreaterThan(CLIP_MEASUREMENTS.initiation.rmsDb);
    }
  });

  it('never lets a clip meet a player that is still being rewound', () => {
    // AGAINST THE PORT'S OWN CONSTANT, not a number retyped here. This assertion used to read
    // `dur + 0.05`, which is 10 ms BEFORE `src/platform/audio.ts` fires its rewind timer — so it
    // would have passed a bank that breaks the port's stated guarantee, and the tightest row
    // (`transition`, 0.340 s clip, rewind at 0.400, minGap 0.420) really did leave 20 ms between
    // an issued async `seekTo(0)` and the next possible `play()`.
    for (const spec of CLIPS) {
      const dur = CLIP_MEASUREMENTS[spec.id].durationS;
      const needed = dur + REWIND_MARGIN_S + MIN_GAP_SLACK_S;
      expect(
        spec.minGapS + 1e-9,
        `${spec.id}: minGapS ${spec.minGapS} must clear ${dur} s + ${REWIND_MARGIN_S} rewind + ${MIN_GAP_SLACK_S} slack = ${needed.toFixed(3)}`,
      ).toBeGreaterThanOrEqual(needed);
    }
  });

  it('gives the one row with no file a debounce of its own, and no voice', () => {
    const felt = SOUND_BANK.filter((s) => s.file === null);
    expect(felt.map((s) => s.id)).toEqual(['exit-edge']);
    for (const spec of felt) {
      expect(spec.haptic, `${spec.id} exists only to be felt, so it must have a haptic`).not.toBeNull();
      expect(voiceLifetimeS(spec.id), `${spec.id} must not hold a voice`).toBe(0);
      expect(spec.minGapS).toBeGreaterThan(EXIT_SETTLE_S);
      expect(CLIP_MEASUREMENTS[spec.id]).toBeUndefined();
    }
  });

  it('holds a voice only for as long as the clip is audible', () => {
    for (const spec of CLIPS) {
      const m = CLIP_MEASUREMENTS[spec.id];
      expect(voiceLifetimeS(spec.id)).toBe(m.activeS);
      expect(m.activeS).toBeLessThanOrEqual(m.durationS + 1e-9);
    }
  });

  it('gives a haptic only to events that carry news', () => {
    // The accents colour a run; a buzz on each of them turns three callouts into a stutter.
    for (const id of ['long', 'smooth', 'speed', 'lap'] as SoundId[]) expect(specFor(id)!.haptic).toBeNull();
    // Everything the design names as a beat is felt.
    expect(specFor('initiation')!.haptic).toBe('heavy');
    expect(specFor('transition')!.haptic).toBe('medium');
    expect(specFor('exit')!.haptic).toBe('soft');
    expect(specFor('spin')!.haptic).toBe('error');
    expect(specFor('lost')!.haptic).toBe('warning');
    expect(specFor('banked')!.haptic).toBe('success');
    // The grade reveal is the only two-stage haptic in the app.
    expect(specFor('grade')!.haptic).toBe('heavy');
    expect(specFor('grade')!.hapticThen).toEqual({ shape: 'success', delayS: 0.14 });
  });

  it('covers every beat docs/DESIGN.md names, and the exit is one of them', () => {
    // THIS TEST USED TO ASSERT A CONSTANT. It checked `specFor('exit')!.haptic === 'soft'` and
    // called that "the exit is felt" — but `exit` is bound to the `perfect-exit` CALLOUT, which
    // the scorer withholds on most slides, so the assertion passed while most slides ended with
    // nothing felt at all. Coverage is asserted against real runs further down; what belongs
    // here is that the design's four named beats each have a ROW to fire them.
    //
    // docs/DESIGN.md § Motion language: entry heavy, transition medium, exit light, grade.
    const feltOn = (trigger: string) => SOUND_BANK.filter((sp) => sp.trigger.includes(trigger) && sp.haptic !== null);
    expect(feltOn('idle → entry').map((sp) => sp.haptic)).toEqual(['heavy']);
    expect(feltOn('→ transition').map((sp) => sp.haptic)).toEqual(['medium']);
    const exitEdge = SOUND_BANK.filter((sp) => sp.trigger.startsWith('phase edge active → idle'));
    expect(exitEdge.map((sp) => sp.haptic), 'the exit phase edge must have a light haptic of its own').toEqual(['light']);
    // And it is felt rather than heard, which is what makes it reach a phone on silent.
    expect(exitEdge[0].file).toBeNull();
  });

  it('answers the grade with the colour the results screen paints it', () => {
    // `src/ui/theme.ts` stops using an accent colour below B: C is plain text, D is muted. The
    // ear follows the letter, so the gold fanfare stops there too.
    const letters: Grade[] = ['S', 'A', 'B', 'C', 'D'];
    expect(letters.map(gradeCueFor)).toEqual(['grade', 'grade', 'grade', 'grade-low', 'grade-low']);
    expect(specFor('grade')!.tone).toBe('gold');
    expect(specFor('grade')!.hapticThen).toEqual({ shape: 'success', delayS: 0.14 });
    // The unlit render keeps the letter landing and drops the gold: no bell, no Success ring.
    expect(specFor('grade-low')!.tone).toBe('muted');
    expect(specFor('grade-low')!.haptic).toBe('heavy');
    expect(specFor('grade-low')!.hapticThen).toBeUndefined();
    // Same figure, same weight, measurably darker.
    expect(CLIP_MEASUREMENTS['grade-low'].tier).toBe(CLIP_MEASUREMENTS.grade.tier);
    expect(CLIP_MEASUREMENTS['grade-low'].durationS).toBe(CLIP_MEASUREMENTS.grade.durationS);
    expect(CLIP_MEASUREMENTS['grade-low'].centroidHz).toBeLessThan(CLIP_MEASUREMENTS.grade.centroidHz * 0.8);
  });
});

// ── 2. the files ──────────────────────────────────────────────────────────────────────────────
describe('the rendered WAVs', () => {
  it('exist, one per clip, and nothing else', () => {
    expect(AUDIO_FILES).toHaveLength(CLIPS.length + 2);
    for (const file of AUDIO_FILES) expect(existsSync(path.join(AUDIO_DIR, file)), `${file} is missing`).toBe(true);
    // And nothing is shipped that the bank does not name.
    const onDisk = AUDIO_FILES.slice().sort();
    expect(onDisk).toEqual([...new Set(onDisk)].sort());
  });

  it('are 16-bit mono 44.1 kHz PCM with no clipping and no DC offset', () => {
    for (const file of AUDIO_FILES) {
      const wav = readWav(path.join(AUDIO_DIR, file));
      expect(wav.sampleRate, file).toBe(44100);
      expect(wav.channels, file).toBe(1);
      expect(wav.bits, file).toBe(16);
      expect(wav.samples.length, file).toBeGreaterThan(1000);
      const clipped = wav.samples.reduce((n, v) => n + (Math.abs(v) >= 32767 / 32768 ? 1 : 0), 0);
      expect(clipped, `${file} has ${clipped} clipped samples`).toBe(0);
      const dc = wav.samples.reduce((a, v) => a + v, 0) / wav.samples.length;
      expect(Math.abs(dc), `${file} DC offset`).toBeLessThan(1e-3);
    }
  });

  it('match the committed measurements, so a re-render that was not committed is caught', () => {
    for (const [id, m] of Object.entries(CLIP_MEASUREMENTS)) {
      const wav = readWav(path.join(AUDIO_DIR, `${id}.wav`));
      expect(wav.samples.length / wav.sampleRate, `${id} duration`).toBeCloseTo(m.durationS, 2);
      expect(db(peakOf(wav.samples)), `${id} peak`).toBeCloseTo(m.peakDb, 0);
      expect(db(rmsOf(wav.samples)), `${id} rms`).toBeCloseTo(m.rmsDb, 0);
      expect(wav.bytes, `${id} size`).toBe(m.bytes);
      expect(m.peaks).toHaveLength(96);
    }
  });

  it('sit on their tier, so the bank is a ladder and not an accident', () => {
    for (const [id, m] of Object.entries(CLIP_MEASUREMENTS)) {
      const tier = TIER_TARGETS[m.tier];
      expect(tier, `${id} tier ${m.tier}`).toBeDefined();
      // Within 0.6 dB of the tier's RMS target...
      expect(Math.abs(m.rmsDb - tier.rms), `${id} is ${(m.rmsDb - tier.rms).toFixed(1)} dB off tier ${m.tier}`).toBeLessThanOrEqual(0.6);
      // ...and never over its peak ceiling.
      expect(m.peakDb, `${id} peak`).toBeLessThanOrEqual(tier.peak + 0.05);
    }
  });

  it('spans a designed ladder rather than a random spread', () => {
    const oneShots = CLIPS.map((s) => CLIP_MEASUREMENTS[s.id].rmsDb);
    const spread = Math.max(...oneShots) - Math.min(...oneShots);
    // Sounds 12 dB apart in loudness are a mix, not a design. Four tiers, 11 dB, on purpose.
    expect(spread).toBeLessThan(12);
    // Inside a tier, clips must be within 1 dB of each other or the tier means nothing.
    const byTier = new Map<string, number[]>();
    for (const spec of CLIPS) {
      const m = CLIP_MEASUREMENTS[spec.id];
      byTier.set(m.tier, [...(byTier.get(m.tier) ?? []), m.rmsDb]);
    }
    for (const [tier, levels] of byTier) {
      if (levels.length < 2) continue;
      expect(Math.max(...levels) - Math.min(...levels), `tier ${tier} is not level`).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the whole bank small enough to bundle', () => {
    const total = AUDIO_FILES.reduce((n, f) => n + readFileSync(path.join(AUDIO_DIR, f)).length, 0);
    expect(total).toBeLessThan(2 * 1024 * 1024);
  });

  it('says what the file says, not what the renderer remembered: the centroids agree', () => {
    for (const [id, m] of Object.entries(CLIP_MEASUREMENTS)) {
      const wav = readWav(path.join(AUDIO_DIR, `${id}.wav`));
      const mine = centroidOf(wav.samples, wav.sampleRate);
      const off = (Math.abs(mine - m.centroidHz) / mine) * 100;
      expect(off, `${id}: waveforms.ts says ${m.centroidHz} Hz, the file measures ${mine.toFixed(1)} Hz (${off.toFixed(2)} %)`).toBeLessThan(1);
    }
  });

  it('holds each bed loop flat enough that the loop itself is not the thing you hear', () => {
    // MEASURED BEFORE THE FIX: bed-low ran a 5.56 dB arch over its 1.6 s cycle at a 100 ms
    // window (−29.18 dB at 1.34 s up to −23.62 dB at 0.39 s) and bed-high 2.59 dB. The seam was
    // already clean — head and tail matched to 0.19 dB — so the single-sample seam test below
    // passed the whole time, which is exactly why it is not enough on its own. Below ~15° of
    // slip the cross-fade is almost all the dark layer, so that arch WAS the bed.
    for (const id of [BED_LOW, BED_HIGH]) {
      const { samples, sampleRate } = readWav(path.join(AUDIO_DIR, `${id}.wav`));
      const short = loopRmsSpreadDb(samples, sampleRate, 0.1);
      const long = loopRmsSpreadDb(samples, sampleRate, 0.4);
      expect(short, `${id}: 100 ms RMS spans ${short.toFixed(2)} dB around the loop`).toBeLessThan(2);
      expect(long, `${id}: 400 ms RMS spans ${long.toFixed(2)} dB around the loop`).toBeLessThan(1);
    }
  });

  it('loops the two bed layers without a step at the seam', () => {
    for (const id of [BED_LOW, BED_HIGH]) {
      const { samples } = readWav(path.join(AUDIO_DIR, `${id}.wav`));
      const diffs: number[] = [];
      for (let i = 1; i < samples.length; i++) diffs.push(Math.abs(samples[i] - samples[i - 1]));
      diffs.sort((a, b) => a - b);
      const p99 = diffs[Math.floor(diffs.length * 0.99)];
      const seam = Math.abs(samples[samples.length - 1] - samples[0]);
      // The junction must be no worse than an ordinary sample boundary; a click would be tens.
      expect(seam / p99, `${id} loop seam`).toBeLessThan(2);
    }
  });

  it('separates the two bed layers by brightness, which is the whole cross-fade', () => {
    expect(CLIP_MEASUREMENTS[BED_LOW].centroidHz).toBeLessThan(900);
    expect(CLIP_MEASUREMENTS[BED_HIGH].centroidHz).toBeGreaterThan(2000);
  });
});

// ── 3. the mixer ──────────────────────────────────────────────────────────────────────────────
describe('priority and voice stealing', () => {
  it('lets two clips sound at once and refuses a third', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now, maxVoices: 2 });
    feel.attach(r.sound, r.haptic);
    expect(feel.cue('banked')).toBe('played'); // 85
    expect(feel.cue('exit')).toBe('played'); // 65
    // 45 is lower than both, so there is nothing to take.
    expect(feel.cue('long')).toBe('busy');
    expect(r.played).toEqual(['banked', 'exit']);
  });

  it('takes a voice from something strictly lower, and stops it first', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now, maxVoices: 2 });
    feel.attach(r.sound, r.haptic);
    feel.cue('long'); // 45
    feel.cue('lap'); // 40
    expect(feel.cue('spin')).toBe('stole'); // 95 takes the 40
    expect(r.stopped).toEqual(['lap']);
    expect(r.played).toEqual(['long', 'lap', 'spin']);
  });

  it('leaves an equal-priority voice alone: the one already speaking keeps the floor', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now, maxVoices: 2 });
    feel.attach(r.sound, r.haptic);
    feel.cue('long'); // 45
    feel.cue('smooth'); // 45
    expect(feel.cue('speed')).toBe('busy'); // also 45 — no steal
    expect(r.stopped).toEqual([]);
  });

  it('frees a voice once the clip stops being audible, not when the file ends', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now, maxVoices: 2 });
    feel.attach(r.sound, r.haptic);
    feel.cue('banked');
    feel.cue('exit');
    c.state.t = CLIP_MEASUREMENTS.exit.activeS + 0.001;
    // `exit` is over (0.52 s audible of a 0.56 s file) but `banked` (0.86 s) is not.
    expect(feel.cue('long')).toBe('played');
    expect(feel.activeVoices()).toContain('banked');
  });

  it('will not retrigger a clip inside its own length', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now, maxVoices: 4 });
    feel.attach(r.sound, r.haptic);
    expect(feel.cue('transition')).toBe('played');
    c.state.t = 0.3;
    expect(feel.cue('transition')).toBe('debounce');
    // Its own minGap, read from the bank rather than retyped, so widening a row cannot leave a
    // stale number here asserting the old window.
    c.state.t = specFor('transition')!.minGapS + 0.01;
    expect(feel.cue('transition')).toBe('played');
  });
});

describe('the family rules', () => {
  it('lets the spin beat the chain it lost, on the frame they share', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    const completed = { spin: true } as unknown as LiveFrame['completed'];
    feel.frame(frameAt(0, { completed, score: { lost: true } as LiveFrame['score'] }));
    expect(r.played).toEqual(['spin']);
    expect(feel.decisions.some((d) => d.id === 'lost' && d.outcome === 'family' && d.against === 'spin')).toBe(true);
  });

  it('lets LINK beat INITIATION, on the frame they share', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    feel.frame(frameAt(0));
    feel.frame(frameAt(0.01, { phase: 'entry', score: { callouts: [callout('link', 0.01)] } as LiveFrame['score'] }));
    expect(r.played).toEqual(['link']);
    expect(feel.decisions.some((d) => d.id === 'initiation' && d.outcome === 'family')).toBe(true);
  });

  it('lets a flick swallow the entry chirp, because a flick IS an initiation', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    feel.frame(frameAt(0));
    // The detector really does exit and re-enter across a transition, so this frame carries the
    // idle->active edge AND the flick.
    feel.frame(frameAt(0.01, { phase: 'transition' }));
    expect(r.played).toEqual(['transition']);
    expect(feel.decisions.some((d) => d.id === 'initiation' && d.outcome === 'flick')).toBe(true);
  });

  it('says nothing twice for the same instant: the transition callout is silent', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    feel.frame(frameAt(0, { phase: 'drifting' }));
    r.played.length = 0;
    c.state.t = 0.41;
    feel.frame(frameAt(0.41, { phase: 'drifting', score: { callouts: [callout('transition', 0.41)] } as LiveFrame['score'] }));
    expect(r.played).toEqual([]);
  });
});

describe('the settings gate', () => {
  it('is read at the moment of play, so flipping the switch is instant', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    feel.cue('banked');
    expect(r.played).toEqual(['banked']);
    feel.setSettings(false, true);
    c.state.t = 5;
    expect(feel.cue('banked')).toBe('muted');
    expect(r.played).toEqual(['banked']);
    feel.setSettings(true, true);
    c.state.t = 10;
    expect(feel.cue('banked')).toBe('played');
    expect(r.played).toEqual(['banked', 'banked']);
  });

  it('keeps the haptic when the sound is off', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    feel.setSettings(false, true);
    feel.cue('spin');
    expect(r.played).toEqual([]);
    expect(r.haptics).toEqual(['error']);
  });

  it('keeps the sound when the haptics are off', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    feel.setSettings(true, false);
    feel.cue('spin');
    expect(r.played).toEqual(['spin']);
    expect(r.haptics).toEqual([]);
  });

  it('closes the bed the moment sound is switched off', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    for (let i = 0; i < 40; i++) {
      c.state.t = i * 0.05;
      feel.bedFromAngle(40, 0.05);
    }
    expect(feel.bedState().gain).toBeGreaterThan(0.5);
    feel.setSettings(false, true);
    expect(r.beds[r.beds.length - 1]).toEqual([0, 0]);
  });

  it('debounces the haptic even with sound off, so a chattering detector cannot buzz forever', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    feel.setSettings(false, true);
    feel.cue('initiation');
    c.state.t = 0.1;
    expect(feel.cue('initiation')).toBe('debounce');
    expect(r.haptics).toEqual(['heavy']);
  });
});

describe('the belief gate', () => {
  const unbelievable = { mount: 'loose', physics: 'ok', gps: 'good', message: 'loose', believable: false } as LiveFrame['integrity'];

  it('says nothing about a slide the engine does not stand behind', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    feel.frame(frameAt(0, { integrity: unbelievable }));
    c.state.t = 2;
    feel.frame(frameAt(2, { phase: 'entry', integrity: unbelievable }));
    // Nothing about the DRIFT. The one thing it does say is why it is not saying anything.
    expect(r.played.filter((id) => id !== 'fault')).toEqual([]);
    expect(feel.decisions.some((d) => d.outcome === 'gated')).toBe(true);
  });

  it('reports the fault once, and only when the silence has cost something', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    // Ten seconds of a car standing still with a reading nobody believes. The gate drops
    // nothing, because nothing was offered — and a real run spends its first 5 s exactly here,
    // while the calibrator finds forward, so a report on the FLAG would fire on every drive.
    for (let i = 0; i < 1000; i++) {
      c.state.t = i * 0.01;
      feel.frame(frameAt(i * 0.01, { integrity: unbelievable }));
    }
    expect(r.played).toEqual([]);
    expect(r.haptics).toEqual([]);

    // Now a drift the engine will not believe: the cue is dropped and the reason is announced.
    c.state.t = 10;
    feel.frame(frameAt(10, { phase: 'entry', integrity: unbelievable }));
    expect(r.played).toEqual(['fault']);
    expect(r.haptics).toEqual(['warning']);

    // Every drift after it is just as silent, and says so no more than once.
    for (let i = 0; i < 40; i++) {
      c.state.t = 11 + i;
      feel.frame(frameAt(11 + i, { phase: i % 2 ? 'entry' : 'idle', integrity: unbelievable }));
    }
    expect(r.played).toEqual(['fault']);
    expect(r.haptics).toEqual(['warning']);
  });

  it('says when the engine believes it again, and never otherwise', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    // A believable run never hears either half of the pair, however long it goes on.
    for (let i = 0; i < 200; i++) {
      c.state.t = i * 0.05;
      feel.frame(frameAt(i * 0.05));
    }
    expect(r.played).not.toContain('fault');
    expect(r.played).not.toContain('recovered');

    c.state.t = 20;
    feel.frame(frameAt(20, { phase: 'entry', integrity: unbelievable }));
    expect(r.played).toContain('fault');
    r.played.length = 0;
    r.haptics.length = 0;

    c.state.t = 25;
    feel.frame(frameAt(25));
    expect(r.played).toEqual(['recovered']);
    expect(r.haptics).toEqual(['success']);

    // And it does not chatter while the run stays believed.
    for (let i = 0; i < 100; i++) {
      c.state.t = 26 + i * 0.05;
      feel.frame(frameAt(26 + i * 0.05));
    }
    expect(r.played).toEqual(['recovered']);
  });

  it('reads the engine\'s own flag rather than the scorer\'s per-sample gate', () => {
    // `score.counting` is false at every red light and between every pair of slides, and a
    // BANKED lands about two seconds after a drift ends. Gating on it would swallow the loudest
    // moment in the run, so this asserts a bank is heard with `counting: false`.
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    feel.frame(frameAt(0, { score: { counting: false, banked: true } as LiveFrame['score'] }));
    expect(r.played).toEqual(['banked']);
  });

  it('still announces the facts that are true whether or not a slide is believed', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    feel.frame(frameAt(0, { integrity: unbelievable, lap: { count: 1, progress: 0, completed: { index: 0 } } as LiveFrame['lap'] }));
    expect(r.played).toEqual(['lap']);
    // And a control the driver pressed always answers.
    expect(feel.cue('stop')).toBe('played');
  });
});

describe('the continuous layer', () => {
  it('stays shut while nothing is sliding', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    for (let i = 0; i < 50; i++) {
      c.state.t = i * 0.01;
      feel.frame(frameAt(i * 0.01));
    }
    expect(feel.bedState().gain).toBeLessThan(0.005);
    expect(r.beds.every(([lo, hi]) => lo === 0 && hi === 0)).toBe(true);
  });

  it('opens with |β| and cross-fades from the dark layer to the bright one', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    const settle = (deg: number) => {
      for (let i = 0; i < 80; i++) {
        c.state.t += 0.05;
        feel.bedFromAngle(deg, 0.05);
      }
      return feel.bedState();
    };
    const small = settle(12);
    const big = settle(50);
    expect(small.gain).toBeGreaterThan(0.1);
    expect(big.gain).toBeGreaterThan(small.gain);
    // At 12 degrees it is almost all the dark layer; at 50 almost all the bright one.
    expect(small.low).toBeGreaterThan(small.high);
    expect(big.high).toBeGreaterThan(big.low);
    // Equal power: the pair's energy is the overall gain, at every mix position.
    // (against the values the PORT was given, which lag the envelope by up to the push epsilon)
    for (const s of [small, big]) expect(Math.hypot(s.low, s.high)).toBeCloseTo(s.gain * 0.85, 1);
  });

  it('never becomes a drone: it shuts when the slide ends', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    for (let i = 0; i < 60; i++) {
      c.state.t += 0.05;
      feel.bedFromAngle(45, 0.05);
    }
    expect(feel.bedState().gain).toBeGreaterThan(0.6);
    for (let i = 0; i < 60; i++) {
      c.state.t += 0.05;
      feel.bedFromAngle(0, 0.05, false);
    }
    expect(feel.bedState().gain).toBeLessThan(0.005);
    expect(r.beds[r.beds.length - 1]).toEqual([0, 0]);
  });

  it('is scaled by the same trust the drive display dims its glow by', () => {
    // Two channels, one question. The glow multiplies its target by `trustIn`; the bed used to
    // be a plain open/closed, so on a suspect mount or through a dropout the screen said 65 %
    // and the bed said 100 %. There is now one implementation and both read it.
    const degraded = { mount: 'suspect', physics: 'ok', gps: 'good', message: '', believable: true } as LiveFrame['integrity'];
    expect(trustIn(degraded)).toBe(0.65);
    expect(trustIn({ ...degraded, mount: 'rigid' })).toBe(1);
    expect(trustIn({ ...degraded, gps: 'poor' })).toBe(0.65);
    expect(trustIn({ ...degraded, gps: 'none' })).toBe(0.65);
    expect(trustIn({ ...degraded, believable: false })).toBe(0);

    const settle = (integrity: LiveFrame['integrity']) => {
      const c = clock();
      const r = recorder();
      const feel = new DriftFeel({ now: c.now });
      feel.attach(r.sound, r.haptic);
      for (let i = 0; i < 200; i++) {
        c.state.t = i * 0.05;
        feel.frame(frameAt(i * 0.05, { phase: 'drifting', state: { beta: 50 * (Math.PI / 180), speed: 20, valid: true } as LiveFrame['state'], integrity }));
      }
      return feel.bedState().gain;
    };
    const full = settle({ mount: 'rigid', physics: 'ok', gps: 'good', message: '', believable: true });
    const dim = settle(degraded);
    expect(full).toBeGreaterThan(0.5);
    expect(dim / full).toBeCloseTo(0.65, 2);
  });

  it('ducks itself under a loud cue, and only its own layer', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    for (let i = 0; i < 80; i++) {
      c.state.t += 0.05;
      feel.bedFromAngle(45, 0.05);
    }
    const open = feel.bedState();
    feel.cue('banked');
    c.state.t += 0.05;
    feel.bedFromAngle(45, 0.05);
    const ducked = feel.bedState();
    expect(Math.hypot(ducked.low, ducked.high)).toBeLessThan(Math.hypot(open.low, open.high) * 0.7);
  });
});

describe('a frame stream faster than real time', () => {
  it('is a scrub, not a drive: it tracks the run and says nothing', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    // 100x real time, which is what `?at=` does when it warps the recording at screen open.
    for (let i = 0; i < 400; i++) {
      const ft = i * 0.01;
      c.state.t = ft / 100;
      feel.frame(frameAt(ft, { phase: i % 40 < 20 ? 'drifting' : 'idle' }));
    }
    expect(feel.playback.scrubbing).toBe(true);
    expect(feel.playback.rate).toBeGreaterThan(50);
    // At most the cues inside the first measuring window, before the rate was known.
    expect(r.played.length).toBeLessThanOrEqual(1);
  });

  it('speaks again as soon as the stream returns to real time', () => {
    const c = clock();
    const r = recorder();
    const feel = new DriftFeel({ now: c.now });
    feel.attach(r.sound, r.haptic);
    for (let i = 0; i < 200; i++) {
      const ft = i * 0.01;
      c.state.t = ft / 100;
      feel.frame(frameAt(ft));
    }
    expect(feel.playback.scrubbing).toBe(true);
    let ft = 2;
    for (let i = 0; i < 60; i++) {
      ft += 0.01;
      c.state.t += 0.01;
      feel.frame(frameAt(ft));
    }
    expect(feel.playback.scrubbing).toBe(false);
    r.played.length = 0;
    ft += 0.01;
    c.state.t += 0.01;
    feel.frame(frameAt(ft, { phase: 'drifting' }));
    expect(r.played).toEqual(['initiation']);
  });
});

// ── 4. a real run ─────────────────────────────────────────────────────────────────────────────
describe('a real run, through the real pipeline', () => {
  const ACTIVE = new Set(['entry', 'drifting', 'transition']);

  /** A full run at a given track/seed/laps, with what was played and where the spins were. */
  function replay(track: TrackId, seed: number, laps: number) {
    const run = simulateRun(track, { seed, laps });
    const pipe = new DriftPipeline({ id: 's', name: 's', startedAt: 0 });
    const at: Array<{ id: SoundId; t: number }> = [];
    const spins: number[] = [];
    let t = 0;
    const feel = new DriftFeel({ now: () => t, maxVoices: 2, log: false });
    feel.attach({ play: (id: string) => (at.push({ id: id as SoundId, t }), true), stop: () => {}, setBed: () => {} }, { impact: () => {}, notify: () => {} });
    feel.setSettings(true, true);
    let gi = 0;
    for (const m of run.motion) {
      while (gi < run.gps.length && run.gps[gi].t <= m.t) pipe.pushGps(run.gps[gi++]);
      const f = pipe.pushMotion(m);
      t = f.t;
      if (f.completed?.spin && f.score.lost) spins.push(f.t);
      feel.frame(f);
    }
    return { at, spins };
  }

  /**
   * Push a simulated run through the engine and the feel layer at 1x, and record what the
   * driver would have heard, what they would have felt, and where the slides ended.
   */
  function drive(opts: Parameters<typeof simulateRun>[1] & { track?: TrackId } = {}) {
    const { track = 'harbor', ...rest } = opts;
    const run = simulateRun(track, { seed: 1, laps: 1, ...rest });
    const pipe = new DriftPipeline({ id: 't', name: 't', startedAt: 0 });
    const r = recorder();
    let frameT = 0;
    const feel = new DriftFeel({ now: () => frameT, maxVoices: 2 });
    feel.setSettings(true, true);
    const at: Array<{ id: SoundId; t: number }> = [];
    /** Everything the driver notices: a clip starting, or a haptic firing. */
    const beats: Array<{ t: number; what: string; heard: boolean }> = [];
    const sound = {
      play(id: string) {
        at.push({ id: id as SoundId, t: frameT });
        beats.push({ t: frameT, what: id, heard: true });
        return r.sound.play(id);
      },
      stop: r.sound.stop,
      setBed: r.sound.setBed,
    };
    const haptic = {
      impact(shape: string) {
        beats.push({ t: frameT, what: shape, heard: false });
        r.haptic.impact(shape);
      },
      notify(shape: string) {
        beats.push({ t: frameT, what: shape, heard: false });
        r.haptic.notify(shape);
      },
    };
    feel.attach(sound, haptic);
    let gi = 0;
    let prevPhase = 'idle';
    let drifts = 0;
    const exits: Array<{ t: number; believable: boolean }> = [];
    for (const m of run.motion) {
      while (gi < run.gps.length && run.gps[gi].t <= m.t) pipe.pushGps(run.gps[gi++]);
      const f = pipe.pushMotion(m);
      frameT = f.t;
      feel.frame(f);
      const active = ACTIVE.has(f.phase);
      if (!active && ACTIVE.has(prevPhase)) exits.push({ t: f.t, believable: f.integrity.believable });
      if (f.completed !== null) drifts++;
      prevPhase = f.phase;
    }
    return { feel, r, at, beats, exits, drifts };
  }

  it('speaks about a run it believes', () => {
    const { at, r } = drive({});
    expect(at.length).toBeGreaterThan(8);
    expect(new Set(at.map((x) => x.id)).size).toBeGreaterThanOrEqual(5);
    expect(r.haptics.length).toBeGreaterThan(4);
  });

  it('says nothing about the DRIFTS of a hand-held recording, and says why once', () => {
    // THE OLD VERSION OF THIS TEST WAS WEAKER THAN IT READ. It asserted `at == []` on a 1-lap
    // fixture that happens never to close a lap gate, so "says nothing at all" was partly the
    // fixture's doing rather than the gate's. Two laps close two gates, and the ungated lap ping
    // is supposed to sound through a fault — so the assertion is now specific about which
    // silence is the design and which would be a bug.
    const { at, r, feel, beats } = drive({ laps: 2, looseness: 1 });
    expect(feel.stats.cues).toBeGreaterThan(10);

    const drift = at.filter((x) => x.id !== 'fault' && x.id !== 'recovered' && x.id !== 'lap');
    expect(drift, 'not one word about a slide the engine will not stand behind').toEqual([]);
    expect(r.beds.every(([lo, hi]) => lo === 0 && hi === 0)).toBe(true);

    // The lap gate is a fact about the track, true whether or not the slides are believed.
    expect(at.filter((x) => x.id === 'lap').length).toBeGreaterThanOrEqual(1);

    // And the fault itself is reported exactly once, with one warning haptic and nothing else.
    expect(at.filter((x) => x.id === 'fault')).toHaveLength(1);
    expect(r.haptics).toEqual(['warning']);
    const fault = at.find((x) => x.id === 'fault')!;
    expect(fault.t, 'it lands at the first slide, not at the start of the run').toBeGreaterThan(1);
    // Nothing is felt before the fault: the calibrator's first seconds are not an alarm.
    expect(beats.filter((b) => !b.heard && b.t < fault.t)).toEqual([]);
  });

  it('never fires the fault on a run the engine believes', () => {
    for (const track of ['harbor', 'touge'] as TrackId[]) {
      for (const seed of [1, 2, 3]) {
        const { at } = drive({ track, seed, laps: 2 });
        expect(at.map((x) => x.id), `${track} seed ${seed}`).not.toContain('fault');
        expect(at.map((x) => x.id), `${track} seed ${seed}`).not.toContain('recovered');
      }
    }
  });

  it('ends every believed slide with a beat, on both tracks and several seeds', () => {
    // THE MEASUREMENT THIS REPLACES: counting anything played within 1.0 s of an exit phase
    // edge, harbour seed 1 left 3 of 14 edges with nothing, touge seed 7 left 2 of 6, and a
    // timid driver 9 of 21 — because the only exit-family row was bound to the `perfect-exit`
    // callout, which the scorer withholds on most slides. A beat is a clip OR a haptic: the
    // exit's own beat is felt and never heard, which is the point of it.
    const cases: Array<{ track: TrackId; seed: number; laps: number; aggression?: number }> = [
      { track: 'harbor', seed: 1, laps: 2 },
      { track: 'harbor', seed: 2, laps: 2 },
      { track: 'touge', seed: 1, laps: 2 },
      { track: 'touge', seed: 7, laps: 2 },
      { track: 'harbor', seed: 5, laps: 2, aggression: 0.05 },
    ];
    for (const c of cases) {
      const { beats, exits, drifts } = drive(c);
      const believed = exits.filter((e) => e.believable);
      expect(believed.length, `${c.track} s${c.seed} produced no exits to check`).toBeGreaterThan(0);
      for (const e of believed) {
        const within = beats.some((b) => b.t >= e.t - 1e-9 && b.t <= e.t + 1.0);
        expect(within, `${c.track} s${c.seed}: the slide ending at ${e.t.toFixed(2)} s had no beat inside 1.0 s`).toBe(true);
      }
      // And the beat is the light one, at least once per completed drift.
      const light = beats.filter((b) => !b.heard && b.what === 'light').length;
      expect(light, `${c.track} s${c.seed}: ${light} landings felt for ${drifts} drifts`).toBeGreaterThanOrEqual(drifts);
    }
  });

  it('does not stutter through a flick: the landing waits for the car to stay down', () => {
    // 95 of 197 measured exit edges were the dip in the middle of a flick. A beat on each turns
    // a manji into light-medium-light-medium, so the landing is held EXIT_SETTLE_S and cancelled
    // if the car goes again — which means no light beat may ever sit inside that window before a
    // transition.
    const { beats } = drive({ laps: 2 });
    const flicks = beats.filter((b) => b.heard && b.what === 'transition');
    for (const f of flicks) {
      const before = beats.filter((b) => !b.heard && b.what === 'light' && b.t > f.t - EXIT_SETTLE_S && b.t < f.t);
      expect(before, `a landing was felt ${EXIT_SETTLE_S} s before the flick at ${f.t.toFixed(2)} s`).toEqual([]);
    }
    expect(flicks.length, 'this fixture is meant to contain flicks').toBeGreaterThan(0);
  });

  it('keeps the loudest tier for what happens once in a run', () => {
    // The rule `src/ui/callouts.ts` states, applied to LOUDNESS: an event on every drift carries
    // no news, so it cannot also be the loudest sound in the app. `banked` was tier A at
    // 0.75–0.88 plays per drift while `initiation` was tier D at 0.75–1.00 — the same cadence,
    // ten decibels apart, for opposite reasons.
    const cases: Array<{ track: TrackId; seed: number; laps: number }> = [
      { track: 'harbor', seed: 1, laps: 2 },
      { track: 'harbor', seed: 2, laps: 2 },
      { track: 'harbor', seed: 3, laps: 2 },
      { track: 'touge', seed: 1, laps: 2 },
      { track: 'touge', seed: 10, laps: 2 },
    ];
    const perDrift = new Map<SoundId, number>();
    let anyDrifts = 0;
    for (const c of cases) {
      const { at, drifts } = drive(c);
      if (drifts === 0) continue;
      anyDrifts += drifts;
      for (const spec of SOUND_BANK) {
        const rate = at.filter((x) => x.id === spec.id).length / drifts;
        if (rate > (perDrift.get(spec.id) ?? 0)) perDrift.set(spec.id, rate);
      }
    }
    expect(anyDrifts).toBeGreaterThan(20);
    for (const spec of CLIPS) {
      const tier = CLIP_MEASUREMENTS[spec.id].tier;
      const rate = perDrift.get(spec.id) ?? 0;
      if (tier === 'A') {
        expect(rate, `${spec.id} is tier A — the loudest in the bank — but fires ${rate.toFixed(2)} times per drift`).toBeLessThanOrEqual(0.5);
      }
    }
    // The specific regression: BANKED fires on most drifts, so it cannot be tier A.
    expect(perDrift.get('banked') ?? 0).toBeGreaterThan(0.5);
    expect(CLIP_MEASUREMENTS.banked.tier).not.toBe('A');
  });

  it('never lets three clips sound at once, and never lets two start inside 120 ms', () => {
    const { at } = drive({});
    for (let i = 1; i < at.length; i++) {
      // LAP -> CLEAN LAP is the one designed exception: the verdict is built to land about 10 ms
      // behind the gate pings and settle under them, so a clean lap sounds like one event.
      if (at[i - 1].id === 'lap' && at[i].id === 'cleanlap') continue;
      expect(at[i].t - at[i - 1].t, `${at[i - 1].id} then ${at[i].id}`).toBeGreaterThanOrEqual(0.12);
    }
    // Overlap, counted against the clips' own audible lengths.
    for (let i = 0; i < at.length; i++) {
      const sounding = at.filter((x, j) => j <= i && x.t + voiceLifetimeS(x.id) > at[i].t);
      expect(sounding.length, `at ${at[i].t.toFixed(2)} s`).toBeLessThanOrEqual(2);
    }
  });

  it('replays moments that really happened, on the runs the lab names', () => {
    // THE DEFECT CLASS THIS PROJECT HAS BEEN BURNED BY: a screen asserting a measurement that
    // did not occur. `/sound` stated three timings and cited a command for them; one of the
    // three ("65.60 s: CHAIN LOST and SPIN fire on the SAME frame") described a moment on a run
    // that contains no spin at all. `sequences.ts` is generated by the bench now, and this
    // re-derives every entry it holds through the real pipeline.
    expect(SOUND_SEQUENCES.length).toBeGreaterThanOrEqual(3);
    for (const seq of SOUND_SEQUENCES) {
      if (seq.command === '') {
        // The one constructed entry must say so and must not claim a time.
        expect(seq.atS).toBeNull();
        expect(seq.note.toLowerCase()).toContain('constructed');
        continue;
      }
      const m = /bench\.ts (\w+) (\d+) (\d+)/.exec(seq.command);
      expect(m, `${seq.key}: '${seq.command}' is not a runnable bench command`).not.toBeNull();
      const [, track, seed, laps] = m!;
      const { at, spins } = replay(track as TrackId, Number(seed), Number(laps));
      expect(seq.atS).not.toBeNull();
      if (seq.key === 'lost') {
        // Both cues are offered on ONE frame and only the cause is heard, so the sequence is
        // checked against the frame rather than against two plays.
        expect(spins.some((t) => Math.abs(t - seq.atS!) < 0.02), `${seq.command} has no spin at ${seq.atS} s`).toBe(true);
        expect(at.some((x) => x.id === 'spin' && Math.abs(x.t - seq.atS!) < 0.05)).toBe(true);
        expect(at.some((x) => x.id === 'lost' && Math.abs(x.t - seq.atS!) < 0.05), 'the consequence must lose to the cause').toBe(false);
        continue;
      }
      for (const step of seq.steps) {
        const want = seq.atS! + step.atS;
        expect(
          at.some((x) => x.id === step.id && Math.abs(x.t - want) < 0.05),
          `${seq.command}: no ${step.id} at ${want.toFixed(2)} s (the run plays ${at.filter((x) => x.id === step.id).map((x) => x.t.toFixed(2)).join(', ') || 'none'})`,
        ).toBe(true);
      }
    }
  });

  it('keeps the bed inside its update budget', () => {
    const { r } = drive({});
    // 20 Hz ceiling over a 65 s lap, and in practice far under it because the gain has to move.
    expect(r.beds.length).toBeLessThan(65 * 20);
    expect(r.beds.length).toBeGreaterThan(20);
  });
});
