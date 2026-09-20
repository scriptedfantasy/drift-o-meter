/**
 * What the mount calibration actually does, measured ACROSS SEEDS.
 *
 *   npx tsx tools/analysis/calibration-sweep.ts            # every section
 *   npx tsx tools/analysis/calibration-sweep.ts ceiling    # one section
 *
 * This file exists because of the correction block in `docs/DESIGN.md`: a ceiling of 0.74 was
 * once written into the design, the harness README and `src/ui/calibrate/model.ts` on the
 * strength of ONE seed, and it was wrong. Any claim about what the calibrator can or cannot
 * reach — and any sentence on the calibration screen that describes its behaviour over time —
 * has to be re-derived here first, over a grid, with the spread printed and not just the best
 * or worst cell.
 *
 * The replay below is the calibration screen's own wiring: `MountCalibrator` first, its output
 * and the raw sample both into `IntegrityMonitor`, the calibration pushed back in as a cue,
 * samples delivered in `SimPlayer`'s order (GPS first on a tie). So the numbers printed here
 * are the numbers `useCalibration` publishes, not an approximation of them.
 */
import { IntegrityMonitor, type MountState } from '../../src/engine/integrity';
import { MountCalibrator } from '../../src/engine/mount';
import { simulateRun, type MountPreset, type TrackId } from '../../src/sim';

export interface Tick {
  /** Seconds since the first motion sample — what the screen calls `elapsedS`. */
  t: number;
  quality: number;
  forwardResolved: boolean;
  calibrationOk: boolean;
  mount: MountState;
  looseScore: number;
  upQuality: number;
}

export interface RunSpec {
  track: TrackId;
  mount: MountPreset;
  seed: number;
  looseness?: number;
  vibration?: number;
  dropouts?: boolean;
  laps?: number;
  aggression?: number;
}

/** Replay a simulated recording through the calibration screen's own pipeline. */
export function replay(spec: RunSpec, snapshotHz = 10): Tick[] {
  const run = simulateRun(spec.track, {
    seed: spec.seed,
    laps: spec.laps ?? 2,
    mount: spec.mount,
    looseness: spec.looseness,
    vibration: spec.vibration,
    gpsDropouts: spec.dropouts,
    aggression: spec.aggression,
  });
  const calibrator = new MountCalibrator();
  const monitor = new IntegrityMonitor();
  const t0 = run.motion[0].t;
  const out: Tick[] = [];
  const period = 1 / snapshotHz;
  let im = 0;
  let ig = 0;
  let due = t0;
  for (;;) {
    const tm = im < run.motion.length ? run.motion[im].t : Infinity;
    const tg = ig < run.gps.length ? run.gps[ig].t : Infinity;
    if (tm === Infinity && tg === Infinity) break;
    if (tg <= tm) {
      const g = run.gps[ig++];
      calibrator.pushGps(g);
      monitor.pushGps(g);
      continue;
    }
    const m = run.motion[im++];
    const vehicle = calibrator.push(m);
    const cal = calibrator.calibration;
    monitor.pushCalibration(cal);
    monitor.pushMotion(m, vehicle);
    if (m.t >= due) {
      due = m.t + period;
      const s = monitor.state;
      out.push({
        t: m.t - t0,
        quality: cal.quality,
        forwardResolved: cal.forwardResolved,
        calibrationOk: s.calibrationOk,
        mount: s.mount,
        looseScore: s.looseScore,
        upQuality: calibrator.diagnostics().upQuality,
      });
    }
  }
  return out;
}

/** The newest tick at or before `t` — what `?at=<t>&hold=1` freezes on. */
export function at(ticks: readonly Tick[], t: number): Tick {
  let best = ticks[0];
  for (const k of ticks) {
    if (k.t > t) break;
    best = k;
  }
  return best;
}

export function peak(ticks: readonly Tick[]): Tick {
  let best = ticks[0];
  for (const k of ticks) if (k.quality > best.quality) best = k;
  return best;
}

