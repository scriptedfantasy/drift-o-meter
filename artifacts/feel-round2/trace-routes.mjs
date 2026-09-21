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
