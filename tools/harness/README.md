# Verification harness

`tools/harness/shoot.mjs` builds the real web export, serves it, drives it in headless Chromium
with an iPhone 15 Pro profile (393x852 CSS px, 3x, touch, mobile UA, dark colour scheme) and
captures evidence for the critic agents. Web has no motion sensors, so the app starts with the
**simulated** sensor source automatically (`src/platform/sourceSelector.ts`); `?sim=harbor&rate=1`
on any route selects track / playback rate / seed / laps explicitly.

```
npm run shoot                 # export + screenshots of every default route (portrait)
npm run shoot -- --no-build   # reuse dist/ from the last export
npm run shoot -- --landscape  # 852x393; files get a -landscape suffix
npm run shoot:video           # also records artifacts/video/<name>.webm per route
npm run shoot -- --only drive,home --routes tools/harness/my-routes.mjs
npm run assets:render         # regenerate assets/images/*.png (icon, splash glyph, favicon, android icons)
```

Flags: `--no-build`, `--video`, `--landscape`, `--routes <file.json|.mjs>`, `--only a,b`,
`--out <dir>` (default `artifacts/shots`), `--video-dir <dir>` (default `artifacts/video`),
`--port <n>`, `--no-font-check`, `--full-page`, `--scale <n>` (device pixel ratio, default 3).

## Outputs

- `artifacts/shots/<name>.png` (or `<name>-landscape.png`)
- `artifacts/shots/console.log`: every console message, page error, failed request and HTTP >= 400,
  grouped per route
- `artifacts/shots/report.json`: per route, the fonts that loaded, how many text nodes render in
  Barlow Condensed / Barlow / anything else, `<canvas>` count, WebGL + CanvasKit availability,
  pixel statistics (corner colours, ember / cyan / text pixel counts, non-background fraction)
- `artifacts/video/<name>.webm` with `--video`

The run **exits 1** when any route has a page error, `console.error`, failed request, HTTP error,
no Barlow face loaded, no Barlow Condensed text, a page background that is not `#07090D` (corner
pixels more than 24/255 off; a faint glow tint only warns), a missing
`<canvas>` where `expectCanvas` is set, or fewer ember pixels than `minEmber`.

## Route files

A route file is JSON or an ES module exporting an array (`default` or `routes`). Entry shape:

```js
{
  name: 'drive',                          // screenshot / video file stem
  path: '/drive?sim=harbor&rate=1',       // URL path + query
  waitMs: 2600,                           // settle time after load + fonts (default 800)
  expectCanvas: true,                     // fail unless a <canvas> (Skia) is present
  minEmber: 2000,                         // fail unless this many ember-coloured pixels are visible
  fullPage: false,
  actions: [                              // optional, run before the screenshot
    { type: 'tap', testId: 'cta-drive' }, // or { selector } / { text, exact }
    { type: 'wait', ms: 500 },
    { type: 'waitFor', testId: 'screen-results' },
    { type: 'scroll', y: 600 },
    { type: 'press', key: 'Escape' },
    { type: 'eval', js: 'window.scrollTo(0, 0)' },
    { type: 'goto', path: '/settings' },
    { type: 'screenshot', name: 'drive-mid' },   // extra intermediate capture
  ],
}
```

`testID` props in the app map to `data-testid` on web, which is what `testId` targets.

## Drive HUD: seeking and freezing a moment (`/drive?...`)

The HUD is only interesting while the car is sideways, so the harness does not photograph it at
t = 0. `src/ui/hud/hudParams.ts` adds four query parameters on top of the `sim` / `rate` / `seed`
/ `laps` ones that pick the recording:

| param | effect |
| --- | --- |
| `at=<seconds>` | WARP: feed the pipeline every sample up to that instant of the recording at once, silently (no callouts animate, no haptics), then carry on from there. ~11 000 samples take about 0.3 s. Implies `run=1`. |
| `hold=1` | FREEZE at `at`: no further samples. The frame is then deterministic — the same URL gives the same pixels, verified by shooting one URL three times 2.5 s apart. |
| `run=1` | Arm and start the run on mount instead of showing the READY screen. |
| `integrity=loose\|suspect\|gps-poor\|gps-none\|physics\|ok` | Presentation-only override of `frame.integrity`, so the warning states can be photographed from a clean recording. It changes nothing upstream of the view; the wording is the IntegrityMonitor's own. |