const TRACKS: TrackId[] = ['harbor', 'touge'];
const MOUNTS: MountPreset[] = ['portrait-vent', 'landscape-dash', 'flat-console'];
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

function fmt(n: number, d = 3): string {
  return n.toFixed(d).padStart(d + 3);
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(n: number, of: number): string {
  return `${n}/${of} (${Math.round((n / of) * 100)} %)`;
}

/** Peak and final quality over the whole rigid-mount grid at the simulator's default vibration. */
function ceiling(): void {
  console.log('\n=== CEILING — 2 tracks × 3 mounts × 8 seeds, rigid, default vibration ===');
  console.log('track  mount           seed   peak  @ t     final   fwd   ok');
  const peaks: number[] = [];
  for (const track of TRACKS) {
    for (const mount of MOUNTS) {
      for (const seed of SEEDS) {
        const ticks = replay({ track, mount, seed });
        const p = peak(ticks);
        const last = ticks[ticks.length - 1];
        peaks.push(p.quality);
        console.log(
          `${track.padEnd(7)}${mount.padEnd(16)}${String(seed).padEnd(5)}${fmt(p.quality)}  ${p.t.toFixed(1).padStart(5)}s  ${fmt(last.quality)}  ${
            last.forwardResolved ? 'yes' : 'NO '
          }   ${last.calibrationOk ? 'yes' : 'NO'}`,
        );
      }
    }
  }
  peaks.sort((a, b) => a - b);
  console.log(
    `\npeak quality over ${peaks.length} runs: min ${peaks[0].toFixed(3)}  median ${median(peaks).toFixed(3)}  max ${peaks[peaks.length - 1].toFixed(3)}`,
  );
  console.log(`  >= 0.75: ${pct(peaks.filter((q) => q >= 0.75).length, peaks.length)}`);
  console.log(`  >= 0.80: ${pct(peaks.filter((q) => q >= 0.8).length, peaks.length)}`);
}

/** The same grid at four vibration levels: is the default the thing that caps it? */
function vibration(): void {
  console.log('\n=== VIBRATION — the same grid at vibration 0 / 1 / 2 / 3 ===');
  console.log('vib   runs   min   median   max   >=0.75');
  for (const vib of [0, 1, 2, 3]) {
    const peaks: number[] = [];
    for (const track of TRACKS) {
      for (const mount of MOUNTS) {
        for (const seed of SEEDS) peaks.push(peak(replay({ track, mount, seed, vibration: vib })).quality);
      }
    }
    peaks.sort((a, b) => a - b);
    console.log(
      `${String(vib).padEnd(6)}${String(peaks.length).padEnd(7)}${peaks[0].toFixed(3)}  ${median(peaks).toFixed(3)}   ${peaks[peaks.length - 1].toFixed(3)}  ${pct(
        peaks.filter((q) => q >= 0.75).length,
        peaks.length,
      )}`,
    );
  }
}

/**
 * Does the number the screen shows keep improving after the driver leaves?
 * The screen used to promise it does ("the calibration keeps sharpening during the run").
 */
function trajectory(): void {
  console.log('\n=== TRAJECTORY — peak vs final over the rigid grid ===');
  console.log('track  mount           seed   peak  @ t     final   final-peak');
  const deltas: number[] = [];
  const peakTimes: number[] = [];
  let worst = { label: '', d: 0, p: 0, f: 0 };
  for (const track of TRACKS) {
    for (const mount of MOUNTS) {
      for (const seed of SEEDS) {
        const ticks = replay({ track, mount, seed });
        const p = peak(ticks);
        const last = ticks[ticks.length - 1];
        const d = last.quality - p.quality;
        deltas.push(d);
        peakTimes.push(p.t);
        if (d < worst.d) worst = { label: `${track}/${mount}/seed ${seed}`, d, p: p.quality, f: last.quality };
        console.log(
          `${track.padEnd(7)}${mount.padEnd(16)}${String(seed).padEnd(5)}${fmt(p.quality)}  ${p.t.toFixed(1).padStart(5)}s  ${fmt(last.quality)}  ${d >= 0 ? '+' : ''}${d.toFixed(3)}`,
        );
      }
    }
  }
  const below = deltas.filter((d) => d < 0).length;
  peakTimes.sort((a, b) => a - b);
  console.log(`\nfinal BELOW peak in ${pct(below, deltas.length)}   median delta ${median(deltas).toFixed(3)}   worst ${worst.d.toFixed(3)} (${worst.label}: ${worst.p.toFixed(3)} → ${worst.f.toFixed(3)})`);
  console.log(`peak reached between ${peakTimes[0].toFixed(1)} s and ${peakTimes[peakTimes.length - 1].toFixed(1)} s (median ${median(peakTimes).toFixed(1)} s)`);
}

/** A loose mount: can the driver leave and have the run calibrate itself anyway? */
function loose(): void {
  console.log('\n=== LOOSE — does a moving phone ever reach the engine\'s bar? ===');
  console.log('looseness  track  seed   final q   fwd     ever ok   mount@end');
  for (const looseness of [0.5, 0.7, 1]) {
    let everOk = 0;
    let runs = 0;
    const finals: number[] = [];
    for (const track of TRACKS) {
      for (const seed of [1, 2, 3, 4]) {
        const ticks = replay({ track, mount: 'portrait-vent', seed, looseness, dropouts: true });
        const last = ticks[ticks.length - 1];
        // `calibrationOk` is true before the monitor knows anything: only count it once the
        // screen would believe it, i.e. past the 4 s mount warm-up with a resolved axis.
        const ok = ticks.some((k) => k.t >= 4 && k.calibrationOk && k.forwardResolved && k.mount !== 'loose');
        runs++;
        if (ok) everOk++;
        finals.push(last.quality);
        console.log(
          `${String(looseness).padEnd(11)}${track.padEnd(7)}${String(seed).padEnd(5)}${fmt(last.quality)}   ${last.forwardResolved ? 'yes' : 'NO '}     ${
            ok ? 'YES' : 'no '
          }       ${last.mount}`,
        );
      }
    }
    finals.sort((a, b) => a - b);
    console.log(`  looseness ${looseness}: ever calibrated ${pct(everOk, runs)}, final quality ${finals[0].toFixed(3)}–${finals[finals.length - 1].toFixed(3)}`);
  }
}

/**
 * The band the architecture doc warns about: looseness 0.15–0.2 inflates every measured angle
 * by 15–18 % and the sway cues are too small to say 'loose'. What does the screen show there?
 */
function suspect(): void {
  console.log('\n=== SUSPECT BAND — looseness 0.15 / 0.2, the state that reads "calibrated" ===');
  console.log('track  looseness  seed   t=40s: q    mount     fwd   ok');
  for (const [track, looseness] of [
    ['touge', 0.2],
    ['harbor', 0.15],
  ] as Array<[TrackId, number]>) {
    for (const seed of [1, 2, 3, 4]) {
      const ticks = replay({ track, mount: 'portrait-vent', seed, looseness });
      const k = at(ticks, 40);
      console.log(
        `${track.padEnd(7)}${String(looseness).padEnd(11)}${String(seed).padEnd(5)}${fmt(k.quality)}    ${k.mount.padEnd(9)}${k.forwardResolved ? 'yes' : 'NO '}   ${
          k.calibrationOk ? 'yes' : 'NO'
        }`,
      );
    }
  }
}

const SECTIONS: Record<string, () => void> = { ceiling, vibration, trajectory, loose, suspect };

const wanted = process.argv.slice(2).filter((a) => a in SECTIONS);
for (const name of wanted.length ? wanted : Object.keys(SECTIONS)) SECTIONS[name]();
