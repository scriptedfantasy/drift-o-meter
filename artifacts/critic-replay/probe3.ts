import { buildReplay, poseAt, ghostPoseAt, liveSmoke, ReplayCamera, worldToScreen } from '../../src/engine/replay';
import type { Session, SlipState } from '../../src/engine/types';
const deg=(r:number)=>r*180/Math.PI;
function mk(states: SlipState[], extra: Partial<Session> = {}): Session {
  return { id:'x', name:'probe', startedAt:0, states, drifts:[], truth:[], track:null, score:null, ...extra } as any;
}
function line(n:number, f:(i:number)=>Partial<SlipState>): SlipState[] {
  const out: SlipState[] = [];
  for(let i=0;i<n;i++){ const t=i/100; out.push({t, beta:0, betaSigma:0.02, heading:0, course:0, speed:20, yawRate:0, ay:0, ax:0, x:20*t, y:0, valid:true, ...f(i)} as SlipState); }
  return out;
}
function report(name:string, s:Session){
  try{
    const r = buildReplay(s);
    const bad = [r.durationS, r.bounds.minX, r.bounds.maxX, r.telemetry.maxPoints, r.info.peakAngle].filter(v=>!Number.isFinite(v));
    const cam = new ReplayCamera('chase',{w:390,h:580});
    let camBad = 0, worst = '';
    let st = cam.update(r,0,1/60);
    for(let t=1/60;t<=r.durationS;t+=1/60){ st=cam.update(r,t,1/60);
      if(![st.cx,st.cy,st.zoom,st.rotation].every(Number.isFinite)) {camBad++; if(!worst) worst=`t=${t.toFixed(2)} ${JSON.stringify(st)}`;} }
    const p = poseAt(r, r.durationS/2);
    const sp = worldToScreen(st, p.x, p.y);
    console.log(`${name.padEnd(28)} dur=${r.durationS.toFixed(2)} n=${r.trail.n} segs=${r.segments.length} smoke=${r.smoke.length} markers=${r.markers.length} ghost=${r.ghost?'y':'n'} nonFinite=${bad.length} camNonFinite=${camBad} midPose(b=${deg(p.beta).toFixed(1)}° v=${(p.speed*3.6).toFixed(0)}) screen=(${sp.x.toFixed(0)},${sp.y.toFixed(0)}) ${worst}`);
  }catch(e){ console.log(`${name.padEnd(28)} THREW: ${(e as Error).message}`); }
}
// 1. a run that never drifts
report('never drifts', mk(line(6000, ()=>({}))));
// 2. GPS dropout: 10 s of NaN positions in the middle
report('NaN positions 20-30s', mk(line(6000, i=> (i>2000&&i<3000)?{x:NaN,y:NaN}:{} )));
// 3. all-NaN positions
report('all NaN positions', mk(line(600, ()=>({x:NaN,y:NaN}))));
// 4. parked (speed 0, same point)
report('parked', mk(line(3000, ()=>({speed:0,x:0,y:0}))));
// 5. extreme beta (spin, 180 deg)
report('beta = 175 deg', mk(line(2000, i=>({beta: (i>500&&i<1500)? Math.PI*175/180 : 0}))));
// 6. NaN beta
report('NaN beta', mk(line(600, i=> i>200?{beta:NaN}:{} )));
// 7. NaN speed
report('NaN speed', mk(line(600, i=> i>200?{speed:NaN}:{} )));
// 8. single sample
report('one sample', mk(line(1, ()=>({}))));
// 9. zero samples
report('zero samples', mk([]));
// 10. huge coordinates (unprojected lat/lon leaking through)
report('coords 1e7', mk(line(600, ()=>({x:5e6,y:1e7}))));
// 11. non-monotonic time
report('time goes backwards', mk(line(600, i=> i>300?{t:(600-i)/100}:{} )));
// 12. beta jumps across pi (wrap)
report('beta wraps +-pi', mk(line(1200, i=>({beta: Math.sin(i/50)*Math.PI*0.99}))));
