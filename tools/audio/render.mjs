#!/usr/bin/env node
/**
 * Renders the Drift-O-Meter sound bank.
 *
 *   node tools/audio/render.mjs [--out assets/audio] [--only id,id]
 *
 * Every clip in `assets/audio/` is SYNTHESISED here — nothing is downloaded, nothing is
 * sampled. The point is that the bank is reviewable the way the rest of the app is: you can
 * read what a sound is made of, change a number and hear the difference, instead of trusting a
 * binary. Output is deterministic (seeded noise), so re-running this reproduces the committed
 * WAVs byte for byte.
 *
 * It also writes `src/ui/audio/waveforms.ts`: the measured level of every clip plus a 96-point
 * peak envelope, which is what the `/sound` lab draws and what the tests assert against. That
 * file is generated — edit this script, not it.
 *
 * ── The world ────────────────────────────────────────────────────────────────────────────────
 * docs/DESIGN.md: night street racing, asphalt black with a blue bias, sodium/ember light, tyre
 * smoke, neon telemetry. So: the drift itself is NOISE (tyres, smoke, air) and the app's verdict
 * on it is SYNTH (neon). Nothing is sampled from a real car, nothing is orchestral, nothing is a
 * game-show chime. Every clip is under a second because the driver is driving.
 *
 * ── The ladder ───────────────────────────────────────────────────────────────────────────────
 * Clips are levelled to an RMS target by TIER, not peak-normalised. Peak normalisation puts a
 * noise burst and a sine 12 dB apart in perceived loudness for the same number on a meter, which
 * is a mix rather than a design. The four tiers ARE the design — how much news the event carries,
 * exactly as `src/ui/callouts.ts` assigns colour by how much news the event carries:
 *
 *   A  −17.0 dBFS RMS   what happens ONCE in a run, or not at all: the spin, the grade
 *   B  −20.5 dBFS RMS   the drift beats: the flick, the gold angle, the exit verdict, the bank,
 *                       the loss
 *   C  −24.0 dBFS RMS   accents: link, long, smooth, speed, the lap gate, the stop
 *   D  −27.5 dBFS RMS   the routine and the asides: the event that fires on EVERY drift
 *                       (initiation) and the two that report on the instrument rather than the
 *                       drive (fault, recovered)
 *   L  −26.0 dBFS RMS   the continuous bed layers, which are under everything by definition
 *
 * TIER A IS A BUDGET, not a compliment. It was measured as being spent wrongly: `banked` is
 * tier A in name only if it fires 0.75–0.88 times per drift — measured through the real pipeline
 * on harbour seeds 1/2/3, 7/6/7 banks over 8 drifts, one every 18.6–21.7 s — which makes the
 * app's loudest sound the one a driver hears 35–40 times in a ten-lap session. `callouts.ts`
 * states the rule ("an event that fires on every drift carries no news") and it applies to
 * loudness exactly as it applies to colour, so BANKED is tier B with the other drift beats and
 * tier A now holds only clips that fire once a run at most. `audio.test.ts` drives real runs and
 * asserts it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SAMPLE_RATE,
  ad,
  add,
  apply,
  biquad,
  buffer,
  centroid,
  dB,
  dcBlock,
  dcOf,
  decodeWav,
  encodeWav,
  fadeIn,
  fadeOut,
  fm,
  fromDb,
  levelTo,
  mix,
  noise,
  peakOf,
  peaks,
  ramp,
  ramp3,
  rmsOf,
  room,
  saw,
  secondsToSamples,
  sine,
} from './dsp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** RMS target and peak ceiling per tier, in dBFS. */
const TIERS = {
  A: { rms: -17.0, peak: -3.0 },
  B: { rms: -20.5, peak: -6.0 },
  C: { rms: -24.0, peak: -9.0 },
  D: { rms: -27.5, peak: -12.0 },
  L: { rms: -26.0, peak: -12.0 },
};

// ── the clips ────────────────────────────────────────────────────────────────────────────────

/** A whip: band-passed noise whose centre flies up and falls back. The sound of a flick. */
function whip(durS, top, seed, q0 = 2, q1 = 6) {
  const n = secondsToSamples(durS);
  const src = noise(n, seed);
  const swept = biquad(src, 'bp', ramp3(n, 380, top, 640, 0.3, 0.7), ramp(n, q0, q1));
  return apply(swept, ad(n, 0.002, durS * 0.22, 1.3));
}

/** A neon stab: three detuned saws through a closing resonant low-pass. */
function stab(durS, freq, openHz, closeHz, q = 2.6) {
  const n = secondsToSamples(durS);
  const raw = add(saw(n, freq), saw(n, freq * 1.006), apply(saw(n, freq * 2), 0.45));
  const filtered = biquad(raw, 'lp', ramp(n, openHz, closeHz, 0.55), q);
  return apply(filtered, ad(n, 0.0015, durS * 0.3, 1.7));
}

/** A struck metallic partial — the glint on gold, never a chime on its own. */
function bell(durS, freq, ratio, index, decay) {
  const n = secondsToSamples(durS);
  const env = ad(n, 0.004, decay, 1.1);
  const idx = new Float64Array(n);
  for (let i = 0; i < n; i++) idx[i] = index * env[i];
  return apply(fm(n, freq, ratio, idx), env);
}

