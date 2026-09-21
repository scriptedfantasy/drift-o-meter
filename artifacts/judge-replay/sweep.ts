/** Independent judge sweep: does the replay ever invent a segment score, and does it agree
 *  with the scorer about what banked? Written from the contract in src/engine/types.ts,
 *  not from the builder's test. */
import { buildReplay } from '../../src/engine/replay/build';
import { FIXTURES, type FixtureSpec } from '../../src/ui/results/fixture';
import { buildFixtureSession } from '../../src/ui/results/fixture';
import { replayChains, resolveOptions } from '../../src/engine/score';
import { clamp, degToRad, radToDeg } from '../../src/engine/types';

const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 17, 19, 23, 29, 31, 37, 42, 55, 66, 77, 88, 101, 137];
const names = Object.keys(FIXTURES);

let runs = 0;
let drifts = 0;
const fabricated: string[] = [];
const disagreedContract: string[] = [];
const disagreedChains: string[] = [];
const totalMismatch: string[] = [];
const zeroClaims: string[] = [];
// what the OLD rule (ds.total > 0 ? ds.total : fallback) would have produced
let oldFabRuns = 0;
const oldFabDetail: string[] = [];
const oldTotals: string[] = [];

for (const name of names) {
  for (const seed of seeds) {
    const spec: FixtureSpec = { ...FIXTURES[name], seed };
    const s = buildFixtureSession(spec);
    const r = buildReplay(s);
    runs++;
    const chainLost = new Set(
      replayChains(s.drifts, s.states, resolveOptions())
        .scored.filter((d) => d.lost)
        .map((d) => d.id),
    );
    let oldRunFab = false;
    let oldExtra = 0;
    for (const seg of r.segments) {
      drifts++;
      const ds = s.score.perDrift[seg.driftId];
      if (ds) {
        if (Math.abs(seg.grossPoints - Math.max(0, ds.total)) > 1e-6)
          fabricated.push(`${name} s${seed} d${seg.driftId}: scorer ${ds.total.toFixed(2)} → replay gross ${seg.grossPoints.toFixed(2)}`);
        if (seg.lost !== (ds.lost === true))
          disagreedContract.push(`${name} s${seed} d${seg.driftId}: ds.lost=${ds.lost} seg.lost=${seg.lost}`);
        // old rule reconstruction
        if (!(ds.total > 0)) {
          let pts = 0;
          for (let k = seg.startIndex; k <= seg.endIndex; k++)
            pts += (100 * clamp(Math.abs(r.trail.beta[k]) / degToRad(30), 0, 1.5)) / r.trail.hz;
          pts = Math.round(pts);
          if (pts > 0) {
            oldRunFab = true;
            oldExtra += ds.lost ? 0 : pts;
            if (oldFabDetail.length < 8) oldFabDetail.push(`${name} s${seed} d${seg.driftId}: scorer 0 → old replay ${pts}`);
          }
        }
      } else {
        fabricated.push(`${name} s${seed} d${seg.driftId}: NO scorer entry, replay gross ${seg.grossPoints.toFixed(2)}`);
      }
      if (seg.lost !== chainLost.has(seg.driftId))
        disagreedChains.push(`${name} s${seed} d${seg.driftId}: chains=${chainLost.has(seg.driftId)} seg=${seg.lost}`);
      if (!(seg.points > 0)) {
        const exit = r.events.find((e) => e.kind === 'exit' && e.driftId === seg.driftId);
        if (exit && /\+\s*0\b/.test(exit.label)) zeroClaims.push(`${name} s${seed} d${seg.driftId} exit "${exit.label}"`);
        const hl = r.highlights.find((h) => h.driftId === seg.driftId);
        if (hl && /PTS/.test(hl.label)) zeroClaims.push(`${name} s${seed} d${seg.driftId} highlight "${hl.label}"`);
        const em = r.markers.find((m) => m.kind === 'drift-end' && m.driftId === seg.driftId);
        if (em && /\+\s*0\b/.test(em.label)) zeroClaims.push(`${name} s${seed} d${seg.driftId} end-marker "${em.label}"`);
      }
    }
    const last = r.trail.score[r.trail.n - 1];
    if (Math.round(last) !== s.score.total) totalMismatch.push(`${name} s${seed}: trail ${last.toFixed(1)} vs session ${s.score.total}`);
    if (oldRunFab) {
      oldFabRuns++;
      if (oldTotals.length < 8) oldTotals.push(`${name} s${seed}: session ${s.score.total}, old replay total would be ~${(last + oldExtra).toFixed(0)}`);
    }
  }
}

console.log(`runs=${runs} segments=${drifts}`);
console.log(`FABRICATED (current code): ${fabricated.length}`);
for (const f of fabricated.slice(0, 10)) console.log('  ' + f);
console.log(`DISAGREE vs ds.lost contract: ${disagreedContract.length}`);
for (const f of disagreedContract.slice(0, 10)) console.log('  ' + f);
console.log(`DISAGREE vs replayChains: ${disagreedChains.length}`);
for (const f of disagreedChains.slice(0, 10)) console.log('  ' + f);
console.log(`TRAIL TOTAL != SESSION TOTAL: ${totalMismatch.length}`);
for (const f of totalMismatch.slice(0, 10)) console.log('  ' + f);
console.log(`ZERO-PAID DRIFT MAKING A POINTS CLAIM: ${zeroClaims.length}`);
for (const f of zeroClaims.slice(0, 10)) console.log('  ' + f);
console.log(`--- OLD RULE (ds.total>0) would fabricate on ${oldFabRuns}/${runs} runs ---`);
for (const f of oldFabDetail) console.log('  ' + f);
for (const f of oldTotals) console.log('  ' + f);
