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