const CLIPS = {
  /**
   * INITIATION — the tyres letting go. Tier D, and deliberately the dullest thing in the bank:
   * it fires on every single drift, so by the rule in `src/ui/callouts.ts` (which paints this
   * one muted for exactly this reason) it carries no news and must not sound like a reward. Dry
   * chirp, low thud, no tail, no pitch anyone could hum.
   */
  initiation: {
    tier: 'D',
    durS: 0.26,
    render() {
      const n = secondsToSamples(0.26);
      const chirp = apply(biquad(noise(n, 101), 'bp', ramp3(n, 900, 1450, 420, 0.22, 0.8), ramp(n, 1.4, 3.6)), ad(n, 0.003, 0.055, 1.6));
      const thud = apply(sine(n, ramp(n, 78, 50, 0.7)), ad(n, 0.002, 0.05, 1.2));
      const scrub = apply(biquad(noise(n, 202), 'bp', 620, 2.2), ad(n, 0.02, 0.085));
      // A second-order band-pass leaks a lot of top end; this clip has to be the DARKEST in the
      // bank (measured centroid, not opinion), so the leak is taken off with a low-pass.
      return biquad(add(apply(chirp, 1.0), apply(thud, 0.85), apply(scrub, 0.3)), 'lp', 1250, 0.7);
    },
  },

  /**
   * TRANSITION — the flick. Tier B and the loudest of the per-drift beats, because the design
   * gives this move its own magenta flash, its own screen shake and its own haptic; the sound
   * has to arrive with them. Whip + crack + a magenta synth stab + a sub drop.
   */
  transition: {
    tier: 'B',
    durS: 0.34,
    render() {
      const out = buffer(0.34);
      mix(out, whip(0.28, 3000, 303), 1.0, 0.0);
      const crackN = secondsToSamples(0.02);
      mix(out, apply(biquad(noise(crackN, 404), 'hp', 2100, 0.8), ad(crackN, 0.0004, 0.004, 1.6)), 0.75, 0);
      mix(out, stab(0.16, 660, 5400, 900, 3.0), 0.5, 0.012);
      const subN = secondsToSamples(0.12);
      mix(out, apply(sine(subN, ramp(subN, 150, 58, 0.6)), ad(subN, 0.001, 0.05, 1.5)), 0.55, 0.004);
      return room(out, 0.12);
    },
  },

  /**
   * MANJI — the flick, three times. Same magenta timbre as TRANSITION so the family is obvious,
   * but a triplet with each whip shorter and brighter, resolved by a stab. It fires on the same
   * frame as the third transition callout; the whip for that flick has already sounded 410 ms
   * earlier off the phase edge, so this is the badge landing, not a second copy of the move.
   */
  manji: {
    tier: 'B',
    durS: 0.5,
    render() {
      const out = buffer(0.5);
      mix(out, whip(0.13, 2400, 505), 0.75, 0.0);
      mix(out, whip(0.12, 2950, 606), 0.85, 0.085);
      mix(out, whip(0.12, 3600, 707), 1.0, 0.17);
      mix(out, stab(0.22, 440, 6000, 1150, 3.2), 0.6, 0.185);
      const subN = secondsToSamples(0.14);
      mix(out, apply(sine(subN, ramp(subN, 160, 62, 0.6)), ad(subN, 0.001, 0.06, 1.5)), 0.5, 0.19);
      return room(out, 0.14);
    },
  },

  /**
   * EXTREME ANGLE — gold. Past the point where holding more is remarkable, so it has to feel
   * HOT rather than congratulatory: a resonant sweep climbing, a detuned fifth opening under it,
   * one metallic glint on top. No fanfare; the driver is at 48 degrees and busy.
   */
  extreme: {
    tier: 'B',
    durS: 0.64,
    render() {
      const out = buffer(0.64);
      const n = secondsToSamples(0.34);
      const rise = apply(biquad(noise(n, 808), 'bp', ramp(n, 700, 2600, 0.7), ramp(n, 3, 7)), ad(n, 0.02, 0.12));
      mix(out, rise, 0.75, 0);
      const pn = secondsToSamples(0.5);
      const pad = biquad(add(saw(pn, 330), saw(pn, 331.8), apply(saw(pn, 495), 0.6)), 'lp', ramp(pn, 800, 3000, 0.6), 2.0);
      mix(out, apply(pad, ad(pn, 0.04, 0.2)), 0.7, 0.015);
      mix(out, bell(0.45, 880, 2.76, 3.0, 0.16), 0.45, 0.02);
      return room(out, 0.18);
    },
  },

  /**
   * LONG DRIFT — ember. It is still going. A warm swell with no transient at all, so it reads as
   * "held" rather than "happened": the only clip in the bank with a 45 ms attack.
   */
  long: {
    tier: 'C',
    durS: 0.46,
    render() {
      const n = secondsToSamples(0.46);
      const stack = add(saw(n, 110), saw(n, 110.7), apply(saw(n, 165), 0.55));
      const swell = apply(biquad(stack, 'lp', ramp3(n, 380, 1900, 900, 0.45, 0.8), 2.2), ad(n, 0.045, 0.16));
      const sub = apply(sine(n, 55), ad(n, 0.02, 0.18));
      return room(add(swell, apply(sub, 0.5)), 0.15);
    },
  },

  /**
   * SMOOTH — green. Cleanliness, held steady. Breath and two quiet notes a fifth apart, no
   * attack worth the name. Green in `callouts.ts` means "this was done well", and done well is
   * the absence of drama.
   */
  smooth: {
    tier: 'C',
    durS: 0.42,
    render() {
      const n = secondsToSamples(0.42);
      const a = apply(sine(n, 523.25), ad(n, 0.06, 0.16));
      const b = apply(sine(n, 784), ad(n, 0.08, 0.14));
      const air = apply(biquad(noise(n, 909), 'bp', 3000, 1.2), ad(n, 0.05, 0.1));
      return room(biquad(add(a, apply(b, 0.55), apply(air, 0.14)), 'lp', 4200, 0.7), 0.2);
    },
  },

  /**
   * PERFECT EXIT — green, and the one sound in the bank that resolves DOWNWARD. The slide
   * released cleanly: tyres hooking up (a falling band of noise) and a two-note settle. It fires
   * about 600 ms after the phase edge, which is the scorer's verdict arriving, not the moment
   * the car straightened — the bed's own release covers that.
   */
  exit: {
    tier: 'B',
    durS: 0.56,
    render() {
      const out = buffer(0.56);
      const n = secondsToSamples(0.2);
      mix(out, apply(biquad(noise(n, 111), 'bp', ramp(n, 1800, 320, 0.6), 2.5), ad(n, 0.004, 0.06, 1.4)), 0.55, 0);
      const an = secondsToSamples(0.18);
      mix(out, apply(sine(an, 784), ad(an, 0.005, 0.09, 1.2)), 0.7, 0.01);
      const bn = secondsToSamples(0.42);
      mix(out, apply(sine(bn, 523.25), ad(bn, 0.006, 0.19)), 0.85, 0.1);
      mix(out, apply(sine(bn, 1046.5), ad(bn, 0.008, 0.12)), 0.18, 0.1);
      return room(out, 0.22);
    },
  },

  /**
   * HIGH SPEED — cyan, matching the telemetry it is read beside. Cold air: a resonant band of
   * hiss climbing, one thin sine on top. Nothing warm, nothing low.
   */
  speed: {
    tier: 'C',
    durS: 0.42,
    render() {
      const n = secondsToSamples(0.42);
      const gust = apply(biquad(biquad(noise(n, 1212), 'hp', ramp(n, 900, 3200), 0.8), 'bp', ramp(n, 1400, 4200, 0.7), 3.2), ad(n, 0.015, 0.1));
      const tone = apply(sine(n, 1318.5), ad(n, 0.02, 0.07));
      return room(add(gust, apply(tone, 0.32)), 0.16);
    },
  },

  /**
   * LINK — ember. A chain is building. Two stabs a fourth apart, the second answering the first:
   * the interval IS the meaning, and it is the only two-note rising figure in the bank.
   */
  link: {
    tier: 'C',
    durS: 0.44,
    render() {
      const out = buffer(0.44);
      mix(out, stab(0.2, 196, 4200, 700, 2.5), 1.0, 0);
      mix(out, stab(0.26, 261.6, 4600, 800, 2.5), 1.0, 0.115);
      const sn = secondsToSamples(0.12);
      mix(out, apply(sine(sn, 98), ad(sn, 0.002, 0.06)), 0.4, 0);
      mix(out, apply(sine(sn, 130.8), ad(sn, 0.002, 0.06)), 0.4, 0.115);
      return room(out, 0.18);
    },
  },

  /**
   * LAP — the gate. Two cold pings, a fifth apart, gone in a third of a second. It fires on
   * every lap, so it is Tier C and carries no verdict: the verdict is CLEAN LAP, below.
   */
  lap: {
    tier: 'C',
    durS: 0.36,
    render() {
      const out = buffer(0.36);
      mix(out, bell(0.16, 1046.5, 2.02, 2.2, 0.045), 1.0, 0);
      mix(out, bell(0.24, 1568, 2.02, 2.0, 0.055), 1.0, 0.075);
      return room(out, 0.28);
    },
  },

  /**
   * CLEAN LAP — green, and designed to LAYER over the gate pings rather than replace them: the
   * scorer fires it about 10 ms after the lap closes, so in a run you hear ping-ping and then
   * this settling under it. A soft triad, no transient, so it can never fight the pings.
   */
  cleanlap: {
    tier: 'B',
    durS: 0.8,
    render() {
      const out = buffer(0.8);
      const n = secondsToSamples(0.72);
      mix(out, apply(sine(n, 523.25), ad(n, 0.06, 0.3)), 1.0, 0);
      mix(out, apply(sine(n, 659.25), ad(n, 0.07, 0.28)), 0.7, 0.03);
      mix(out, apply(sine(n, 784), ad(n, 0.08, 0.26)), 0.55, 0.06);
      mix(out, apply(biquad(noise(n, 2626), 'bp', 2600, 1.1), ad(n, 0.07, 0.2)), 0.07, 0);
      return room(biquad(out, 'lp', 5000, 0.7), 0.25);
    },
  },

  /**
   * BANKED — the money. A riser pulling up for 300 ms, a thunk landing on the beat, then a gold
   * shimmer paying out.
   *
   * TIER B, NOT A, and the reason is a measurement rather than a taste. It was tier A — the
   * loudest clip in the bank — until the real pipeline was asked how often it fires: harbour
   * seeds 1/2/3 over two laps bank 7, 6 and 7 times across 8 drifts, 0.75–0.88 per drift, one
   * every 18.6–21.7 s. That is the same cadence as INITIATION (0.75–1.00 per drift), which is
   * the quietest clip in the bank BECAUSE of that cadence. An event on every drift carries no
   * news, and a bank is a drift beat: it sits with the flick, the gold angle and the exit
   * verdict. It is still the brightest, longest figure in tier B, so it still reads as the good
   * news of the run — it just no longer shouts 35–40 times a session.
   */
  banked: {
    tier: 'B',
    durS: 0.9,
    render() {
      const out = buffer(0.9);
      const rn = secondsToSamples(0.3);
      const riseEnv = ramp(rn, 0, 1, 2.2);
      mix(out, apply(biquad(noise(rn, 1313), 'bp', ramp(rn, 300, 2600, 2.0), 4), riseEnv), 0.5, 0);
      mix(out, apply(biquad(saw(rn, ramp(rn, 110, 440, 2.0)), 'lp', 3000, 1.2), riseEnv), 0.35, 0);
      const tn = secondsToSamples(0.24);
      mix(out, apply(sine(tn, ramp(tn, 95, 42, 0.6)), ad(tn, 0.001, 0.09, 1.4)), 1.0, 0.3);
      const cn = secondsToSamples(0.02);
      mix(out, apply(biquad(noise(cn, 1414), 'hp', 1500, 0.8), ad(cn, 0.0004, 0.005, 1.5)), 0.6, 0.3);
      mix(out, bell(0.55, 784, 2.01, 2.5, 0.3), 0.45, 0.31);
      const sn = secondsToSamples(0.4);
      mix(out, apply(sine(sn, 1174.7), ad(sn, 0.01, 0.22)), 0.16, 0.32);
      return room(out, 0.3);
    },
  },

  /**
   * CHAIN LOST — red. The one figure in the bank that slides down a minor third and never
   * resolves: two saws detuned enough to beat against each other, a lowpass closing on them, and
   * a dull thud underneath. Nothing metallic, nothing bright — a loss should not sparkle.
   */
  lost: {
    tier: 'B',
    durS: 0.74,
    render() {
      const out = buffer(0.74);
      const n = secondsToSamples(0.6);
      const pair = add(saw(n, ramp(n, 220, 130, 1.6)), saw(n, ramp(n, 207, 122, 1.6)));
      mix(out, apply(biquad(pair, 'lp', ramp(n, 2600, 350, 0.7), 1.8), ad(n, 0.004, 0.22)), 0.7, 0);
      const hn = secondsToSamples(0.35);
      mix(out, apply(biquad(noise(hn, 1515), 'bp', ramp(hn, 1600, 400, 0.7), 1.2), ad(hn, 0.01, 0.13)), 0.4, 0);
      const tn = secondsToSamples(0.3);
      mix(out, apply(sine(tn, ramp(tn, 70, 40, 0.6)), ad(tn, 0.002, 0.1)), 0.6, 0.3);
      return out;
    },
  },

  /**
   * SPIN — red, Tier A, and the only genuinely unpleasant sound in the bank. A long scrub with
   * the wheel juddering through it (23 Hz amplitude modulation), a squeal falling away, and a
   * crunch at the end. The scorer fires CHAIN LOST on the same frame; the mixer lets this win,
   * because the spin is the cause and the lost chain is only its consequence.
   */
  spin: {
    tier: 'A',
    durS: 0.95,
    render() {
      const out = buffer(0.95);
      const n = secondsToSamples(0.7);
      let scrub = apply(biquad(noise(n, 1616), 'bp', ramp3(n, 1500, 900, 320, 0.4, 0.8), ramp(n, 6, 3)), ad(n, 0.01, 0.35));
      const judder = new Float64Array(n);
      for (let i = 0; i < n; i++) judder[i] = 1 - 0.45 * (0.5 - 0.5 * Math.cos((2 * Math.PI * 23 * i) / SAMPLE_RATE));
      scrub = apply(scrub, judder);
      mix(out, scrub, 1.0, 0);
      mix(out, apply(sine(n, ramp(n, 1900, 700, 0.7)), ad(n, 0.02, 0.2)), 0.16, 0);
      const cn = secondsToSamples(0.45);
      mix(out, apply(biquad(noise(cn, 1717), 'lp', 1800, 0.8), ad(cn, 0.001, 0.12, 1.2)), 0.8, 0.42);
      const bn = secondsToSamples(0.5);
      const low = apply(sine(bn, ramp(bn, 62, 38, 0.6)), ad(bn, 0.002, 0.22));
      for (let i = 0; i < bn; i++) low[i] = Math.tanh(low[i] * 2.4) * 0.5;
      mix(out, low, 0.9, 0.42);
      return out;
    },
  },

  /**
   * STOP — the cut. Not a UI beep: the run ending, the way an engine stops. A click under the
   * thumb, a band of noise falling away and a sub sliding to nothing. Tier C, because STOP is
   * expected — the driver pressed it.
   */
  stop: {
    tier: 'C',
    durS: 0.52,
    render() {
      const out = buffer(0.52);
      const cn = secondsToSamples(0.02);
      mix(out, apply(biquad(noise(cn, 1818), 'hp', 3000, 0.9), ad(cn, 0.0003, 0.004, 1.6)), 0.6, 0);
      const n = secondsToSamples(0.4);
      mix(out, apply(biquad(noise(n, 1919), 'bp', ramp(n, 1400, 260, 0.6), 2.0), ad(n, 0.004, 0.1)), 0.5, 0.004);
      mix(out, apply(sine(n, ramp(n, 128, 42, 0.5)), ad(n, 0.002, 0.1)), 0.9, 0.004);
      return out;
    },
  },

  /**
   * GRADE — the reveal, and the most cinematic 1.6 s in the app. docs/DESIGN.md: letterbox bars
   * close, 900 ms hold on black, the letter SLAMS in with a shockwave ring and ember particles.
   * So: an impact, a shockwave sweeping from 7 kHz down to the floor, and an ember chord blooming
   * behind it with one gold bell. Tier A, longest clip, and the only one that is allowed a tail.
   */
  grade: {
    tier: 'A',
    durS: 1.65,
    render() {
      const out = buffer(1.65);
      const inn = secondsToSamples(0.18);
      mix(out, apply(biquad(noise(inn, 2020), 'lp', 2400, 0.8), ad(inn, 0.001, 0.05, 1.4)), 0.9, 0);
      const dn = secondsToSamples(0.5);
      mix(out, apply(sine(dn, ramp(dn, 140, 36, 2.0)), ad(dn, 0.001, 0.16, 1.1)), 1.0, 0);
      const sn = secondsToSamples(0.5);
      mix(out, apply(biquad(noise(sn, 2121), 'bp', ramp(sn, 7000, 180, 2.2), ramp(sn, 1.2, 4)), ad(sn, 0.004, 0.16)), 0.65, 0.02);
      const chn = secondsToSamples(1.3);
      const chord = add(saw(chn, 98), saw(chn, 98.4), apply(saw(chn, 146.83), 0.8), apply(saw(chn, 196), 0.6));
      mix(out, apply(biquad(chord, 'lp', ramp3(chn, 500, 2600, 1200, 0.25, 0.7), 2.0), ad(chn, 0.06, 0.42)), 0.55, 0.1);
      mix(out, bell(1.3, 783.99, 2.005, 3.0, 0.45), 0.4, 0.12);
      const gn = secondsToSamples(0.9);
      mix(out, apply(sine(gn, 1568), ad(gn, 0.01, 0.3)), 0.12, 0.13);
      return room(out, 0.3);
    },
  },

  /**
   * GRADE LOW — the same reveal, in the dark. C and D only.
   *
   * `src/ui/theme.ts` paints the letter gold for S, ember for A, cyan for B, text for C and
   * MUTED for D, and the results screen draws it in that colour. A single gold fanfare under
   * all five is the one place the feel layer walked away from the discipline in
   * `src/ui/callouts.ts` that the rest of it is built on: on a D the screen said grey and
   * "Rough" while the ear said gold. So below the B threshold the reveal is a SECOND RENDER of
   * the same figure rather than a different sound — same impact, same sub drop, same shockwave,
   * same chord bloom, so the moment still lands — with the gold taken out of it: no bell, no
   * 1568 Hz shimmer, the shockwave swept from 3.4 kHz instead of 7, the chord closed an octave
   * lower and its major octave replaced by a minor third. It is not a sadder sound, it is an
   * unlit one.
   */
  'grade-low': {
    tier: 'A',
    durS: 1.65,
    render() {
      const out = buffer(1.65);
      const inn = secondsToSamples(0.18);
      mix(out, apply(biquad(noise(inn, 2020), 'lp', 1900, 0.8), ad(inn, 0.001, 0.05, 1.4)), 0.9, 0);
      const dn = secondsToSamples(0.5);
      mix(out, apply(sine(dn, ramp(dn, 140, 36, 2.0)), ad(dn, 0.001, 0.16, 1.1)), 1.0, 0);
      const sn = secondsToSamples(0.5);
      mix(out, apply(biquad(noise(sn, 2121), 'bp', ramp(sn, 3400, 150, 2.2), ramp(sn, 1.2, 4)), ad(sn, 0.004, 0.16)), 0.65, 0.02);
      const chn = secondsToSamples(1.3);
      const chord = add(saw(chn, 98), saw(chn, 98.4), apply(saw(chn, 116.54), 0.7), apply(saw(chn, 146.83), 0.6));
      mix(out, apply(biquad(chord, 'lp', ramp3(chn, 400, 1500, 700, 0.25, 0.7), 2.0), ad(chn, 0.06, 0.42)), 0.6, 0.1);
      return room(out, 0.26);
    },
  },

  /**
   * FAULT — the engine has stopped believing the reading, and the feel layer is about to go
   * quiet for a reason.
   *
   * Measured: a hand-held recording (harbour seed 1, 2 laps, looseness 1, GPS dropouts) offers
   * the mixer 56 cues and plays NONE of them, with no haptic either, while the detector is still
   * firing 44 entry edges. Silence is the correct answer to every one of those cues and the
   * wrong answer to the driver, whose eyes are on the road. So one sound reports the CAUSE.
   *
   * It has to be unmistakably not a drift beat: two dull pitched pulses falling a whole tone,
   * through a band of noise that CLOSES — the exact opposite gesture to BANKED's riser — with
   * nothing metallic and nothing bright. Tier D, because it is an aside about the instrument,
   * not news about the driving, and because a fault that shouted would be worse than the silence
   * it replaces. RED, the colour the drive display's own integrity banner wears for a severe
   * fault.
   */
  fault: {
    tier: 'D',
    durS: 0.44,
    render() {
      const out = buffer(0.44);
      const pn = secondsToSamples(0.15);
      const pulse = (f) => apply(biquad(add(saw(pn, f), saw(pn, f * 0.996)), 'lp', 780, 1.1), ad(pn, 0.01, 0.042, 1.2));
      mix(out, pulse(220), 0.95, 0);
      mix(out, pulse(174.61), 0.95, 0.165);
      const nn = secondsToSamples(0.36);
      mix(out, apply(biquad(noise(nn, 3131), 'bp', ramp(nn, 900, 230, 0.8), 1.5), ad(nn, 0.03, 0.11)), 0.28, 0.01);
      return biquad(room(out, 0.1), 'lp', 1900, 0.7);
    },
  },

  /**
   * RECOVERED — its inverse, and the only reason FAULT is allowed to be a latch rather than a
   * nag. The same two pulses the other way up, a whole tone RISING, with the band opening
   * instead of closing. Same tier, same family, same restraint: it says "you can trust what you
   * hear again" and then gets out of the way. GREEN, which in `callouts.ts` is the colour of
   * something being right.
   */
  recovered: {
    tier: 'D',
    durS: 0.44,
    render() {
      const out = buffer(0.44);
      const pn = secondsToSamples(0.15);
      const pulse = (f) => apply(biquad(add(saw(pn, f), saw(pn, f * 0.996)), 'lp', 900, 1.1), ad(pn, 0.01, 0.042, 1.2));
      mix(out, pulse(174.61), 0.95, 0);
      mix(out, pulse(220), 0.95, 0.165);
      const nn = secondsToSamples(0.36);
      mix(out, apply(biquad(noise(nn, 3232), 'bp', ramp(nn, 260, 1000, 1.2), 1.5), ad(nn, 0.06, 0.12)), 0.26, 0.01);
      return biquad(room(out, 0.12), 'lp', 2400, 0.7);
    },
  },

  /**
   * BED LOW — the continuous layer at small angles: a dark tyre scrub with a rumble under it.
   * Every modulation period divides the loop length exactly, and the last 120 ms cross-fades into
   * the head, so the loop has no seam to hear. This is the layer you hear at 10 degrees.
   */
  'bed-low': {
    tier: 'L',
    durS: 1.6,
    loop: true,
    render() {
      const n = secondsToSamples(1.6 + 0.12);
      const centre = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE;
        centre[i] = 260 + 40 * Math.sin(2 * Math.PI * 1.25 * t) + 25 * Math.sin(2 * Math.PI * 2.5 * t + 1.1);
      }
      const scrub = biquad(noise(n, 2222), 'bp', centre, 1.6);
      const body = biquad(noise(n, 2323), 'lp', 500, 0.8);
      const rumble = new Float64Array(n);
      const r55 = sine(n, 55);
      for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE;
        rumble[i] = r55[i] * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.625 * t));
      }
      // Dark by measurement: this layer is what 10 degrees sounds like, so it must sit well
      // below BED HIGH on the spectral centroid or the cross-fade has nothing to travel across.
      return biquad(add(apply(scrub, 1.0), apply(body, 0.45), apply(rumble, 0.28)), 'lp', 850, 0.7);
    },
  },

  /**
   * BED HIGH — the continuous layer at big angles: the same scrub an octave and a half up, more
   * air, and a squeal partial that wanders. Cross-faded against BED LOW by |beta|, which is what
   * makes the bed track the angle without ever changing playback rate (an iOS AVPlayer hiccups
   * when you retune a loop; two layers and a gain pair do not).
   */
  'bed-high': {
    tier: 'L',
    durS: 1.6,
    loop: true,
    render() {
      const n = secondsToSamples(1.6 + 0.12);
      const centre = new Float64Array(n);
      const squealF = new Float64Array(n);
      const squealA = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE;
        centre[i] = 1150 + 180 * Math.sin(2 * Math.PI * 1.875 * t);
        squealF[i] = 2150 + 60 * Math.sin(2 * Math.PI * 3.125 * t);
        squealA[i] = 0.12 + 0.05 * Math.sin(2 * Math.PI * 1.25 * t + 0.6);
      }
      const scrub = biquad(noise(n, 2424), 'bp', centre, 2.2);
      const hiss = biquad(noise(n, 2525), 'hp', 2500, 0.8);
      const squeal = apply(sine(n, squealF), squealA);
      // Bright, but a tyre rather than a cymbal: the hiss is trimmed and the top rolled off so
      // the layer reads as rubber under load.
      return biquad(add(apply(scrub, 1.0), apply(hiss, 0.14), squeal), 'lp', 5200, 0.7);
    },
  },
};