`at` counts seconds of MOTION data (the same clock the HUD's own timer shows), so `at=100.85`
lands on the frame whose HUD clock reads 1:41. Playback speed still comes from `rate`.

Two details make a frozen frame reproducible, and both are worth knowing before changing them:

* the callout stack expires by RECORDING time, not wall time, so freezing the run freezes the
  stack — `drive-peak` keeps the three callouts that fired in the 3.2 s before `at`;
* the score odometer settles on whole digits when the score stops changing (a chained linear
  tween, not an exponential smoother, which on web never finishes).

A live route (no `hold`) is NOT frame-exact: the screenshot lands wherever playback has reached,
about 4.5 s after `at` with `waitMs: 3200`. `drive` is deliberately live — it is the route to
record video of — and is warped to 96.3 s so that window covers the MANJI flick at 100.0 s.

Default drive routes, and what each one is evidence of:

| route | moment |
| --- | --- |
| `drive-idle` | armed, before the run: gauge at rest, GO, nothing claimed |
| `drive` | LIVE mid-drift with callouts on screen (video: `npm run shoot -- --video --only drive`) |
| `drive-peak` | held at 48° right, ×4.5, three callouts stacked (EXTREME ANGLE / MANJI / TRANSITION ×3) |
| `drive-transition` | held 110 ms after TRANSITION ×2, mid-swing through zero, chevron flipped to L |
| `drive-bank` | held just after a 10 000-point chain banked: BANKED ticker, chain bar drained, LINK ×3 |
| `drive-warn` | the same frame as `drive-peak` with a loose mount: the banner has to be impossible to miss while the run is going well |

The `at` values are tied to when the ENGINE fires callouts, so they move whenever the detector
or the scorer is retuned. Re-derive them by pushing the same recording through the pipeline and
printing the events — about 20 lines of node:

```js
import { simulateRun } from './src/sim';
import { DriftPipeline } from './src/engine/pipeline';
const run = simulateRun('harbor', { seed: 1, laps: 2 });
const pipe = new DriftPipeline({ id: 'probe', name: 'probe' });
const t0 = run.motion[0].t;               // `at` is measured from the first MOTION sample
let im = 0, ig = 0;
while (im < run.motion.length) {
  while (ig < run.gps.length && run.gps[ig].t <= run.motion[im].t) pipe.pushGps(run.gps[ig++]);
  const f = pipe.pushMotion(run.motion[im++]);
  for (const c of f.score.callouts) console.log((f.t - t0).toFixed(2), c.label);
  if (f.score.banked) console.log((f.t - t0).toFixed(2), 'BANKED');
}
```

Frames from the video (the bundled ffmpeg's filter parser is unusable — use `-r`, not `-vf fps=`):

```
npm run shoot -- --video --only drive
/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux -i artifacts/video/drive.webm -r 6 /tmp/f%03d.png
```

## Results screen: deterministic fixtures (`/results/...`)

The results screen renders a stored `Session`. For screenshots (and for development before the
app has recorded anything) it can rebuild one from the simulator instead, deterministically:
same URL → same session → same pixels. The numbers on screen always come from the real scorer
(`scoreSession`) and the real cross-lap analysis (`lapConsistency`), never from a mock.

```
/results/fixture-hero                      the `hero` scenario (id form)
/results/anything?fixture=sloppy           the `sloppy` scenario (query form)
/results/demo                              the default scenario (the id the HUD pushes today)
/results/<storedId>                        a real session from storage (no fixture)
```

| `?fixture=` | what it is | what the scorer returned on 20 Sep |
| --- | --- | --- |
| `hero`   | harbor, seed 3, aggression 1.3, consistency 1 (the best the driver model reaches) | **A** 85.2, 14 slides, 2 clean laps |
| `good`   | harbor, seed 7, aggression 0.9, consistency 0.8 | **A** 76.1, 15 slides |
| `sloppy` | harbor, seed 1, aggression 0, consistency 0, the 3 biggest slides forced past the spin threshold | **D** 33.0, 2 spins, ~2 900 points thrown away |
| `spin`   | harbor, seed 4, one slide forced past the spin threshold | **B** 74.1, 1 spin, a chain lost |
| `clean`  | harbor, driven on grip (slip angle under 5°) | **D** 0/100, no drifts at all |
| `rough`  | harbor through the REAL pipeline with a rattling cradle and GPS dropouts | **B** 60.7, calibration 8 %, phantom spins |
| `touge`  | the point-to-point mountain road, one lap | **A** 79.5, no laps → no lap table |

The grades above are what the scorer says, not what the fixture asks for: they move whenever the
scorer is retuned, and that is the point of shooting them. As of this writing S is not reachable
from simulated driving at all — the ceiling across every seed, track and skill setting is ≈ 85.

Overrides (all optional, all clamped): `track=harbor|touge`, `seed=<int>`, `laps=1..6`,
`agg=0..2` (above 1 is a hero lap the driver model cannot normally produce), `cons=0..1`,
`spin=<n>` (force the n biggest slides past the spin threshold), `drifts=none` (grip lap),
`rough=1|0`, `source=sim|pipeline`.

* `source=sim` (default) fills the session from simulator ground truth — about 200 ms.
* `source=pipeline` pushes the simulated sensors through the **real** engine pipeline (mount
  calibration → slip estimator → detector → scorer), which is what the phone runs. Costs about
  a second, and the screen then shows estimator noise, real detector splits and real integrity.

Reveal and motion control (they exist so a screenshot can be reproduced, and because a driver
may have asked the system for less motion):

| param | effect |
| --- | --- |
| `reveal=full` | default: letterbox → black beat → the grade slams in → the page settles |
| `reveal=off` | no reveal at all; the settled page, animations already finished |
| `reveal=hold` | FREEZES the reveal on the black-hold frame (t = 640 ms) |
| `reveal=slam` | FREEZES it mid-slam (t = 1170 ms): shockwave half way out, embers flying |
| `reveal=settle` | FREEZES it as the bars retract (t = 1980 ms) |
| `motion=reduce` | forces reduce-motion: no letterbox, no shake, no embers; the letter and the numbers still arrive |
| `motion=full` | forces full motion even when the OS asks for less (screenshots only) |

A frozen reveal never completes, so the page underneath is rendered in its settled state and the
overlay sits on top for as long as you like — which is what makes `results-reveal-slam.png`
reproducible. With `reveal=full` the whole thing is skippable: a tap anywhere jumps to the end.

Video of the reveal: `npm run shoot -- --video --only results-reveal`, then pull frames with the
bundled ffmpeg (its filter parser is unusable in this build, so use `-r`, not `-vf fps=`):

```
/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux -i artifacts/video/results-reveal.webm -r 12 /tmp/f%03d.png
```

## Gotchas this harness already handles (keep them in mind when extending it)

- **Chromium build mismatch.** playwright 1.63 wants build 1243; the sandbox ships build 1194 under
  `$PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and cannot download (no CDN). `browser.mjs` resolves
  the executable itself (`CHROMIUM_PATH` env, then playwright's default if present, then the newest
  `chromium-*/chrome-linux/chrome`). Never run `playwright install`.
- **WebGL in headless.** Skia web (`CanvasKit.MakeWebGLCanvasSurface`) has no software fallback; a
  missing WebGL context throws "Could not create surface". Headless Chromium 141 renders WebGL via
  SwiftShader here; the launch flags in `browser.mjs` (`--use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader --ignore-gpu-blocklist`) keep it that way across builds.
- **`application/wasm`.** CanvasKit is fetched from `/canvaskit.wasm` (copied into `public/` by
  `scripts/copy-canvaskit.mjs`, served by `staticServer.mjs` with the right MIME so
  `WebAssembly.instantiateStreaming` works). A wrong MIME only slows it down; a 404 breaks Skia.
- **Skia import order on web.** `@shopify/react-native-skia` binds `global.CanvasKit` when its module
  is evaluated, so nothing may import it before `LoadSkiaWeb` resolves. Screens import Skia
  components through platform-split wrappers (`src/ui/skia/*View.web.tsx` use `WithSkiaWeb` +
  dynamic `import()`); the root layout also gates all routes on `useSkiaReady()`. In development
  expo-router evaluates *every* route module eagerly, so a static Skia import in a route file
  breaks web even if that route is never opened.
- **Static routes.** `web.output: "static"` writes one HTML per route (`drive.html`,
  `results/[id].html`, ...). The server maps `/results/anything` to `results/[id].html`, descends
  into `(group)` folders, matches `[...catchall].html`, and falls back to `index.html` for unknown
  route-like paths (asset-like misses are 404 so broken references show up).
- **Hydration.** Static HTML is hydrated on load; the root layout renders an identical bg0
  placeholder (`data-testid="boot"`) on the server and on the first client render, then swaps in
  the navigator once fonts and CanvasKit are ready. `waitForApp()` waits for that placeholder to
  detach before measuring anything.
- **Fonts.** expo-font registers each face under its asset name (`BarlowCondensed_800ExtraBold_Italic`,
  `Barlow_400Regular`, ...). The harness waits for `document.fonts` to report a Barlow face and
  counts leaf text nodes per family, so a fallback font on any screen is caught.
- **Videos** need playwright's ffmpeg build (`ffmpeg-1011`, present). Each route records into its own
  browser context; the file is moved to `artifacts/video/<name>.webm` after the context closes.
- **A HUD that is still warping.** `?at=` runs its warp synchronously when the run starts, which is
  after the source is selected (`selectSensorSource` generates the simulated run first). Give a
  held drive route at least `waitMs: 2400`, or the screenshot lands mid-warp on an earlier frame.
- **Skia fonts are fetched separately.** The gauge's hero numeral is drawn by Skia from the Barlow
  Condensed .ttf, which `useFont` loads over the network. For the first ~0.5 s after the canvas
  mounts the numeral is absent (the arc and needle are not). Every screenshot waits long enough;
  the first second of a video does not.
- **Running as root** works because playwright launches Chromium with `--no-sandbox` semantics by
  default (`chromiumSandbox: false`).
