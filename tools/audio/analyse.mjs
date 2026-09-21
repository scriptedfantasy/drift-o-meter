#!/usr/bin/env node
/**
 * Measures the rendered sound bank and draws it.
 *
 *   node tools/audio/analyse.mjs [--dir assets/audio] [--png artifacts/audio/waveforms.png]
 *
 * Reads the committed WAVs back off disk — not the renderer's in-memory buffers — so the numbers
 * describe what actually ships, dither and 16-bit quantisation included. Prints peak, RMS, crest,
 * duration, spectral centroid, DC offset, clipped-sample count and, for the loops, the size of
 * the step at the seam. Then writes a PNG contact sheet of every waveform, tinted in the colour
 * the event wears in `src/ui/callouts.ts`, so the bank can be READ as well as heard.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

import { SAMPLE_RATE, centroid, dB, dcOf, decodeWav, peakOf, rmsOf } from './dsp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The theme colours, duplicated here because `src/ui/theme.ts` is TypeScript and this is a script. */
const TONE_RGB = {
  ember: [0xff, 0x5a, 0x1f],
  cyan: [0x29, 0xe3, 0xff],
  magenta: [0xff, 0x2d, 0x95],
  gold: [0xff, 0xc5, 0x3d],
  green: [0x3d, 0xff, 0x9a],
  red: [0xff, 0x3b, 0x3b],
  muted: [0x8a, 0x93, 0xa6],
};

/**
 * Clip → tone. A DRAWING-only duplication of `src/ui/audio/bank.ts` (this is a script, that is
 * TypeScript), so a clip added to the bank and not to this table would be tinted the wrong
 * colour on the contact sheet without anyone noticing. `measure()` therefore refuses to draw a
 * clip that is not in here, rather than falling back to ember.
 */
const TONES = {
  initiation: 'muted',
  transition: 'magenta',
  manji: 'magenta',
  extreme: 'gold',
  long: 'ember',
  smooth: 'green',
  exit: 'green',
  speed: 'cyan',
  link: 'ember',
  lap: 'cyan',
  cleanlap: 'green',
  banked: 'ember',
  lost: 'red',
  spin: 'red',
  stop: 'muted',
  grade: 'gold',
  'grade-low': 'muted',
  fault: 'red',
  recovered: 'green',
  'bed-low': 'ember',
  'bed-high': 'ember',
};

const ORDER = [
  'initiation',
  'transition',
  'manji',
  'extreme',
  'long',
  'smooth',
  'exit',
  'speed',
  'link',
  'lap',
  'cleanlap',
  'banked',
  'lost',
  'spin',
  'stop',
  'grade',
  'grade-low',
  'fault',
  'recovered',
  'bed-low',
  'bed-high',
];

function measure(file) {
  const { samples, sampleRate, channels } = decodeWav(readFileSync(file));
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= 32767 / 32768) clipped++;
  const peak = peakOf(samples);
  const rms = rmsOf(samples);
  // For a loop, the step you would hear once per cycle. The absolute size of |last − first| is
  // meaningless on its own: a band-limited signal changes by a certain amount every sample
  // anyway. What matters is whether the junction is an OUTLIER, so it is reported as a multiple
  // of the clip's own 99th-percentile sample-to-sample delta. ~1 means the loop point is
  // indistinguishable from any other sample boundary; a click would be tens.
  const diffs = new Float64Array(Math.max(1, samples.length - 1));
  for (let i = 1; i < samples.length; i++) diffs[i - 1] = Math.abs(samples[i] - samples[i - 1]);
  const sorted = Float64Array.from(diffs).sort();
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 1e-9;
  const seam = Math.abs(samples[samples.length - 1] - samples[0]) / p99;
  return {
    samples,
    sampleRate,
    channels,
    bytes: readFileSync(file).length,
    durationS: samples.length / sampleRate,
    peak,
    rms,
    crestDb: dB(peak) - dB(rms),
    centroidHz: centroid(samples),
    dc: dcOf(samples),
    clipped,
    seam,
  };
}