/**
 * How long the clip is actually AUDIBLE: the last instant above -40 dB relative to its own peak.
 *
 * The mixer uses this, not the file length, to decide when a voice is free again. An exponential
 * decay never truly reaches zero, so `extreme` is a 0.64 s file whose last 0.29 s is inaudible —
 * treating the file length as the voice's lifetime would hold a voice hostage for a third of a
 * second of silence and drop cues that should have played.
 */
function activeDuration(buf) {
  const floor = peakOf(buf) * 0.01;
  for (let i = buf.length - 1; i >= 0; i--) if (Math.abs(buf[i]) > floor) return (i + 1) / SAMPLE_RATE;
  return buf.length / SAMPLE_RATE;
}

/** Cross-fade a loop's tail into its head so the seam is inaudible. */
function seamless(buf, loopS, fadeS = 0.12) {
  const n = secondsToSamples(loopS);
  const k = secondsToSamples(fadeS);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf[i];
  for (let i = 0; i < k; i++) {
    const w = i / k;
    out[i] = buf[i] * w + (buf[n + i] ?? 0) * (1 - w);
  }
  return out;
}

/**
 * Flatten a LOOP's short-term level, so the loop stops announcing itself.
 *
 * MEASURED: `bed-low` ran a 5.6 dB arch over its 1.6 s cycle (100 ms circular RMS: −29.2 dB at
 * 1.34 s up to −23.6 dB at 0.39 s) and `bed-high` a 2.6 dB one with a 1.64 dB head-to-tail step.
 * The SEAM was already clean — head and tail matched to 0.19 dB — so this was never a cross-fade
 * problem; it was the loop's own content. Below about 15° of slip the cross-fade is almost
 * entirely the dark layer (at 12°, low:high ≈ 20:1), so a driver holding a modest slide heard a
 * 5 dB swell at 0.625 Hz, over and over. That is the classic loop tell: the thing nobody notices
 * on lap one and nobody can un-notice on lap ten.
 *
 * The correction is a circular gain curve: the moving RMS over `windowS`, computed AROUND the
 * loop rather than along the buffer, divided into the loop's own mean, then smoothed over the
 * same window so it takes out the arch and leaves the grain. Because both passes are circular
 * the curve is continuous across the wrap, which is what keeps the seam the cross-fade produced.
 * Applied BEFORE `levelTo`, so the tier gain is the last word on loudness.
 */
