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

## Garage: seeding the session list (`/?demo=...`)

The garage draws whatever is in storage, and every browser context the harness opens starts
with storage empty — so `/` on its own **is** the empty-garage state. `?demo=<set>` fills it
first, with real runs rather than mock rows:

```
/?demo=night     six runs across two tracks, one of them NOT SCORED   (the default demo)
/?demo=harbor    four scored runs on one track — every personal best filled in
/?demo=first     one run
/?demo=flagged   the last run was hand-held and thrown out — the garage's mount notice
/?demo=none      wipe the garage (also `clear`, `empty`, `0`)
```

Each run is built by the results screen's own fixture builder (`buildFixtureSession` — the
simulator, and the REAL engine pipeline for the hand-held one), scored by the REAL scorer
(`buildResultsModel`), and the score written back into `Session.score` before it is stored, so
the grade on a row is the grade the results screen shows when you tap it. Building a set costs
1–3 s and the screen says so while it works (`data-testid="garage-seeding"`), which is why the
garage routes carry `waitMs: 6000`–`8000`.

Two economies make this possible and are worth knowing before changing the sets
(`src/ui/garage/demo.ts`):

* **bodies are stored trimmed** — no `motion`, `gps`, `states` or `truth`. A full fixture
  session is ~10 MB of JSON, and six of them are twice a browser's whole localStorage quota;
  trimmed they are ~85 KB each. Everything the garage reads (score, drifts, integrity,
  calibration, meta) survives.
* **every id is `fixture-<name>`**, which is exactly what `/results/fixture-<name>` rebuilds
  from the simulator — so tapping a row still opens the full run, samples and all. That is also
  why the demo sets may only use names that exist in `FIXTURES`: an unknown `fixture-<x>` id
  falls back to the DEFAULT fixture on the results screen, and the row would then open a
  different run from the one it describes. Seed overrides travel in `Session.meta.fixtureQuery`
  and the garage passes them through when it opens a row.

The seeds are chosen so no two runs share a minute: the fixture builder dates a run
`19 Sep 2026, 21:44 + <seed> minutes`, and the list is sorted newest first.