// ── drawing ──────────────────────────────────────────────────────────────────────────────────
const BG = [0x07, 0x09, 0x0d];
const PANEL = [0x0e, 0x12, 0x18];
const LINE = [0x23, 0x2b, 0x37];

function px(png, x, y, rgb, a = 1) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (png.width * y + x) << 2;
  png.data[i] = Math.round(png.data[i] * (1 - a) + rgb[0] * a);
  png.data[i + 1] = Math.round(png.data[i + 1] * (1 - a) + rgb[1] * a);
  png.data[i + 2] = Math.round(png.data[i + 2] * (1 - a) + rgb[2] * a);
  png.data[i + 3] = 255;
}

function rect(png, x, y, w, h, rgb, a = 1) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(png, i, j, rgb, a);
}

/** 5×7 bitmap font, enough for the labels on a contact sheet. */
const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '11110', '10001', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
  F: ['11111', '10000', '11110', '10000', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '11111', '10001', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '11100', '10010', '10010', '10001', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '01110', '00001', '00001', '10001', '01110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '·': ['00000', '00000', '00000', '01100', '01100', '00000', '00000'],
};

function text(png, str, x, y, rgb, scale = 1) {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const g = GLYPHS[ch] ?? GLYPHS[' '];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (g[r][c] === '1') rect(png, cx + c * scale, y + r * scale, scale, scale, rgb);
      }
    }
    cx += 6 * scale;
  }
  return cx;
}

/** dBFS -> 0..1, with -60 dBFS at the centre line and 0 dBFS at the edge. */
function dbNorm(db) {
  return Math.max(0, Math.min(1, 1 + db / 60));
}

