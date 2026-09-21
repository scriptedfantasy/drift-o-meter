/**
 * The re-score grid: how far a session scored from STORAGE lands from the total the live
 * pipeline published for it.
 *
 *   npx tsx tools/analysis/rescore-sweep.ts
 *   npx tsx tools/analysis/rescore-sweep.ts --seeds 1-8 --looseness 0,0.1,0.2,0.25 --laps 2
 *
 * WHY THIS IS A COMMITTED TOOL AND NOT A NUMBER IN A COMMENT. `src/engine/score/drift.ts`
 * documents a fallback bound — a stored session has no per-sample plausibility mask, only
 * `DriftEvent.suppressedS`, so it pays the expected value of what the live pass refused — and
 * the bound was quoted as "0.0–1.3 % typical, 8.5 % worst over 2 tracks × 3 seeds × looseness
 * 0/0.1/0.2". That grid reproduces exactly, and the headline was honest on it. It was also one
 * seed too narrow: the same measurement over seeds 1–6 and looseness to 0.25 contains cases many
 * times worse. `docs/DESIGN.md` records the identical mistake being made about the calibrator's
 * ceiling ("Any claim about what the engine 'cannot' do must be measured across seeds before it
 * is written down"), so the claim is a command now, and the test quotes what the command prints.
 *
 * The table's columns: the live `finish()` total, the re-score, the error, the same error with
 * the CLEAN LAP bonus removed from both sides (it is the one payment a per-drift duration cannot
 * place in time), and the component that moved furthest.
 */
import { DriftPipeline } from '../../src/engine/pipeline';
import { scoreSession } from '../../src/engine/score';
import { simulateRun, type TrackId } from '../../src/sim';
import type { Session } from '../../src/engine/types';

/** Exactly what a results screen does with a session loaded from disk: no mask, only the events. */
const reScore = (stored: Session) =>
  scoreSession(stored.drifts, stored.states, stored.track, undefined, {
    integrity: { mount: stored.integrity.mount, physics: stored.integrity.physics, gps: stored.integrity.gps, message: stored.integrity.message },
  });

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function expandSeeds(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = /^(\d+)-(\d+)$/.exec(part.trim());
    if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
    else out.push(Number(part));
  }
  return out;
}

const tracks = arg('tracks', 'harbor,touge').split(',') as TrackId[];
const seeds = expandSeeds(arg('seeds', '1-6'));
const looseness = arg('looseness', '0,0.1,0.2,0.22,0.25').split(',').map(Number);
const laps = Number(arg('laps', '2'));

const COMPONENTS = ['angle', 'consistency', 'quality', 'speed', 'style'] as const;

function main(): void {
  console.log(`re-score sweep — ${tracks.length} tracks × ${seeds.length} seeds × ${looseness.length} looseness, ${laps} laps`);
  console.log(['track', 'seed', 'loose', 'trusted', 'live', 're-score', 'err %', 'err % (no CLEAN LAP)', 'worst component'].join('\t'));
  let worstAll = { where: '', err: 0 };
  let worstTrusted = { where: '', err: 0 };
  let worstComponent = { where: '', d: 0 };
  for (const track of tracks) {
    for (const seed of seeds) {
      for (const L of looseness) {
        const run = simulateRun(track, { seed, laps, looseness: L });
        const p = new DriftPipeline({});
        const gps = run.gps.slice().sort((a, b) => a.t - b.t);
        let j = 0;
        for (let i = 0; i < run.motion.length; i++) {
          while (j < gps.length && gps[j].t <= run.motion[i].t) p.pushGps(gps[j++]);
          p.pushMotion(run.motion[i]);
        }
        while (j < gps.length) p.pushGps(gps[j++]);
        const live = p.finish();
        const stored = JSON.parse(JSON.stringify(live)) as Session;
        const re = reScore(stored);
        const err = Math.abs(re.total - live.score.total) / Math.max(1, live.score.total);
        const cl = (byDrift: Record<number, { callouts: Array<{ kind: string; points: number }> }>) =>
          Object.values(byDrift).reduce((a, d) => a + d.callouts.filter((c) => c.kind === 'clean-lap').reduce((x, c) => x + c.points, 0), 0);
        const clLive = cl(live.score.perDrift);
        const clRe = cl(re.perDrift);
        const errNoCl = Math.abs(re.total - clRe - (live.score.total - clLive)) / Math.max(1, live.score.total - clLive);
        const moved = COMPONENTS.map((k) => ({ k, d: Math.abs(re[k] - live.score[k]) })).sort((a, b) => b.d - a.d)[0];
        const where = `${track}/${seed}/${L}`;
        if (err > worstAll.err) worstAll = { where, err };
        if (live.score.trusted && err > worstTrusted.err) worstTrusted = { where, err };
        if (live.score.trusted && moved.d > worstComponent.d) worstComponent = { where: `${where} ${moved.k}`, d: moved.d };
        console.log(
          [track, seed, L, live.score.trusted, live.score.total, Math.round(re.total), (100 * err).toFixed(1), (100 * errNoCl).toFixed(1), `${moved.k} ${moved.d.toFixed(1)}`].join('\t'),
        );
      }
    }
  }
  console.log(`\nWORST overall          ${worstAll.where} ${(100 * worstAll.err).toFixed(1)} %`);
  console.log(`WORST on a TRUSTED run ${worstTrusted.where} ${(100 * worstTrusted.err).toFixed(1)} %`);
  console.log(`WORST component on a trusted run: ${worstComponent.where} ${worstComponent.d.toFixed(1)} points`);
}

main();
