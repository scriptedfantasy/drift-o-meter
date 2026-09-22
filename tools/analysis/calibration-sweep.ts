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
import { cautionsOf, headlineOf, leaveOf, lightsOf, mountVerdict, phaseOf } from '../../src/ui/calibrate/model';
import { replayReadings } from '../../src/ui/calibrate/testkit';

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
  console.log('NOTE: final-vs-peak is not the question the READY footer asks. See `ready` below,');
  console.log('      which measures from the frame the footer is first READ.');
}

/**
 * THE FOOTER'S CLAIM, MEASURED WHERE IT IS READ.
 *
 * `trajectory` above compares FINAL to PEAK, and the screen turned that into "it peaks seconds
 * after you drive off, and never climbs later" — a sentence read at FIRST READY. Those are
 * different questions: first READY lands before the peak does, so the number climbs under the
 * word "never". This section reads the actual rendered string on every READY frame and checks
 * it against the run up to that instant.
 */
function ready(): void {
  console.log('\n=== READY FOOTER — what the sentence claims, on the frame it is read ===');
  console.log('track  mount           seed   1st READY   q there   peak after   climb   band flips');
  let climbs = 0;
  let c05 = 0;
  let c10 = 0;
  let flips = 0;
  let runs = 0;
  let wrong = 0;
  let readyFrames = 0;
  const firsts: number[] = [];
  let worst = { d: 0, label: '', a: 0, ta: 0, b: 0, tb: 0 };
  for (const track of TRACKS) {
    for (const mount of MOUNTS) {
      for (const seed of SEEDS) {
        const frames = replayReadings({ track, mount, seed }, 50);
        const i = frames.findIndex((f) => phaseOf(f.reading) === 'ready');
        if (i < 0) {
          console.log(`${track.padEnd(7)}${mount.padEnd(16)}${String(seed).padEnd(5)}   never READY`);
          continue;
        }
        runs++;
        firsts.push(frames[i].t);
        const qThere = frames[i].reading.quality;
        let best = frames[i];
        const bands = new Set<string>();
        let seen = 0;
        for (let k = 0; k < frames.length; k++) {
          const r = frames[k].reading;
          if (r.quality > seen) seen = r.quality;
          if (phaseOf(r) !== 'ready') continue;
          readyFrames++;
          bands.add(headlineOf(r).color);
          // the footer's number must be the best the calibration has reached BY THIS FRAME
          const claimed = leaveOf(r).note.match(/^Best so far (\d+)%/);
          if (!claimed || Number(claimed[1]) !== Math.round(seen * 100)) wrong++;
          if (k >= i && r.quality > best.reading.quality) best = frames[k];
        }
        const d = best.reading.quality - qThere;
        if (d > 1e-9) climbs++;
        if (d >= 0.05) c05++;
        if (d >= 0.1) c10++;
        if (bands.size > 1) flips++;
        if (d > worst.d) worst = { d, label: `${track}/${mount}/seed ${seed}`, a: qThere, ta: frames[i].t, b: best.reading.quality, tb: best.t };
        console.log(
          `${track.padEnd(7)}${mount.padEnd(16)}${String(seed).padEnd(5)}${frames[i].t.toFixed(1).padStart(8)}s${fmt(qThere)}${fmt(best.reading.quality)}      ${
            d > 0 ? '+' : ' '
          }${d.toFixed(3)}   ${bands.size > 1 ? 'YES' : 'no '}`,
        );
      }
    }
  }
  firsts.sort((a, b) => a - b);
  console.log(`\nfirst READY ${firsts[0].toFixed(1)}–${firsts[firsts.length - 1].toFixed(1)} s (median ${median(firsts).toFixed(1)} s)`);
  console.log(`quality CLIMBS after the sentence is read in ${pct(climbs, runs)}; >= 0.05 in ${climbs ? c05 : 0}; >= 0.10 in ${c10}; worst +${worst.d.toFixed(3)} (${worst.label}: ${worst.a.toFixed(3)} @ ${worst.ta.toFixed(1)} s → ${worst.b.toFixed(3)} @ ${worst.tb.toFixed(1)} s)`);
  console.log(`headline colour changes while READY in ${pct(flips, runs)}`);
  console.log(`READY frames whose footer misstated the running peak: ${wrong} of ${readyFrames}`);
}

/**
 * EVERY ROW THIS SCREEN HEADS WITH THE MOUNT, and what it actually printed underneath.
 *
 * The severity-1: `IntegrityMonitor.message` is the ROOT CAUSE, so a mount-titled banner
 * quoting it printed a forward-axis sentence 100 % of the time and a GPS sentence under MOUNT
 * SHAKING 2.7 % of the time. This counts the rendered strings.
 *
 * The screen has since taken the sentence off both rows — the headline's reason line is gone
 * and the mount caution is a heading alone — so an empty body is a PASS here: a row with
 * nothing under it cannot be about the wrong topic, which is the strongest form of the fix.
 */
