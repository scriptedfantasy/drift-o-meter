/**
 * Tiny DSP kit for the Drift-O-Meter sound bank.
 *
 * Every sound in `assets/audio/` is synthesised from these primitives by `render.mjs`, so the
 * bank is reviewable as code rather than as a folder of binaries nobody can check. Nothing here
 * is clever: seeded noise, one-pole and biquad filters, envelopes, a few oscillators and a soft
 * clipper. All buffers are plain `Float64Array` at `SAMPLE_RATE`, mono, nominally in ±1.
 */

export const SAMPLE_RATE = 44100;

/** Deterministic PRNG (mulberry32) — the renderer must be byte-for-byte reproducible. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function secondsToSamples(s) {
  return Math.max(1, Math.round(s * SAMPLE_RATE));
}

export function buffer(seconds) {
  return new Float64Array(secondsToSamples(seconds));
}

/** White noise in ±1. */
export function noise(n, seed) {
  const r = rng(seed);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = r() * 2 - 1;
  return out;
}

// ── envelopes ────────────────────────────────────────────────────────────────────────────────
/**
 * Attack / decay envelope with an exponential tail. `curve` > 1 makes the decay snap harder
 * (percussive); 1 is a straight exponential.
 */
export function ad(n, attackS, decayS, curve = 1) {
  const out = new Float64Array(n);
  const a = Math.max(1, Math.round(attackS * SAMPLE_RATE));
  const d = Math.max(1, decayS * SAMPLE_RATE);
  for (let i = 0; i < n; i++) {
    if (i < a) out[i] = i / a;
    else out[i] = Math.exp((-(i - a) / d) * curve);
  }
  return out;
}

/** Linear ramp from `a` to `b` across the buffer, with an optional exponent for the shape. */
export function ramp(n, a, b, shape = 1) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 1 : i / (n - 1);
    out[i] = a + (b - a) * Math.pow(x, shape);
  }
  return out;
}

/** Three-point ramp: `a` → `b` over the first `split` of the buffer, then `b` → `c`. */
export function ramp3(n, a, b, c, split = 0.35, shape = 1) {
  const out = new Float64Array(n);
  const k = Math.max(1, Math.round(n * split));
  for (let i = 0; i < n; i++) {
    if (i < k) out[i] = a + (b - a) * Math.pow(i / k, shape);
    else out[i] = b + (c - b) * Math.pow((i - k) / Math.max(1, n - k), shape);
  }
  return out;
}

/** Fade the last `seconds` of a buffer to zero, so nothing ever ends on a step. */
export function fadeOut(buf, seconds = 0.008) {
  const k = Math.min(buf.length, secondsToSamples(seconds));
  for (let i = 0; i < k; i++) buf[buf.length - 1 - i] *= i / k;
  return buf;
}

/** Fade the first `seconds` in, so nothing ever starts on a step (a click is a DC transient). */
export function fadeIn(buf, seconds = 0.002) {
  const k = Math.min(buf.length, secondsToSamples(seconds));
  for (let i = 0; i < k; i++) buf[i] *= i / k;
  return buf;
}

// ── oscillators ──────────────────────────────────────────────────────────────────────────────
/** Sine at a per-sample frequency (Hz array or constant), phase-continuous. */
export function sine(n, freq, phase0 = 0) {
  const out = new Float64Array(n);
  let p = phase0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(p);
    p += (2 * Math.PI * at(freq, i)) / SAMPLE_RATE;
  }
  return out;
}

/** Band-limited-ish saw (PolyBLEP), for the neon synth stabs. */
export function saw(n, freq, phase0 = 0) {
  const out = new Float64Array(n);
  let p = phase0;
  for (let i = 0; i < n; i++) {
    const f = at(freq, i);
    const dt = f / SAMPLE_RATE;
    let v = 2 * p - 1;
    v -= polyBlep(p, dt);
    out[i] = v;
    p += dt;
    if (p >= 1) p -= 1;
  }
  return out;
}

function polyBlep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Sine FM: carrier `freq`, modulator at `ratio × freq`, index in radians. */
export function fm(n, freq, ratio, index) {
  const out = new Float64Array(n);
  let pc = 0;
  let pm = 0;
  for (let i = 0; i < n; i++) {
    const f = at(freq, i);
    out[i] = Math.sin(pc + at(index, i) * Math.sin(pm));
    pc += (2 * Math.PI * f) / SAMPLE_RATE;
    pm += (2 * Math.PI * f * at(ratio, i)) / SAMPLE_RATE;
  }
  return out;
}

