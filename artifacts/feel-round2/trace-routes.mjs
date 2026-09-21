/**
 * A private harness route that INSTRUMENTS Web Audio, for one defect class: a sound the driver
 * asked for being cut off by the navigation that follows it.
 *
 *   node tools/harness/shoot.mjs --no-build --dist <a private dist> \
 *     --routes artifacts/feel-round2/trace-routes.mjs --out artifacts/feel-round2/shots --fresh
 *
 * It wraps `AudioBufferSourceNode.start/stop`, `AudioContext.close/resume/suspend` and
 * `decodeAudioData`, drives a real run to the STOP control, and dumps the timeline as a console
 * line (`SNDLOG [...]`). What it is for: the STOP clip used to start at t = 6151.7 ms with
 * `dur=0.52` and meet `ctx.close()` at t = 6367.3 — 215 ms into a 520 ms clip — because
 * `/drive` unmounting released the sound port. The same teardown then made `/results` decode the
 * whole bank again (18 × `decode` at t = 7066) and fire the grade clip at t = 7864 against a
 * slam at ~7920.
 *
 * What it prints now, on the same route: `start dur=0.52` at 5713.3 ms, no `srcStop` and no
 * `ctx.close` after it, zero `decode` calls, the reveal mounting at 6358.2 (125 ms AFTER the
 * clip finished) and the grade clip at 7199.6 — 841 ms into a 900 ms hold.
 */
const INSTRUMENT = `(() => {
  if (window.__snd) return;
  const t0 = performance.now();
  window.__snd = { events: [] };
  const push = (e) => window.__snd.events.push(Object.assign({ t: +(performance.now() - t0).toFixed(1) }, e));
  const B = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
  if (B) {
    const s = B.start, st = B.stop;
    B.start = function (...a) { push({ e: 'start', loop: !!this.loop, dur: this.buffer ? +this.buffer.duration.toFixed(3) : null }); return s.apply(this, a); };
    B.stop = function (...a) { push({ e: 'srcStop' }); return st.apply(this, a); };
  }
  const AC = window.AudioContext && window.AudioContext.prototype;
  if (AC) {
    const c = AC.close, r = AC.resume, su = AC.suspend;
    AC.close = function (...a) { push({ e: 'ctx.close' }); return c.apply(this, a); };
    AC.resume = function (...a) { push({ e: 'ctx.resume' }); return r.apply(this, a); };
    AC.suspend = function (...a) { push({ e: 'ctx.suspend' }); return su.apply(this, a); };
  }
  const BA = window.BaseAudioContext && window.BaseAudioContext.prototype;
  if (BA) { const d = BA.decodeAudioData; BA.decodeAudioData = function (...a) { push({ e: 'decode' }); return d.apply(this, a); }; }
  const poll = setInterval(() => {
    if (document.querySelector('[data-testid="reveal-skip"]')) { push({ e: 'revealMounted' }); clearInterval(poll); }
  }, 8);
  push({ e: 'instrumented' });
})();`;

const DUMP = `console.log('SNDLOG ' + JSON.stringify(window.__snd ? window.__snd.events : 'none'));`;

export default [
  {
    name: 'trace-stop-then-grade',
    path: '/drive?sim=harbor&rate=4&at=40',
    waitMs: 600,
    actions: [
      { type: 'eval', js: INSTRUMENT },
      { type: 'wait', ms: 5000 },
      { type: 'eval', js: DUMP },
      { type: 'tap', testId: 'cta-stop', timeout: 30000 },
      { type: 'wait', ms: 6000 },
      { type: 'eval', js: DUMP },
    ],
  },
];