| route | what it is evidence of |
| --- | --- |
| `home` | the empty garage — it has to be inviting, not apologetic |
| `garage` | six runs: DRIVE dominant, the big last-run card, the start of the bests board |
| `garage-bests` | personal bests per track: best grade, most points, biggest angle, longest chain |
| `garage-runs` | the run list, including the NOT SCORED row for the hand-held recording |
| `garage-bests-harbor` | one track, four scored runs: no dashed-out records |
| `garage-simbay` | the demo bay: simulated source, mount looseness and GPS dropouts selectable |
| `garage-flagged` | the one state where the garage mentions calibration: the last run was thrown out |
| `garage-delete` | the confirmation a delete asks for (`Alert` is a no-op on web, so it is the app's own) |

**A run with no grade.** A row may not print a grade letter until it knows whether the engine
vouched for the run, and `SessionIndexEntry` does not carry that (`trusted`), nor the best angle
or the longest chain. Those three are read out of the session body, newest first, and a row is a
skeleton until its own read lands — see `src/ui/garage/facts.ts`. If `summarizeSession` ever
grows those fields the whole read disappears.

## Calibrate: freezing a moment of the calibration (`/calibrate?...`)

The calibration screen runs the real `MountCalibrator` and the real `IntegrityMonitor` over the
same recordings the HUD plays, so its states arrive on the recording's clock. Two parameters
(`src/ui/calibrate/params.ts`) stop it wherever a screenshot needs it, and one changes where the
phone is sitting:

| param | effect |
| --- | --- |
| `at=<seconds>` | feed the calibrator every sample up to that instant of the recording at once |
| `hold=1` | stop there. The frame is then deterministic: same URL, same pixels |
| `mount=portrait-vent\|landscape-dash\|flat-console` | REGENERATE the recording with the phone sitting that way. Not a presentational override — the simulator really puts the phone on the console, and the screen reads it back out of the gravity vector like any other mount |
| `why=rejected\|loose\|unresolved\|suspect` | why the driver was sent here. The garage sets it when the last run left evidence, and the screen leads with that instead of a generic invitation |

The usual `sim=` / `rate=` / `seed=` / `laps=` / `looseness=` / `dropouts=` still pick the
recording, which is how the loose-mount state is photographed from a genuinely hand-held drive
rather than a flag.

On `sim=harbor&seed=1` the real calibrator does this, and the `at` values below follow from it
(they move when the calibrator is retuned — re-derive them by pushing the recording through
`MountCalibrator` and printing `calibration.quality` / `forwardResolved`):

| t | what has happened |
| --- | --- |
| 0.5 s | gravity seen, up-axis quality 0.50, nothing resolved |
| 1.5 s | the vertical has settled (up-axis 0.90) |
| 5.31 s | the forward axis resolves — `forwardBlockS` is 4 s, then one hard pull is enough |
| 12 s+ | confidence plateaus at **0.74** |

| route | moment |
| --- | --- |
| `calibrate` | at rest, half a second in: nothing worked out yet |
| `calibrate-level` | the vertical settled, the forward axis still unresolved — the state the screen exists for |
| `calibrate-ready` | calibrated: past the bar, both axes resolved |
| `calibrate-loose` | a real hand-held recording (`looseness=1&dropouts=1`): the monitor's own words |
| `calibrate-flat` | the phone lying flat on the console, detected from gravity |
| `calibrate-rejected` | arrived because a run was thrown out — the normal way into this screen |

**This screen is not a step in the flow.** Calibration happens by itself while driving
(docs/DESIGN.md, "the whole app is four steps"), so the garage never invites anyone here. It
links here only when the LAST run left evidence — `mountAdvice` in `src/ui/garage/advice.ts` —
and passes `?why=`, which is what `garage-flagged` and `calibrate-rejected` photograph together.

**Why the screen's bar is not `docs/DESIGN.md`'s 0.8.** The calibrator's confidence is
`upQuality × (0.4 + 0.6·min(lineQuality, signQuality))`, and `upQuality` is capped by the
accelerometer fit — which road vibration limits. On the simulator's default vibration (`1`, "a
typical dash mount on a track") the ceiling across seeds and mounts is **0.74**; only at
`vibration: 0` does it reach 0.801. A DONE gate at 0.8 would therefore almost never light up in
a car. The screen instead uses the bar the ENGINE uses before it will believe a slide —
`IntegrityMonitor`'s `calibrationOk`: `quality >= minCalibrationQuality` (0.3) with the forward
axis resolved — and marks 0.75 as the second, softer tick, because that is where the results
screen stops qualifying a score for its mount. Both ticks are drawn on the dial.

**Mount warm-up.** Every mount cue in the integrity monitor is an exponential RMS over
`windowS`, so for the first two windows a perfectly bolted phone reads `suspect` — on the
simulator's own rigid mount, from 0.2 s to 4.1 s. The calibration screen reports the mount as
"Listening" until `2 × windowS` of data has gone in (`MOUNT_WARMUP_S`), rather than accusing a
driver who has done nothing wrong.

## Drive HUD: seeking and freezing a moment (`/drive?...`)

The HUD is only interesting while the car is sideways, so the harness does not photograph it at
t = 0. `src/ui/hud/hudParams.ts` adds four query parameters on top of the `sim` / `rate` / `seed`
/ `laps` ones that pick the recording:

| param | effect |
| --- | --- |
| `at=<seconds>` | WARP: feed the pipeline every sample up to that instant of the recording at once, silently (no callouts animate, no haptics), then carry on from there. ~11 000 samples take about 0.3 s. |
| `hold=1` | FREEZE at `at`: no further samples. The frame is then deterministic — the same URL gives the same pixels, verified by shooting one URL three times 2.5 s apart. |
| `run=1` | Accepted and harmless. Opening `/drive` starts the run by itself — there is no arming step (docs/DESIGN.md, "the whole app is four steps"), so every route below is a live run. |
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
| `drive-open` | the instant the screen opens: a live run at 0:00, gauge at rest, nothing claimed |
| `drive-start` | the first seconds of EVERY run — forward axis not resolved yet, so a calm cyan FINDING FORWARD, muted gauge, no score. This state used to open every run with a red alarm |
| `drive` | LIVE through the MANJI flick at 42.4 s (video: `npm run shoot -- --video --only drive`) |
| `drive-peak` | held at 48° right, ×4.5, 22,675 points, 7,927 at risk, three callouts stacked |
| `drive-transition` | held 190 ms after TRANSITION ×2, mid-swing through zero, chevron flipped to L |
| `drive-bank` | held just after a 10,528-point chain banked: BANKED ticker, chain bar drained, LINK ×3 |
| `drive-loose` | a REAL hand-held run (`looseness=1`): muted gauge, no bloom, grey score, "these points may not stand" |
| `drive-lost` | the same run 0.2 s after the slide spun: CHAIN LOST |
| `drive-gps` | a REAL GPS dropout (`dropouts=1`) 1.2 s into the gap: GPS LOST is severe because a fix had been held |

`looseness` and `dropouts` go through the SIMULATOR (`src/platform/simParams.ts`), so those three
routes exercise the estimator, the detector and the integrity monitor on genuinely bad data. The
`integrity=` override stays for one narrow job — proving the banner's own rendering — and should
not be used as evidence that the app notices anything.

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

| `?fixture=` | what it is | what the scorer returned when this table was regenerated |
| --- | --- | --- |
| `hero`   | harbor through the REAL pipeline, aggression 1.3, consistency 1 — the best the driver model reaches | **S** 92.5 · 8 slides · 2 clean laps |
| `good`   | harbor through the REAL pipeline, aggression 0.9, consistency 0.8 | **A** 86.1 · 8 slides |
| `sloppy` | harbor, aggression 0, consistency 0, the 3 biggest slides forced past the spin threshold | **D** 26.3 · 11 slides · 3 spins |
| `spin`   | harbor, one slide forced past the spin threshold | **B** 74.7 · 1 spin, a chain lost |
| `clean`  | harbor, driven on grip (slip angle under 5°) | **D** 0/100 · no drifts at all |
| `rough`  | harbor through the REAL pipeline with an unsteady cradle and GPS dropouts | **B** 74.1 · scored, with warnings |
| `handheld` | harbor through the REAL pipeline with the phone in someone's hand (`loose=1`) | **no score at all** — the engine refuses to publish one |
| `touge`  | the point-to-point mountain road, one lap | **A** 88.4 · no laps → no lap table |

The showcase scenarios (`hero`, `good`, `rough`, `handheld`) run through the **real pipeline** on
purpose. Ground truth replays the same lap plan every lap, so cross-lap spreads come out at
exactly 0.0 m and the screen would be publishing a simulator artifact as the driver's
repeatability; through the pipeline the estimator's own noise is in the numbers.

The grades move whenever the scorer is retuned — that is the point of shooting them. Regenerate
this table with:

```
npx tsx -e "import{buildFixtureSession,FIXTURES}from'./src/ui/results/fixture';import{buildResultsModel}from'./src/ui/results/model';\
for(const k of Object.keys(FIXTURES)){const m=buildResultsModel(buildFixtureSession(FIXTURES[k]));\
console.log(k,m.trusted?m.grade:'no score',m.rating,m.drifts.length+' slides',m.stats.spins+' spins');}"
```

Overrides (all optional, all clamped): `track=harbor|touge`, `seed=<int>`, `laps=1..6`,
`agg=0..2` (above 1 is a hero lap the driver model cannot normally produce), `cons=0..1`,
`spin=<n>` (force the n biggest slides past the spin threshold), `drifts=none` (grip lap),
`loose=0..1` (0 rigid, 0.7 rattling cradle, 1 hand-held; `rough=1` is a 0.7 alias),
`source=sim|pipeline`.

**The refusal state.** When `Session.integrity.scoreTrusted` (mirrored on `SessionScore.trusted`)
is false, the results screen must not present the run as an achievement, and does not: no grade
letter (a red NOT SCORED plate takes its place), no grade rail, no reveal, component bars empty
with "--" instead of numbers, no callout points, no lap-consistency table, the drift list without
its points column, the total labelled "points logged · a floor, not a measurement", SHARE
disabled, and the primary action reading WATCH THE RECORDING. `?fixture=handheld` photographs it
(`results-untrusted.png`, `results-untrusted-foot.png`).

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

## Replay: the cinematic stage (`/replay/[id]?...`)

The replay draws the scene model in `src/engine/replay` — the same data the SVG reference
renderer (`tools/analysis/render-replay.ts`) draws for the critic — on one full-bleed Skia canvas,
with the HUD over true letterbox bars. The frame loop lives in `src/ui/replay/ReplayCanvas.tsx`
and never touches React: the clock, the transport and the scrub position are Reanimated shared
values, and the picture is handed to Skia through one of them.

**Which session plays.** `/replay/<storedId>` plays a recording from storage. Anything the
results screen's fixture resolver recognises rebuilds the same deterministic session instead, so
a deep link from a fixture result lands on the same run:

```
/replay/demo                      the default fixture (`good`) — the id the app pushes today
/replay/fixture-handheld          the hand-held recording the engine will not score
/replay/x?fixture=rough&gaps=6    any fixture by name, plus the overrides below
```

`fixture`, `source=sim|pipeline`, `track`, `seed`, `laps`, `agg`, `cons`, `spin`, `drifts`,
`loose` and `rough` all mean exactly what they mean on the results screen (see above).

**Replay parameters** (`src/ui/replay/params.ts`; everything is optional and clamped):

| param | effect |
| --- | --- |
| `t=<seconds>` | seek there on open (replay-relative). The results screen pushes this |
| `drift=<id>` | seek to that drift and pick its ribbon out with a white halo, with a chip naming it. The results screen pushes this when a drift row is tapped |
| `hl=<n>` | jump to the nth-best highlight (1-based) and name it in a chip |
| `cam=overview\|chase\|cinematic` | camera mode (`track` and `cine` also work) |
| `play=0\|1` | freeze on the opening frame, or start playing (default: play) |
| `rate=<n>` | playback speed. The transport offers x0.5 / x1 / x2; the URL may ask for any rate, which is how motion is captured (see below) |
| `scrub=<0..1>` | open with the playhead GRABBED at that fraction of the run: the same shared values a real drag writes, so the frame is the held state (fat playhead, time bubble, camera cut to the new moment) |
| `ghost=time\|distance\|off` | how the best-lap ghost is placed, or no ghost at all |
| `gaps=<seconds>` | blank the recorded positions (and the fixes behind them) for that long in the middle of the run — a tunnel. This damages the RECORDING, so `buildReplay`'s own warnings fire and the renderer has a real hole to be honest about |
| `ui=1\|0` | pin the transport controls on, or hide them (which is what the app itself does a few seconds into playback) |
| `motion=reduce\|full` | force reduce-motion (no shake, no grain, no speed streaks, no callout overshoot) or force full motion |

A synthetic pointer sequence cannot drive the scrubber: react-native-gesture-handler calls
`setPointerCapture`, which throws for a pointer id the browser never issued, and that uncaught
error fails the whole shoot. `scrub=` exists for exactly this reason. A real drag
(`page.mouse.down/move`) works and raises nothing.

| route | what it is evidence of |
| --- | --- |
| `replay` | LIVE from 01:33 in chase: the route to record video of |
| `replay-motion` | quarter speed at the callout beat — the video route for the slam and the shake |
| `replay-cut` | the camera cut: chase, then CINE tapped 1.2 s in, at quarter speed |
| `replay-shake` | quarter speed from TRACK CAM, where the camera is still, over the biggest beat of the run |
| `replay-overview` | TRACK CAM at the half-way point: the whole circuit, only the part already driven |
| `replay-chase` | CHASE at the peak of the 3-link chain: 41 deg, ribbon, smoke, slip arc, ghost |
| `replay-cinematic` | CINEMATIC 120 ms after TRANSITION x3: the magenta chip and the callout mid-hold |
| `replay-ghost` | the best-lap ghost far enough off the line to be a car rather than a badge |
| `replay-highlight` | a highlight jump, named by its chip |
| `replay-scrub` | the scrubber held mid-drag |
| `replay-untrusted` | a hand-held recording: it plays, and it presents no points and no grade |
| `replay-warnings` | six seconds of position blanked: the DATA GAPS plate, dashed dead reckoning, the gap marked on the timeline |
| `replay-warnings-open` | the plate opened: the engine's own sentences behind it |
| `replay-end` | the last frame, where the grade finally lands |
| `replay-from-results` | the deep link end to end: REPLAY THIS DRIFT on the results screen lands in the replay at that moment, with the drift picked out |
| `replay-touge` | a point-to-point stage: STAGE rather than LAP 1/2, no lap ticks, no ghost |

**Frame rate, and how to capture motion.** The harness renders WebGL through SwiftShader, in
software. A full-bleed cinematic scene costs it about 170 ms a frame at `--scale 1` and 650 ms at
the default `--scale 3` (measured: the same page with the scene switched off runs at 60 fps, and
the drive HUD in this browser manages about 5 fps too). Nothing about that is the app on a phone,
where the same picture is one GPU pass, but it does mean a 1x video of this screen is a
slideshow: a 320 ms callout slam lands in one and a half frames.

So capture motion at quarter speed and at scale 1, which resolves every beat into frames without
changing what the app does — the motion is the app's own, sampled finer:

```
npm run shoot -- --no-build --video --scale 1 --only replay-motion,replay-cut,replay-shake
/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux -i artifacts/video/replay-motion.webm -r 25 /tmp/m%03d.png
```

What those frames show, measured rather than asserted:

* **the callout slam** — the magenta area of TRANSITION x3 falls 4086 -> 2516 -> 1850 -> 1431 ->
  1242 px and then rises to 1385 and holds: scale 1.8 to 1.0 with the overshoot going *past* the
  resting size and coming back, which is the engine's own `activeEvents` curve;
* **the shake** — on the still TRACK CAM, a static road edge sits at y = 358.98 for every frame
  before the exit beat, jumps to 360.22 on it, then 359.23, 358.53, 358.63, and settles at
  358.99: a decaying oscillation about the resting position, 180 ms long;
* **the camera cut** — mean frame luminance steps 17.4 (chase) -> 25.3 (the cross-fade frame,
  still darkened) -> 36.2 (cinematic, at full brightness), which is the engine's 120 ms cross-fade
  measured in replay time, so it slows down with the playback rate like everything else.

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