function drawSheet(rows, outPath) {
  const W = 1040;
  const ROW_H = 88;
  const PAD = 16;
  const H = PAD * 2 + rows.length * ROW_H + 40;
  const png = new PNG({ width: W, height: H });
  rect(png, 0, 0, W, H, BG);
  text(png, 'DRIFT-O-METER SOUND BANK', PAD, PAD, [0xf2, 0xf0, 0xeb], 2);
  text(png, `${rows.length} CLIPS  ${SAMPLE_RATE / 1000}KHZ 16BIT MONO  VERTICAL SCALE DBFS: EDGE 0  DOTS -6 -20 -40  CENTRE -60`, PAD + 330, PAD + 4, TONE_RGB.muted, 1);

  rows.forEach((r, k) => {
    const y = PAD + 34 + k * ROW_H;
    const tone = TONE_RGB[TONES[r.id] ?? 'ember'];
    rect(png, PAD, y, W - PAD * 2, ROW_H - 10, PANEL);
    rect(png, PAD, y, 3, ROW_H - 10, tone);

    text(png, r.id.replace('-', '·'), PAD + 12, y + 8, tone, 2);
    const stats = `${r.durationS.toFixed(3)}S  PEAK ${r.peakDb.toFixed(1)}  RMS ${r.rmsDb.toFixed(1)}  CREST ${r.crestDb.toFixed(1)}  CENTROID ${Math.round(r.centroidHz)}HZ  DC ${(r.dc * 1000).toFixed(3)}E-3  CLIP ${r.clipped}`;
    text(png, stats, PAD + 12, y + 30, TONE_RGB.muted, 1);

    // The waveform, on a dBFS vertical scale: 0 dBFS at the edge, -60 dBFS on the centre line.
    // Linear amplitude is useless on a contact sheet that spans a 25 dB ladder — a -27.9 dBFS
    // clip is 4 % of full scale and draws as a hairline. On this scale the shape of the envelope
    // AND the clip's place in the ladder are both readable, the way a mastering meter shows them.
    const wx = PAD + 12;
    const wy = y + 44;
    const ww = W - PAD * 2 - 24;
    const wh = 30;
    const mid = wy + wh / 2;
    rect(png, wx, Math.round(mid), ww, 1, LINE);
    for (const g of [-6, -20, -40]) {
      const off = Math.round((wh / 2) * dbNorm(g));
      for (let i = 0; i < ww; i += 6) {
        px(png, wx + i, Math.round(mid - off), LINE, 0.8);
        px(png, wx + i, Math.round(mid + off), LINE, 0.8);
      }
    }
    const per = r.samples.length / ww;
    for (let c = 0; c < ww; c++) {
      const a = Math.floor(c * per);
      const b = Math.min(r.samples.length, Math.floor((c + 1) * per));
      let lo = 0;
      let hi = 0;
      for (let i = a; i < b; i++) {
        const v = r.samples[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const top = Math.round(mid - (wh / 2) * dbNorm(dB(hi)));
      const bot = Math.round(mid + (wh / 2) * dbNorm(dB(-lo)));
      for (let j = top; j <= bot; j++) px(png, wx + c, j, tone, 0.9);
    }
  });

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, PNG.sync.write(png));
}

function main() {
  const argv = process.argv.slice(2);
  let dir = path.join(ROOT, 'assets', 'audio');
  let pngPath = path.join(ROOT, 'artifacts', 'audio', 'waveforms.png');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = path.resolve(argv[++i]);
    else if (argv[i] === '--png') pngPath = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }

  const files = readdirSync(dir).filter((f) => f.endsWith('.wav'));
  const ids = ORDER.filter((id) => files.includes(`${id}.wav`)).concat(files.map((f) => f.slice(0, -4)).filter((id) => !ORDER.includes(id)));

  const rows = [];
  let bytes = 0;
  for (const id of ids) {
    if (!TONES[id]) throw new Error(`${id}.wav has no tone in tools/audio/analyse.mjs — add it beside its row in src/ui/audio/bank.ts`);
    const m = measure(path.join(dir, `${id}.wav`));
    bytes += m.bytes;
    rows.push({ id, ...m, peakDb: dB(m.peak), rmsDb: dB(m.rms) });
  }

  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(
    `\n${pad('clip', 12)} ${pad('tone', 8)} ${padL('dur s', 7)} ${padL('peak dB', 8)} ${padL('rms dB', 8)} ${padL('crest', 6)} ${padL('centroid', 9)} ${padL('DC', 10)} ${padL('clip', 5)} ${padL('seam/p99', 9)} ${padL('KB', 7)}`,
  );
  console.log('-'.repeat(103));
  for (const r of rows) {
    console.log(
      `${pad(r.id, 12)} ${pad(TONES[r.id] ?? '?', 8)} ${padL(r.durationS.toFixed(3), 7)} ${padL(r.peakDb.toFixed(1), 8)} ${padL(r.rmsDb.toFixed(1), 8)} ${padL(r.crestDb.toFixed(1), 6)} ${padL(Math.round(r.centroidHz), 9)} ${padL(r.dc.toExponential(1), 10)} ${padL(r.clipped, 5)} ${padL(r.seam.toFixed(2) + 'x', 9)} ${padL((r.bytes / 1024).toFixed(1), 7)}`,
    );
  }
  console.log('-'.repeat(103));
  const oneShots = rows.filter((r) => !r.id.startsWith('bed-'));
  const loudest = Math.max(...oneShots.map((r) => r.rmsDb));
  const quietest = Math.min(...oneShots.map((r) => r.rmsDb));
  console.log(`${rows.length} clips, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`one-shot RMS ladder: ${quietest.toFixed(1)} dBFS .. ${loudest.toFixed(1)} dBFS  (spread ${(loudest - quietest).toFixed(1)} dB)`);
  console.log(`worst DC offset: ${Math.max(...rows.map((r) => Math.abs(r.dc))).toExponential(1)}   clipped samples: ${rows.reduce((a, r) => a + r.clipped, 0)}`);

  drawSheet(rows, pngPath);
  console.log(`waveform sheet -> ${path.relative(ROOT, pngPath)}`);
}

main();
