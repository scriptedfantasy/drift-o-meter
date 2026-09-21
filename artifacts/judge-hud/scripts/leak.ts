/** Zoom in on the frames where total rose while counting=false. */
import { DriftPipeline, type LiveFrame } from '../../../src/engine/pipeline';
import { simulateRun, type TrackId } from '../../../src/sim';

function run(track: TrackId, seed: number, looseness: number) {
  const r = simulateRun(track, { seed, laps: 2, aggression: 0.8, consistency: 0.85, looseness, mount: 'portrait-vent' });
  const p = new DriftPipeline({ gpsLatencyS: 0.45, id: 'x', name: 'x', startedAt: 0 });
  const gps = r.gps.slice().sort((a, b) => a.t - b.t);
  let j = 0, prevTotal = 0;
  let last: LiveFrame | null = null;
  const hist: LiveFrame[] = [];
  for (let i = 0; i < r.motion.length; i++) {
    while (j < gps.length && gps[j].t <= r.motion[i].t) { p.pushGps(gps[j]); j++; }
    const f = p.pushMotion(r.motion[i]);
    if (f === last) continue;
    last = f;
    hist.push(f);
    const rise = f.score.total - prevTotal;
    if (!f.score.counting && (rise > 1e-9 || f.score.banked || f.score.callouts.some((c) => c.points > 0))) {
      console.log(`\n### ${track} s${seed} loose=${looseness}  t=${f.t.toFixed(2)}  rise=${rise.toFixed(1)}`);
      console.log(`  counting=${f.score.counting} believable=${f.integrity.believable} mount=${f.integrity.mount} physics=${f.integrity.physics} gps=${f.integrity.gps} valid=${f.state.valid}`);
      console.log(`  msg="${f.integrity.message}"  phase=${f.phase} total=${f.score.total.toFixed(1)} chain=${f.score.chainPoints.toFixed(1)} mult=${f.score.multiplier.toFixed(2)}`);
      console.log(`  banked=${f.score.banked}(${f.score.bankedPoints.toFixed(1)}) lost=${f.score.lost}(${f.score.lostPoints.toFixed(1)})`);
      for (const c of f.score.callouts) console.log(`  CALLOUT "${c.label}"  points=${c.points.toFixed(1)}  kind=${c.kind}`);
      // context: previous 3 frames
      for (let k = Math.max(0, hist.length - 4); k < hist.length - 1; k++) {
        const g = hist[k];
        console.log(`   prev t=${g.t.toFixed(2)} counting=${g.score.counting} total=${g.score.total.toFixed(1)} phase=${g.phase} beta=${(g.state.beta*180/Math.PI).toFixed(1)} v=${(g.state.speed*3.6).toFixed(1)}`);
      }
    }
    prevTotal = f.score.total;
  }
  while (j < gps.length) { p.pushGps(gps[j]); j++; }
  const s = p.finish();
  console.log(`  -> finish total=${s.score.total} grade=${s.score.grade} trusted=${s.score.trusted} msg="${s.integrity.message}"`);
}

run('harbor', 1, 0.1);
run('harbor', 1, 0.2);
run('harbor', 2, 0.1);