function flattenLoopRms(buf, windowS = 0.1) {
  const n = buf.length;
  const w = Math.min(n, Math.max(2, Math.round(windowS * SAMPLE_RATE)));
  const half = Math.floor(w / 2);
  /** Circular moving mean of `src` over `w` samples, centred. */
  const circularMean = (src) => {
    // Three copies so a centred window can never run off either end, and one prefix sum over it.
    const pre = new Float64Array(3 * n + 1);
    for (let j = 0; j < 3 * n; j++) pre[j + 1] = pre[j] + src[j % n];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = n + i - half;
      out[i] = (pre[a + w] - pre[a]) / w;
    }
    return out;
  };
  const sq = new Float64Array(n);
  for (let i = 0; i < n; i++) sq[i] = buf[i] * buf[i];
  const meanSq = rmsOf(buf) ** 2;
  const local = circularMean(sq);
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = Math.sqrt(meanSq / Math.max(1e-12, local[i]));
  const gain = circularMean(raw);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf[i] * gain[i];
  return out;
}

function renderOne(id, def) {
  let buf = def.render();
  buf = dcBlock(buf);
  if (def.loop) buf = flattenLoopRms(seamless(buf, def.durS));
  else {
    buf = fadeIn(buf, 0.0015);
    buf = fadeOut(buf, 0.012);
  }
  const tier = TIERS[def.tier];
  buf = levelTo(buf, fromDb(tier.rms), fromDb(tier.peak));
  // One last DC guard: the soft clipper is symmetric, but a sub that sweeps through 36 Hz can
  // still leave a measurable mean in a clip this short. Phone speakers do not need the offset.
  //
  // NOT on a loop. `dcBlock` is a stateful IIR that starts from zero, so running it after the
  // cross-fade gives the head a start-up transient the tail does not have — which puts a step
  // back at the seam and a faint tick on every cycle. Loops get their DC removed before the
  // cross-fade instead, and the analyser's seam/p99 column is what proves it worked.
  if (!def.loop) buf = dcBlock(buf, 22);
  // Removing that mean can nudge a peak a few tenths of a dB back over the tier ceiling. A flat
  // gain trim is the transparent way to hold the ceiling exactly; it costs the same few tenths
  // of RMS, which is why the reported RMS sits just under the target rather than exactly on it.
  const ceiling = fromDb(tier.peak);
  const p = peakOf(buf);
  if (p > ceiling) for (let i = 0; i < buf.length; i++) buf[i] *= ceiling / p;
  // A loop that starts or ends on a non-zero sample clicks once per cycle; the cross-fade above
  // already guarantees continuity, so only one-shots get the final guard.
  if (!def.loop) fadeOut(buf, 0.008);
  return buf;
}

