/**
 * Does the grade reveal still make a sound when the bank is slow?
 *
 *   npx expo export --platform web --output-dir <a private dist>
 *   node tools/audio/trace-grade.mjs <that dist> [delayMs]     # default 2500
 *
 * Opens a COLD `/results/fixture-hero` with every `.wav` response held back by `delayMs`, with
 * Web Audio instrumented, and prints when the bank finished decoding, when the reveal mounted,
 * and whether — and when — a clip of the grade's own length (1.65 s) started.
 *
 * ── Why this is a script and not a harness route ─────────────────────────────────────────────
 * `tools/harness/shoot.mjs` has no way to delay a request, and this defect only exists while the
 * reveal's 900 ms slam beats the 21 decodes. It also forces `--autoplay-policy=
 * no-user-gesture-required`: without it this Chromium leaves the AudioContext suspended on a
 * page nobody has touched, and the app's silence is hidden behind the browser's.
 *
 * ── What it caught, and what it says now ─────────────────────────────────────────────────────
 * `GradeReveal` used to set `gradeHeard.current = true` and THEN call `feelCue`, which is a
 * no-op until the sound ports attach. So a reveal that beat the decodes got one attempt, marked
 * itself heard, and never tried again — and on native this is the first result opened after a
 * cold launch, because the garage never mounts `useDriftFeel`.
 *
 *   build      delay    decodes resolved   reveal mounted   grade clip (dur 1.65)
 *   before     0 ms     998.6 ms           954.3 ms         starts 1865.1 ms
 *   before     2500 ms  3157.4 ms          1125.4 ms        NEVER STARTS
 *   after      0 ms     1037.3 ms          987.0 ms         starts 1903.6 ms
 *   after      2500 ms  3167.5 ms          1192.8 ms        starts 3168.1 ms
 *
 * i.e. the healthy path is unchanged and the cold one now sounds, 0.6 ms after the last decode
 * resolves. `feelCue` reports whether the cue was taken and `feelCueWhenReady` holds exactly one
 * until the ports attach; see `src/ui/audio/useDriftFeel.ts`.
 */
import path from 'node:path';
import { chromium } from 'playwright';
import { resolveChromium } from '../harness/browser.mjs';
import { startStaticServer } from '../harness/staticServer.mjs';

const dist = path.resolve(process.argv[2] ?? 'dist');
const delayMs = Number(process.argv[3] ?? 2500);

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
    const c = AC.close, r = AC.resume;
    AC.close = function (...a) { push({ e: 'ctx.close' }); return c.apply(this, a); };
    AC.resume = function (...a) { push({ e: 'ctx.resume' }); return r.apply(this, a); };
  }
  const BA = window.BaseAudioContext && window.BaseAudioContext.prototype;
  if (BA) { const d = BA.decodeAudioData; BA.decodeAudioData = function (...a) { push({ e: 'decode' }); return d.apply(this, a).then((b) => (push({ e: 'decoded', dur: +b.duration.toFixed(3) }), b)); }; }
  // Keep every context we see, so the trace can say what state it was in when a cue was offered.
  window.__ctxs = [];
  if (window.AudioContext) {
    const Orig = window.AudioContext;
    const Wrapped = function (...a) { const c = new Orig(...a); window.__ctxs.push(c); push({ e: 'ctx.new', state: c.state }); return c; };
    Wrapped.prototype = Orig.prototype;
    window.AudioContext = Wrapped;
  }
  let lastState = '';
  const poll = setInterval(() => {
    const st = (window.__ctxs[0] && window.__ctxs[0].state) || '';
    if (st !== lastState) { lastState = st; push({ e: 'ctx.state', state: st }); }
    if (!window.__revealSeen && document.querySelector('[data-testid="reveal-skip"]')) { window.__revealSeen = 1; push({ e: 'revealMounted' }); }
  }, 8);
  push({ e: 'instrumented' });
})();`;

const server = await startStaticServer({ root: dist, port: 0 });
// The harness's own flags PLUS the autoplay policy the finding was reported under: this
// Chromium otherwise leaves the AudioContext suspended on a page nobody has touched, which would
// hide the defect behind the browser's own silence rather than the app's.
const browser = await chromium.launch({
  executablePath: resolveChromium(),
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--font-render-hinting=none',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  colorScheme: 'dark',
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('  console.error:', m.text()); });
await page.addInitScript(INSTRUMENT);
if (delayMs > 0) {
  await page.route('**/*.wav', async (route) => {
    await new Promise((r) => setTimeout(r, delayMs));
    await route.continue();
  });
}

const t0 = Date.now();
await page.goto(server.url + '/results/fixture-hero', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(9000);
// a real tap, four seconds after the reveal would have finished — the "does it recover?" half
await page.mouse.click(196, 700).catch(() => {});
await page.waitForTimeout(1500);

const events = await page.evaluate(() => (window.__snd ? window.__snd.events : []));
console.log(`\n=== /results/fixture-hero  ·  every .wav delayed ${delayMs} ms  ·  ${dist}`);
const decoded = events.filter((e) => e.e === 'decoded');
const starts = events.filter((e) => e.e === 'start' && !e.loop);
const reveal = events.find((e) => e.e === 'revealMounted');
console.log(`  decode calls      ${events.filter((e) => e.e === 'decode').length}`);
console.log(`  decodes resolved  ${decoded.length}${decoded.length ? `, last at ${decoded[decoded.length - 1].t} ms` : ''}`);
console.log(`  reveal mounted    ${reveal ? `${reveal.t} ms` : 'never seen'}`);
console.log(`  ctx.close         ${events.filter((e) => e.e === 'ctx.close').length}`);
console.log(`  one-shot starts   ${starts.length}`);
for (const s of starts) console.log(`      start  t=${s.t} ms  dur=${s.dur}${s.dur === 1.65 ? '   <- the GRADE clip' : ''}`);
if (starts.length === 0) console.log('      (nothing started: the page made no sound at all)');
const states = events.filter((e) => e.e === 'ctx.state' || e.e === 'ctx.new');
console.log(`  context           ${states.map((e) => `${e.state}@${e.t}`).join(' -> ') || 'never constructed'}`);
console.log(`  wall time         ${Date.now() - t0} ms`);

await context.close();
await browser.close();
await server.close();