function at(v, i) {
  return typeof v === 'number' ? v : v[Math.min(i, v.length - 1)];
}

// ── filters ──────────────────────────────────────────────────────────────────────────────────
/**
 * Transposed-direct-form-II biquad with per-sample cutoff, recomputed every 16 samples so a
 * sweep stays cheap and stable. `type` is 'lp' | 'hp' | 'bp'.
 */
export function biquad(input, type, freq, q = 0.707) {
  const n = input.length;
  const out = new Float64Array(n);
  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a1 = 0;
  let a2 = 0;
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < n; i++) {
    if (i % 16 === 0) {
      const f = Math.min(SAMPLE_RATE * 0.45, Math.max(10, at(freq, i)));
      const qq = Math.max(0.05, at(q, i));
      const w = (2 * Math.PI * f) / SAMPLE_RATE;
      const alpha = Math.sin(w) / (2 * qq);
      const cosw = Math.cos(w);
      const a0 = 1 + alpha;
      if (type === 'lp') {
        b0 = ((1 - cosw) / 2) / a0;
        b1 = (1 - cosw) / a0;
        b2 = b0;
      } else if (type === 'hp') {
        b0 = ((1 + cosw) / 2) / a0;
        b1 = -(1 + cosw) / a0;
        b2 = b0;
      } else {
        b0 = (alpha * qq) / a0;
        b1 = 0;
        b2 = -b0;
      }
      a1 = (-2 * cosw) / a0;
      a2 = (1 - alpha) / a0;
    }
    const x = input[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    out[i] = y;
  }
  return out;
}

/** One-pole high-pass. Used on every finished clip to guarantee no DC offset. */
export function dcBlock(buf, cutoffHz = 28) {
  const k = Math.exp((-2 * Math.PI * cutoffHz) / SAMPLE_RATE);
  let x1 = 0;
  let y1 = 0;
  const out = new Float64Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const y = buf[i] - x1 + k * y1;
    x1 = buf[i];
    y1 = y;
    out[i] = y;
  }
  return out;
}

// ── mixing ───────────────────────────────────────────────────────────────────────────────────
/** `dst += src × gain`, starting at `offsetS` seconds. Out-of-range samples are dropped. */
export function mix(dst, src, gain = 1, offsetS = 0, envelope = null) {
  const off = Math.round(offsetS * SAMPLE_RATE);
  for (let i = 0; i < src.length; i++) {
    const j = i + off;
    if (j < 0 || j >= dst.length) continue;
    dst[j] += src[i] * gain * (envelope ? at(envelope, i) : 1);
  }
  return dst;
}

/** Multiply in place by an envelope (array or constant). */
export function apply(buf, envelope) {
  for (let i = 0; i < buf.length; i++) buf[i] *= at(envelope, i);
  return buf;
}

/** Sum of buffers, longest wins. */
export function add(...bufs) {
  const n = Math.max(...bufs.map((b) => b.length));
  const out = new Float64Array(n);
  for (const b of bufs) for (let i = 0; i < b.length; i++) out[i] += b[i];
  return out;
}

/**
 * A short, cheap room: four fixed delays with feedback, low-passed. Enough to stop a clip
 * sounding like it was recorded inside a phone, not enough to smear the transient.
 */
export function room(input, amount = 0.2, sizeS = 0.035, decay = 0.35) {
  if (amount <= 0) return input;
  const taps = [1, 1.37, 1.81, 2.29].map((m) => Math.max(1, Math.round(sizeS * m * SAMPLE_RATE)));
  const out = Float64Array.from(input);
  const wet = new Float64Array(input.length);
  for (const d of taps) {
    let g = decay;
    for (let rep = 1; rep <= 3; rep++) {
      for (let i = d * rep; i < input.length; i++) wet[i] += input[i - d * rep] * g;
      g *= decay;
    }
  }
  const soft = biquad(wet, 'lp', 4200, 0.7);
  for (let i = 0; i < out.length; i++) out[i] += soft[i] * amount * 0.25;
  return out;
}