function main() {
  const argv = process.argv.slice(2);
  let outDir = path.join(ROOT, 'assets', 'audio');
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outDir = path.resolve(argv[++i]);
    else if (argv[i] === '--only') only = argv[++i].split(',').map((s) => s.trim());
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  mkdirSync(outDir, { recursive: true });

  const ids = Object.keys(CLIPS).filter((id) => !only || only.includes(id));
  const rows = [];
  let totalBytes = 0;
  for (const id of ids) {
    const def = CLIPS[id];
    const buf = renderOne(id, def);
    const wav = encodeWav(buf, SAMPLE_RATE, 7777);
    const file = path.join(outDir, `${id}.wav`);
    writeFileSync(file, wav);
    totalBytes += wav.length;
    // MEASURE THE FILE, NOT THE BUFFER. `waveforms.ts` is read by the app and by the `/sound`
    // lab as a description of what ships, and what ships is 16-bit dithered PCM — not the
    // float buffer above it. Measuring `buf` put this file and `tools/audio/analyse.mjs` (which
    // reads the committed WAVs) 7 % apart on the spectral centroid of the quietest clip
    // (initiation 844 vs 903 Hz), because broadband TPDF dither is a bigger share of a
    // −27.9 dBFS clip than of a −17 dBFS one. Same `centroid()`, different signal. Decoding the
    // bytes back makes the two agree by construction rather than by luck, and it is the same
    // decoder `analyse.mjs` and the app's asset pipeline see.
    const shipped = decodeWav(wav).samples;
    rows.push({
      id,
      tier: def.tier,
      loop: !!def.loop,
      durationS: Math.round((shipped.length / SAMPLE_RATE) * 1000) / 1000,
      bytes: wav.length,
      activeS: Math.round(activeDuration(shipped) * 1000) / 1000,
      peakDb: Math.round(dB(peakOf(shipped)) * 10) / 10,
      rmsDb: Math.round(dB(rmsOf(shipped)) * 10) / 10,
      dc: Math.round(dcOf(shipped) * 1e6) / 1e6,
      centroidHz: Math.round(centroid(shipped)),
      peaks: peaks(shipped, 96),
    });
  }

  writeTypescript(rows, totalBytes);

  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(`\n${pad('clip', 12)} ${pad('tier', 5)} ${padL('dur s', 7)} ${padL('peak dB', 8)} ${padL('rms dB', 7)} ${padL('centroid', 9)} ${padL('DC', 10)} ${padL('KB', 7)}`);
  console.log('-'.repeat(72));
  for (const r of rows) {
    console.log(
      `${pad(r.id, 12)} ${pad(r.tier + (r.loop ? '·loop' : ''), 5)} ${padL(r.durationS.toFixed(3), 7)} ${padL(r.peakDb.toFixed(1), 8)} ${padL(r.rmsDb.toFixed(1), 7)} ${padL(r.centroidHz, 9)} ${padL(r.dc.toExponential(1), 10)} ${padL((r.bytes / 1024).toFixed(1), 7)}`,
    );
  }
  console.log('-'.repeat(72));
  console.log(`${rows.length} clips, ${(totalBytes / 1024 / 1024).toFixed(2)} MB total -> ${path.relative(ROOT, outDir)}/`);
  console.log(`waveform table -> src/ui/audio/waveforms.ts`);
}

