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

| `?fixture=` | what it is | what the scorer says |
| --- | --- | --- |
| `hero`   | harbor, seed 3, aggression 1.8, consistency 0.96 | **S**, 90.4/100, 16 slides, 2 clean laps |
| `good`   | harbor, seed 7, aggression 0.9, consistency 0.8   | **A**, 76.9/100, 18 slides |
| `sloppy` | harbor, seed 5, aggression 0, consistency 0        | **D**, 38.7/100, wandering corners |
| `spin`   | harbor, seed 4, the biggest slide pushed past 85°  | **B**, one spin, a chain thrown away |
| `clean`  | harbor, driven on grip (slip angle under 5°)       | **D**, 0/100, no drifts at all |
| `rough`  | harbor with a rattling cradle and GPS dropouts     | **B**, two integrity warnings |
| `touge`  | the point-to-point mountain road, one lap          | **A**, no laps → no lap table |

Overrides (all optional, all clamped): `track=harbor|touge`, `seed=<int>`, `laps=1..6`,
`agg=0..2` (above 1 is a hero lap the driver model cannot normally produce), `cons=0..1`,
`spin=1|0`, `drifts=none` (grip lap), `rough=1|0`, `source=sim|pipeline`.

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
- **Running as root** works because playwright launches Chromium with `--no-sandbox` semantics by
  default (`chromiumSandbox: false`).