function rows(): void {
  console.log('\n=== MOUNT-TITLED ROWS — is the body about the mount? ===');
  const MOUNT_SENTENCES = new Set([
    'Phone looks hand-held — clip it into a rigid mount to score drifts',
    'Phone is moving in its mount — tighten it',
    'Phone may be shifting in its mount — check it is tight',
  ]);
  const bodies = new Map<string, number>();
  let total = 0;
  let aboutMount = 0;
  for (const track of TRACKS) {
    for (const mount of MOUNTS) {
      for (const seed of [1, 2, 3, 4]) {
        for (const looseness of [0, 0.15, 0.2, 0.25]) {
          for (const f of replayReadings({ track, mount, seed, looseness, dropouts: seed % 2 === 0 }, 50)) {
            const r = f.reading;
            const h = headlineOf(r);
            const seen: string[] = [];
            if (h.kicker === 'Mount' && h.title !== 'Still listening') seen.push('');
            for (const c of cautionsOf(r)) if (/mount/i.test(c.title)) seen.push(c.body);
            for (const body of seen) {
              total++;
              if (body === '' || MOUNT_SENTENCES.has(body)) aboutMount++;
              bodies.set(body, (bodies.get(body) ?? 0) + 1);
            }
          }
        }
      }
    }
  }
  console.log(`rows headed with the mount: ${total}; body is empty or one of the monitor's mount sentences in ${pct(aboutMount, total)}`);
  for (const [k, v] of [...bodies].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(8)}  ${k === '' || MOUNT_SENTENCES.has(k) ? ' ' : '✗'} ${k === '' ? '(no body)' : k}`);
}

/**
 * THE WARM-UP, AND THE LIGHT THAT CONTRADICTED THE HEADLINE.
 *
 * Two screen-owned thresholds used to live here: a 4 s mount warm-up sized to outlast a startup
 * transient (and measured shorter than it), and `SETTLED_UP = 0.6` on the VERTICAL light. Both
 * are now the engine's own (`mountConfident`, `upSettled`), so this measures the consequences:
 * does a bolted-down phone ever get called unsteady, and can the light disagree with the phase?
 */
function warmup(): void {
  console.log('\n=== WARM-UP — a rigid mount, and when a real one is caught ===');
  console.log('looseness  runs   first mount verdict          READY frames w/ VERTICAL "Settling"');
  for (const looseness of [0, 0.1, 0.15, 0.2, 0.25, 0.5]) {
    const mounts = looseness === 0 ? MOUNTS : (['portrait-vent'] as MountPreset[]);
    const firstSus: number[] = [];
    const firstLoose: number[] = [];
    let runs = 0;
    let unsteadyFrames = 0;
    let readyFrames = 0;
    let settling = 0;
    let stepTick: number[] = [];
    for (const track of TRACKS) {
      for (const mount of mounts) {
        for (const seed of [1, 2, 3, 4]) {
          const frames = replayReadings({ track, mount, seed, looseness }, 50);
          runs++;
          const s = frames.find((f) => mountVerdict(f.reading) === 'suspect');
          const l = frames.find((f) => mountVerdict(f.reading) === 'loose');
          if (s) firstSus.push(s.t);
          if (l) firstLoose.push(l.t);
          const tick = frames.find((f) => lightsOf(f.reading)[2].state === 'on');
          if (tick) stepTick.push(tick.t);
          for (const f of frames) {
            const r = f.reading;
            if (lightsOf(r)[2].detail === 'Unsteady' || lightsOf(r)[2].detail === 'Moving') unsteadyFrames++;
            if (phaseOf(r) !== 'ready') continue;
            readyFrames++;
            if (lightsOf(r)[0].detail === 'Settling') settling++;
          }
        }
      }
    }
    firstSus.sort((a, b) => a - b);
    firstLoose.sort((a, b) => a - b);
    stepTick.sort((a, b) => a - b);
    const when = firstLoose.length
      ? `loose  ${pct(firstLoose.length, runs)} from ${firstLoose[0].toFixed(2)}–${firstLoose[firstLoose.length - 1].toFixed(2)} s`
      : firstSus.length
        ? `suspect ${pct(firstSus.length, runs)} from ${firstSus[0].toFixed(2)}–${firstSus[firstSus.length - 1].toFixed(2)} s`
        : `none — RIGID light at ${stepTick[0].toFixed(2)}–${stepTick[stepTick.length - 1].toFixed(2)} s`;
    console.log(`${String(looseness).padEnd(11)}${String(runs).padEnd(7)}${when.padEnd(46)}${settling} of ${readyFrames}`);
    if (looseness === 0) console.log(`           frames calling a bolted-down phone unsteady or moving: ${unsteadyFrames}`);
  }
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

const SECTIONS: Record<string, () => void> = { ceiling, vibration, trajectory, ready, rows, warmup, loose, suspect };

const wanted = process.argv.slice(2).filter((a) => a in SECTIONS);
for (const name of wanted.length ? wanted : Object.keys(SECTIONS)) SECTIONS[name]();