function writeTypescript(rows, totalBytes) {
  const lines = [];
  lines.push('/**');
  lines.push(' * GENERATED by `node tools/audio/render.mjs` — do not edit by hand.');
  lines.push(' *');
  lines.push(' * The measured level of every clip in `assets/audio/`, plus a 96-point peak envelope.');
  lines.push(' * The `/sound` lab draws these envelopes, and `audio.test.ts` asserts that they still match');
  lines.push(' * the WAVs on disk — so this file is also the tripwire for someone changing a sound and');
  lines.push(' * forgetting to re-render, or re-rendering and forgetting to commit.');
  lines.push(' *');
  lines.push(` * ${rows.length} clips, ${(totalBytes / 1024 / 1024).toFixed(2)} MB of 16-bit ${SAMPLE_RATE / 1000} kHz mono PCM.`);
  lines.push(' */');
  lines.push('');
  lines.push('export interface ClipMeasurement {');
  lines.push('  /** Loudness tier the renderer levelled this clip to (see tools/audio/render.mjs). */');
  lines.push("  tier: 'A' | 'B' | 'C' | 'D' | 'L';");
  lines.push('  durationS: number;');
  lines.push('  /** Last instant above -40 dB relative to the clip\'s own peak: the voice\'s real lifetime. */');
  lines.push('  activeS: number;');
  lines.push('  /** dBFS. */');
  lines.push('  peakDb: number;');
  lines.push('  rmsDb: number;');
  lines.push('  /** Spectral centroid in Hz: the one number that says "bright" or "dark". */');
  lines.push('  centroidHz: number;');
  lines.push('  bytes: number;');
  lines.push('  /** 96 peak values in 0..1, oldest first. */');
  lines.push('  peaks: number[];');
  lines.push('}');
  lines.push('');
  lines.push('export const CLIP_MEASUREMENTS: Record<string, ClipMeasurement> = {');
  for (const r of rows) {
    lines.push(`  '${r.id}': {`);
    lines.push(`    tier: '${r.tier}',`);
    lines.push(`    durationS: ${r.durationS},`);
    lines.push(`    activeS: ${r.activeS},`);
    lines.push(`    peakDb: ${r.peakDb},`);
    lines.push(`    rmsDb: ${r.rmsDb},`);
    lines.push(`    centroidHz: ${r.centroidHz},`);
    lines.push(`    bytes: ${r.bytes},`);
    lines.push(`    peaks: [${r.peaks.join(', ')}],`);
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  lines.push('/** RMS target and peak ceiling per tier, dBFS, as rendered. */');
  lines.push('export const TIER_TARGETS: Record<string, { rms: number; peak: number }> = {');
  for (const [k, v] of Object.entries(TIERS)) lines.push(`  ${k}: { rms: ${v.rms}, peak: ${v.peak} },`);
  lines.push('};');
  lines.push('');
  writeFileSync(path.join(ROOT, 'src', 'ui', 'audio', 'waveforms.ts'), lines.join('\n'));
}

main();
