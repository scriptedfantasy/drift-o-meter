import { simulateRun } from '../../src/sim';
import { buildReplay, sessionFromSimulation, ReplayCamera, poseAt, worldToScreen } from '../../src/engine/replay';
import type { Session, SlipState } from '../../src/engine/types';
const deg=(r:number)=>r*180/Math.PI;

// --- A. does ONE NaN sample poison the camera forever?
function line(n:number, f:(i:number)=>Partial<SlipState>): SlipState[] {
  const out: SlipState[] = [];
  for(let i=0;i<n;i++){ const t=i/100; out.push({t, beta:0, betaSigma:0.02, heading:0, course:0, speed:20, yawRate:0, ay:0, ax:0, x:20*t, y:0, valid:true, ...f(i)} as SlipState); }
  return out;
}
const s: Session = { id:'x',name:'p',startedAt:0, states: line(3000, i=> i===1000?{speed:NaN}:{}), drifts:[], truth:[], track:null, score:null } as any;
const r = buildReplay(s);
let nanTrail=0; for(let k=0;k<r.trail.n;k++) if(!Number.isFinite(r.trail.speed[k])) nanTrail++;
console.log(`A. ONE NaN speed sample -> trail speed NaN for ${nanTrail}/${r.trail.n} samples; dist[last]=${r.trail.dist[r.trail.n-1]}`);
const cam=new ReplayCamera('chase',{w:390,h:580}); let st=cam.update(r,0,1/60); let bad=0, first=-1, lastGood=-1;
for(let t=1/60;t<=r.durationS;t+=1/60){ st=cam.update(r,t,1/60); if(!Number.isFinite(st.cx)){bad++; if(first<0)first=t;} else lastGood=t; }
console.log(`   camera non-finite frames: ${bad}, first at t=${first.toFixed(2)}s, last finite frame t=${lastGood.toFixed(2)}s (duration ${r.durationS.toFixed(2)}s) -> recovers? ${lastGood>first}`);

// --- B. beta linear lerp vs lerpAngle across +-pi
const s2: Session = { id:'y',name:'p',startedAt:0, states: [
  {t:0,beta: 3.10,betaSigma:0,heading:0,course:0,speed:20,yawRate:0,ay:0,ax:0,x:0,y:0,valid:true},
  {t:0.1,beta:-3.10,betaSigma:0,heading:0,course:0,speed:20,yawRate:0,ay:0,ax:0,x:2,y:0,valid:true},
  {t:0.2,beta:-3.05,betaSigma:0,heading:0,course:0,speed:20,yawRate:0,ay:0,ax:0,x:4,y:0,valid:true},
] as any, drifts:[], truth:[], track:null, score:null } as any;
const r2=buildReplay(s2);
console.log(`B. beta across +-pi: samples ${Array.from(r2.trail.beta).map(v=>deg(v).toFixed(0)+'°').join(' ')}  (truth: 178->-178 should stay near +-180, not pass through 0)`);

// --- C. mode switch overview -> chase: how long and how violent
const rr = buildReplay(sessionFromSimulation(simulateRun('harbor',{seed:1,laps:2})));
const c = new ReplayCamera('overview',{w:390,h:580});
let cs=c.update(rr,40,1/60); for(let t=40;t<45;t+=1/60) cs=c.update(rr,t,1/60);
c.setMode('chase');
let tt=45, frames=0, maxRot=0, maxZ=0, maxPanPx=0, prev=cs;
const target = 390/60;
while(tt<60){ tt+=1/60; const st=c.update(rr,tt,1/60); frames++;
  const dr=Math.abs(((st.rotation-prev.rotation+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI);
  const dz=Math.abs(Math.log(st.zoom/prev.zoom)); const dpx=Math.hypot(st.cx-prev.cx,st.cy-prev.cy)*st.zoom;
  maxRot=Math.max(maxRot,dr); maxZ=Math.max(maxZ,dz); maxPanPx=Math.max(maxPanPx,dpx);
  if (Math.abs(st.zoom-target)/target < 0.02 && dr < 0.002) break;
  prev=st;
}
console.log(`C. overview->chase settle: ${frames} frames = ${(frames/60).toFixed(2)}s; peak per-frame rot=${deg(maxRot).toFixed(2)}° zoom=${(100*(Math.exp(maxZ)-1)).toFixed(1)}% pan=${maxPanPx.toFixed(0)}px`);
// and the reverse
const c2 = new ReplayCamera('chase',{w:390,h:580}); let s2t=c2.update(rr,40,1/60); for(let t=40;t<45;t+=1/60) s2t=c2.update(rr,t,1/60);
c2.setMode('overview'); let f2n=0,mr=0,mz=0,mp=0; let pv=s2t; let t2=45;
while(t2<65){ t2+=1/60; const st=c2.update(rr,t2,1/60); f2n++;
  const dr=Math.abs(((st.rotation-pv.rotation+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI);
  mr=Math.max(mr,dr); mz=Math.max(mz,Math.abs(Math.log(st.zoom/pv.zoom))); mp=Math.max(mp,Math.hypot(st.cx-pv.cx,st.cy-pv.cy)*st.zoom);
  if(dr<0.0005 && Math.abs(Math.log(st.zoom/pv.zoom))<0.0005) break; pv=st; }
console.log(`   chase->overview settle: ${f2n} frames = ${(f2n/60).toFixed(2)}s; peak per-frame rot=${deg(mr).toFixed(2)}° zoom=${(100*(Math.exp(mz)-1)).toFixed(1)}% pan=${mp.toFixed(0)}px`);

// --- D. how much of the world window does the car occupy, and where does the eye go?
const camC=new ReplayCamera('chase',{w:390,h:580}); let scC=camC.update(rr,0,1/60);
for(let t=1/60;t<=42.6;t+=1/60) scC=camC.update(rr,t,1/60);
const p=poseAt(rr,42.6); const sp=worldToScreen(scC,p.x,p.y);
console.log(`D. chase zoom=${scC.zoom.toFixed(2)} px/m (logical). car 4.5x1.8m -> ${(4.5*scC.zoom).toFixed(1)}x${(1.8*scC.zoom).toFixed(1)} logical pt = ${(4.5*scC.zoom*3).toFixed(0)}x${(1.8*scC.zoom*3).toFixed(0)} device px`);
console.log(`   car area = ${(4.5*1.8*scC.zoom*scC.zoom/(390*580)*100).toFixed(3)}% of the world window; car centre on screen = (${sp.x.toFixed(0)}, ${sp.y.toFixed(0)}) of (390, 580) -> ${(100*sp.y/580).toFixed(0)}% down`);
console.log(`   visible world = ${(390/scC.zoom).toFixed(0)} x ${(580/scC.zoom).toFixed(0)} m; road is 9 m wide = ${(100*9/(390/scC.zoom)).toFixed(0)}% of frame width`);
// where the car sits vertically over the whole run
let ys:number[]=[]; const camD=new ReplayCamera('chase',{w:390,h:580}); let sd=camD.update(rr,0,1/60);
for(let t=1/60;t<=rr.durationS;t+=1/60){ sd=camD.update(rr,t,1/60); const pp=poseAt(rr,t); ys.push(worldToScreen(sd,pp.x,pp.y).y); }
ys.sort((a,b)=>a-b);
console.log(`   car screen-y over the run: p5=${ys[Math.floor(ys.length*0.05)].toFixed(0)} median=${ys[Math.floor(ys.length*0.5)].toFixed(0)} p95=${ys[Math.floor(ys.length*0.95)].toFixed(0)} (window 0..580)`);