// ── measurement + levelling ──────────────────────────────────────────────────────────────────
export function peakOf(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

export function rmsOf(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

export function dcOf(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i];
  return s / Math.max(1, buf.length);
}

export const dB = (x) => 20 * Math.log10(Math.max(1e-9, x));
export const fromDb = (db) => Math.pow(10, db / 20);

/** Soft clipper: leaves everything well under `ceiling` untouched, folds peaks into it. */
export function softClip(buf, ceiling) {
  const out = new Float64Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ceiling * Math.tanh(buf[i] / ceiling);
  return out;
}

/**
 * Bring a clip to `rmsTarget` without ever passing `peakCeiling`.
 *
 * Levelling on RMS rather than on peak is the whole point of the tier system in `render.mjs`:
 * peak-normalised clips with different crest factors end up 10–15 dB apart in perceived
 * loudness, which is what "a mix, not a design" means. The soft clipper then holds the ceiling,
 * and three iterations are enough to converge because each pass only changes the RMS by the
 * little the clipper took off.
 */
export function levelTo(buf, rmsTarget, peakCeiling) {
  let out = Float64Array.from(buf);
  for (let pass = 0; pass < 3; pass++) {
    const r = rmsOf(out);
    if (r <= 0) break;
    const g = rmsTarget / r;
    for (let i = 0; i < out.length; i++) out[i] *= g;
    if (peakOf(out) > peakCeiling) out = softClip(out, peakCeiling);
  }
  return out;
}

/**
 * Spectral centroid in Hz — the single number that says "bright" or "dark", which is how the
 * bank's families are meant to separate. Hann-windowed Goertzel-free naive DFT on a decimated
 * magnitude spectrum: the clips are short, so brute force is fine and exact.
 */
export function centroid(buf) {
  const N = 4096;
  const hop = Math.max(1, Math.floor(buf.length / 24));
  let num = 0;
  let den = 0;
  for (let start = 0; start + N <= buf.length || start === 0; start += hop) {
    const frame = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const s = start + i;
      frame[i] = (s < buf.length ? buf[s] : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    }
    const mags = magnitudes(frame);
    for (let k = 1; k < mags.length; k++) {
      const f = (k * SAMPLE_RATE) / N;
      num += f * mags[k];
      den += mags[k];
    }
    if (start + N > buf.length) break;
  }
  return den > 0 ? num / den : 0;
}

/** Real FFT magnitude (radix-2, in-place Cooley-Tukey). `frame.length` must be a power of two. */
export function magnitudes(frame) {
  const n = frame.length;
  const re = Float64Array.from(frame);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  const out = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) out[k] = Math.hypot(re[k], im[k]);
  return out;
}

// ── WAV IO ───────────────────────────────────────────────────────────────────────────────────
/** 16-bit mono PCM WAV. Dithered with a TPDF LSB so the quiet tails do not quantise to steps. */
export function encodeWav(buf, sampleRate = SAMPLE_RATE, seed = 1) {
  const r = rng(seed);
  const n = buf.length;
  const bytes = Buffer.alloc(44 + n * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + n * 2, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const dither = (r() + r() - 1) / 32768;
    const v = Math.max(-1, Math.min(1, buf[i] + dither));
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return bytes;
}

/** Read a 16-bit mono PCM WAV back into floats — used by the analyser and the tests. */
export function decodeWav(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= bytes.length) {
    const id = bytes.toString('ascii', pos, pos + 4);
    const size = bytes.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: bytes.readUInt16LE(pos + 8),
        channels: bytes.readUInt16LE(pos + 10),
        sampleRate: bytes.readUInt32LE(pos + 12),
        bits: bytes.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') {
      data = bytes.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`expected 16-bit PCM, got format ${fmt.format} / ${fmt.bits} bit`);
  const n = Math.floor(data.length / 2 / fmt.channels);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
  return { samples: out, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

/**
 * Down-sample a clip to `count` peak values in 0..1 — the shape the `/sound` lab draws and the
 * only form of the audio that ships inside the JS bundle.
 */
export function peaks(buf, count = 96) {
  const out = new Array(count).fill(0);
  const per = buf.length / count;
  for (let k = 0; k < count; k++) {
    const a = Math.floor(k * per);
    const b = Math.min(buf.length, Math.floor((k + 1) * per));
    let p = 0;
    for (let i = a; i < b; i++) {
      const v = Math.abs(buf[i]);
      if (v > p) p = v;
    }
    out[k] = Math.round(p * 1000) / 1000;
  }
  return out;
}
