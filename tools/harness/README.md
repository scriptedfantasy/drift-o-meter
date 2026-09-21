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
`--port <n>`, `--no-font-check`, `--full-page`, `--scale <n>` (device pixel ratio, default 3),
`--fresh` (rewrite the aggregates instead of merging into them).

## Outputs

- `artifacts/shots/<name>.png` (or `<name>-landscape.png`)
- `artifacts/shots/console.log`: every console message, page error, failed request and HTTP >= 400,
  grouped per route. **A partial run (`--only`) merges**: it replaces the blocks for the routes it
  actually shot and keeps every other route's, because this file is one aggregate for the whole
  app while almost every run covers one screen. Without that, the last agent to shoot silently
  erased everyone else's record and left a file that looks complete and covers one screen.
  `--fresh` rewrites it from nothing, for a full run that should start clean.
- `artifacts/shots/report.json`: merged the same way, and it distinguishes `failed` (this run)
  from `failedAll` (the whole aggregate) and lists `shotThisRun`, so neither can be read as the
  other. Each route carries `shotAt`, so a stale entry is visible rather than implied. Per route, the fonts that loaded, how many text nodes render in
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
  regions: [                              // "at most / at least N pixels of colour C inside R"
    { name: 'gauge', colour: 'ember', testId: 'hud-gauge-box', padFrac: 0.01, max: 120 },
    { name: 'stage', colour: 'ember', rect: { x: 0, y: 0.1, w: 1, h: 0.5 }, min: 400 },
  ],
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

### Colours, and why a floor cannot certify an absence

`minEmber` proves something drew. It cannot prove something did NOT draw, and several routes
exist precisely to show that a screen stays quiet — a hand-held run, a slide the scorer paid
nothing for, a lap with nothing in it. Those need a ceiling, and the ceiling has to be measured
in the part of the screen the claim is about: a loose-run peak frame drew 63,983 ember pixels
*inside the gauge* on a run worth zero points, and passed every floor in this file.

So a route may carry `regions`. Each entry names one colour and one rectangle and gives a `max`,
a `min`, or both; a violation fails the route and the message quotes the count and the box.

* `colour` — `ember`, `gold`, `red`, `magenta`, `cyan`, `green`, `text`, `muted`. These are HUE
  BANDS with a saturation and a brightness floor (`tools/harness/pixels.mjs`), not RGB boxes.
  The old `isEmber` was a box, and it counted the red `#FF3B3B` warning banner and every
  antialiased gold pip as ember — so `drive-loose`'s "30,591 ember pixels" were mostly the two
  elements that are supposed to be loud. Re-derive any threshold you inherit from before that.
* `testId` — the element the region is about. Preferred over `rect`, because the harness measures
  the element and the check therefore means the same thing portrait, landscape and at any
  `--scale`. `padFrac` grows the box by that fraction of the viewport, to take in a glow that
  spills past the element's own bounds.
* `rect` — `{ x, y, w, h }` in FRACTIONS of the image, when there is no element to name.

Chromium renders DOM text with subpixel antialiasing, which leaves a few hundred warm fringe
pixels along glyph edges anywhere on the screen. Set a ceiling above that noise floor; a Skia
canvas (the gauge, the map, the replay stage) has no such fringe and measures 0.

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

**The list reads no session bodies.** `SessionIndexEntry` carries `trusted`, `peakAngleDeg` and
`longestChainPoints`, so grade, points, best angle and the NOT SCORED state are all drawn from
the index the moment it is read. Exactly one body is fetched, off the render path: the newest
run's, for the integrity monitor's own sentence behind the mount notice (`lastRun.ts`), plus one
more when a demo row is actually opened, to carry its seed override to the results screen. A
`trusted` field missing from an entry written before it existed reads as FALSE, so an old row
shows the NOT SCORED plate rather than awarding a grade it cannot vouch for — which is why a
demo set is re-seeded rather than reused.

**The stored score is the published score.** A `pipeline` demo fixture keeps the score the
pipeline gave it; only a `sim` fixture (which never ran the pipeline and carries
`sessionFromSimulation`'s placeholder) is re-scored before storing. The seeding used to
overwrite every score with the results screen's re-score, which meant the repository's
screenshots depicted a garage/verdict agreement that real runs did not get.

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
| `fault=permission\|location\|unsupported\|services\|failed` | show one of the four faults instead of starting the sensors. Presentation only, exactly like the drive display's `?integrity=`: these four states are the reason the screen exists and are otherwise unreachable without breaking a phone |

The usual `sim=` / `rate=` / `seed=` / `laps=` / `looseness=` / `dropouts=` still pick the
recording, which is how the loose-mount state is photographed from a genuinely hand-held drive
rather than a flag.

On `sim=harbor&seed=1` the real calibrator does this, and the `at` values below follow from it
(they move when the calibrator is retuned — re-derive them by pushing the recording through
`MountCalibrator` and printing `calibration.quality` / `forwardResolved`):

| t | what has happened |
| --- | --- |
| 0.5 s | gravity seen, up-axis quality 0.50, nothing resolved |
| 1.62 s | the vertical has settled — `MountCalibrator`'s own `upSettled`, i.e. `upSettleS` of gravity data |
| 2.02 s | the mount cues have a full averaging window behind them, so `mountConfident` turns true and the mount verdict starts to mean something |
| 5.31 s | the forward axis resolves — `forwardBlockS` is 4 s, then one hard pull is enough |
| 6.34 s | confidence PEAKS, at 0.740 on this seed, and drifts down from there |
| 12 s+ | 0.736, easing towards 0.698 by the end of the run |

That peak-then-settle is not a property of seed 1: over the 48-run grid the final confidence is
below the peak in **48 of 48** (median −0.017, worst −0.114 on harbor / flat-console / seed 5,
0.618 → 0.504), with the peak between 5.1 s and 8.0 s. Run
`npx tsx tools/analysis/calibration-sweep.ts trajectory`.

**That measurement is not the question the READY footer asks, and one round was lost to the
difference.** Comparing FINAL to PEAK became the sentence "as sharp as it gets — it peaks
seconds after you drive off, and never climbs later", which is READ at first READY. First READY
lands at 4.6–5.3 s and the peak at 5.1–8.0 s, so the number climbs under the word "never" in
**33 of 48** runs (≥ 0.05 in 13, ≥ 0.10 in 8, worst +0.209 on harbor / portrait-vent / seed 6:
0.589 at 4.6 s → 0.798 at 5.5 s), and the headline's own colour flips ember → green in 22 of 48.
`npx tsx tools/analysis/calibration-sweep.ts ready` measures the rendered footer on every READY
frame instead. The footer now quotes `MountCalibrator`'s published running peak — "Best so far
N %" — which is a fact on every frame rather than a forecast, and the same command checks it:
**0 of 198,325 READY frames misstated it.** Any sentence about how this number behaves over time
has to be measured where the driver READS it, not at the end of the run.

| route | moment |
| --- | --- |
| `calibrate-nothing` | ZERO samples (`hold=1` with no `at`): the screen with nothing to report |
| `calibrate` | at rest, half a second in: nothing worked out yet |
| `calibrate-level` | the vertical settled, the forward axis still unresolved — the state the screen exists for |
| `calibrate-ready` | calibrated: past the bar, both axes resolved |
| `calibrate-loose` | a real hand-held recording (`looseness=1&dropouts=1`): the monitor's own words |
| `calibrate-flat` | the phone lying flat on the console, detected from gravity |
| `calibrate-rejected` | arrived because a run was thrown out — the normal way into this screen |
| `calibrate-shaking` | `mount === 'suspect'`: everything resolved, 34 % confidence, and the screen says MOUNT SHAKING rather than "Ready to measure" |
| `calibrate-early` | 2 s into a hand-held recording. The mount cues reach `loose` first (0.67–1.25 s at looseness 1), so this frame is the monitor having decided; the vertical has not settled and no step is ticked |
| `calibrate-cradle-banner` | the gold MOUNT LOOKS UNSTEADY banner under a FINDING FORWARD headline — the two sentences that used to be the same one |
| `calibrate-gps` | a GPS dropout getting its own row on a screen with no GPS light, on a READY frame reading 61 % that peaked at 76 % |
| `calibrate-fault-permission` | motion access denied |
| `calibrate-fault-location` | location access denied — a different switch from the one above, so a different fault |
| `calibrate-fault-unsupported` | no gyroscope on this device |
| `calibrate-fault-services` | location services off |
| `calibrate-fault-failed` | the motion stream would not open |

**This screen is not a step in the flow.** Calibration happens by itself while driving
(docs/DESIGN.md, "the whole app is four steps"), so the garage never invites anyone here. It
links here only when the LAST run left evidence — `mountAdvice` in `src/ui/garage/advice.ts` —
and passes `?why=`, which is what `garage-flagged` and `calibrate-rejected` photograph together.

**The screen keeps no thresholds of its own any more.** It used to hold two on engine
quantities: `MOUNT_WARMUP_S = 2 × windowS` (4 wall-clock seconds before the mount verdict was
allowed to mean anything) and `SETTLED_UP = 0.6` on the VERTICAL light. Both were wrong in the
way `src/engine/integrity/band.ts` warns about. The warm-up was sized to outlast a startup
transient and was measured SHORTER than it — 30 of 48 rigid runs still read `suspect` past it,
to 4.81 s — and the transient itself was a defect in `MountCalibrator` (the first sample of
every run was rotated with a body-up axis that had not been built yet, putting ~12 m/s² of
acceleration that never happened into a 0.3 Hz high-pass and thence into a 2 s RMS that held it
for ~4.6 s). `SETTLED_UP` compared against `upQuality`, which is age × accelerometer fit, so a
rattling cradle spoiled the fit and the phase read READY while the VERTICAL light read
"Settling" on 72–100 % of READY frames at looseness 0.1–0.15. Now the engine names both edges
(`IntegrityState.mountConfident`, `MountDiagnostics.upSettled`) and
`npx tsx tools/analysis/calibration-sweep.ts warmup` measures the result: **0 frames** call a
bolted-down phone unsteady across 24 rigid runs, and **0** READY frames anywhere show
"Settling".

**A mount banner says what the monitor said about the MOUNT.** `IntegrityState.message` is the
ROOT CAUSE — a strict priority list in which an unresolved calibration and a lost GPS fix both
outrank a shifting cradle — which is right for the HUD's one integrity line and wrong under a
heading this screen chose. Quoting it printed a forward-axis sentence under MOUNT LOOKS
UNSTEADY on 105,439 of 105,439 measured caution frames and a GPS sentence under MOUNT SHAKING
on 2,760 of 102,944. `IntegrityState.mountMessage` and `gpsMessage` answer per topic; `message`
still ranks. `npx tsx tools/analysis/calibration-sweep.ts rows` counts the rendered strings:
**174,848 of 174,848** mount-titled rows now carry a mount sentence.

**Why the screen's bar is not `docs/DESIGN.md`'s 0.8.** The calibrator's confidence is
`upQuality × (0.4 + 0.6·min(lineQuality, signQuality))`, and `upQuality` is capped by the
accelerometer fit — which road vibration limits.

This paragraph used to say "the ceiling across seeds and mounts is **0.74**; only at
`vibration: 0` does it reach 0.801", and that was wrong, from one seed. `docs/DESIGN.md` carries
a correction block about exactly this claim and it did not reach here or
`src/ui/calibrate/model.ts`. Re-derived over 2 tracks × 3 mounts × 8 seeds with
`npx tsx tools/analysis/calibration-sweep.ts ceiling`, at the simulator's **default** vibration:

| | peak confidence |
| --- | --- |
| range | 0.618 – 0.864 |
| median | 0.750 |
| ≥ 0.75 | 24 / 48 |
| ≥ 0.80 | 9 / 48 |

and across vibration 0/1/2/3 (192 runs, `… calibration-sweep.ts vibration`) the peak reaches
0.75 in 86 of them and 0.869 at best. There is no ceiling at 0.74 or anywhere else; there is a
spread that moves with the seed, and seed 1 — the harness default — happens to sit near its
bottom. A gate at 0.8 would still be wrong, but because it lights on 9 runs in 48, not because
it is unreachable.

So the screen uses the bar the ENGINE uses before it will believe a slide —
`IntegrityMonitor`'s `calibrationOk`: `quality >= minCalibrationQuality` (0.3) with the forward
axis resolved — and marks 0.75 as the second, softer tick, because that is where the results
screen stops qualifying a score for its mount. Both ticks are drawn on the dial. `qualityBand`
reads `calibrationOk` itself rather than comparing against 0.3 again, so the band and the
headline cannot disagree about the same reading.

**Nothing is claimed before there is evidence.** `IntegrityMonitor` starts life with
`calibrationOk` true, because a monitor that has seen nothing must not veto a run. That is the
engine declining to object, not the engine asserting a good mount — and reading it as a verdict
put CALIBRATED / "Ready to measure" on screen with zero samples, dashes for confidence and a red
"No reading" light underneath. `phaseOf` now tests `samples === 0` first and requires a resolved
forward axis before READY. Worth remembering as a shape: an engine's internal permissiveness is
not an assertion a screen may repeat.

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
* the score odometer is filtered in the 100 Hz sample callback, not by an animation, and snaps
  to the exact total once it is within a few points — so a frozen frame always shows whole
  digits rather than a column caught mid-roll. After a warp it is landed outright.

A live route (no `hold`) is NOT frame-exact: the screenshot lands wherever playback has reached,
about 4.5 s after `at` with `waitMs: 3200`. `drive` is deliberately live — it is the route to
record video of — and is warped to 39.2 s so that window covers the MANJI flick at 42.4 s and
EXTREME ANGLE at 42.8 s.

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
| `drive-discarded` | STOP pressed on a run that never left walking pace: NOTHING TO SCORE instead of filing it or dropping the driver into the garage without a word |
| `drive-savefail` | STOP pressed on a real run whose WRITE then fails: the finished verdict (grade, points, drifts, peak, duration) is handed back beside the storage layer's own sentence, with the retry labelled from the error |

`looseness` and `dropouts` go through the SIMULATOR (`src/platform/simParams.ts`), so those three
routes exercise the estimator, the detector and the integrity monitor on genuinely bad data. The
`integrity=` override stays for one narrow job — proving the banner's own rendering — and should
not be used as evidence that the app notices anything.

The two stop routes use actions rather than parameters, so nothing in the app knows it is being
tested. `drive-discarded` taps STOP at 0.3 s, when the recording is still at rest. `drive-savefail`
breaks `Storage.prototype.setItem` with a `QuotaExceededError` — which is exactly what a full
localStorage throws — so `src/platform/storage.ts` raises its real `StorageError` and the HUD's
failure path runs for real. Neither one needs a debug flag in the shipped code.

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

The two frozen reveal shots warn that a corner pixel is `#000000` rather than `#07090D`. That is
the letterbox, and it is deliberate: the bars have to read as bars against the bg0 stage between
them, which they cannot do if they are painted in bg0. Same device as the replay's letterbox.

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
| `rate=<n>` | playback speed, 0.25 to 4. The transport offers x0.5 / x1 / x2; the URL may ask for the slower rates too, which is how motion is captured (see below) |
| `cutTo=<mode>` + `cutAt=<seconds>` | switch the camera to that mode when the clock passes that replay time — the same cut the control fires, off the clock, so it can be recorded without a tap |
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
software. A full-bleed cinematic scene costs it roughly 250–400 ms a frame at `--scale 1` and
1.5–2 s at the default `--scale 3`; the same page with the scene switched off runs at 60 fps, and
the drive HUD in this browser manages about 5 fps too, so this is the rasteriser rather than the
app (the JS half of a frame — every engine call plus recording the picture — measures 1.5–7 ms).
The trail's halo is a real Gaussian blur, which is one GPU pass on a phone and about half the
frame here; it is worth it, and it is why the live routes below sit within a second of their
beats.

So capture motion at quarter speed and at scale 1, which resolves every beat into frames
without changing what the app does — the motion is the app's own, sampled finer:

```
npm run shoot -- --no-build --video --scale 1 --only replay-motion,replay-cut,replay-shake
/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux -i artifacts/video/replay-motion.webm -r 25 /tmp/m%03d.png
```

What those frames show, measured rather than asserted:

* **the callout slam** — the magenta area of TRANSITION x3 falls 2913 -> 1641 -> 963 px and then
  rises to 1013 and holds: scale 1.8 to 1.0 with the overshoot going *past* the resting size and
  coming back, which is the engine's own `activeEvents` curve;
* **the shake** — on the still TRACK CAM, a static road edge sits at y = 359.06 for every frame
  before the exit beat, jumps to 360.30 on it, then 360.27, 360.25, 359.20, 358.81, 358.87 and
  settles back at 359.05: a decaying oscillation about the resting position, inside the engine's
  180 ms window;
* **the camera cut** — mean frame luminance steps 14.6 (chase) -> 21.8 (the cross-fade frame,
  still darkened) -> 32.1 -> 38.1 (cinematic, at full brightness), which is the engine's 120 ms
  cross-fade measured in replay time, so it slows down with the playback rate like everything
  else. `cutTo=`/`cutAt=` fire it off the clock instead of tapping the control, because a
  synthetic tap on a control drawn over this canvas waits tens of seconds for the element to
  "hold still" at a fraction of a frame a second.

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

## Why `artifacts/` is excluded from the typecheck

`tsconfig.json` excludes `artifacts/`. Critics write throwaway probe scripts there, against
whatever the engine's shape was on the day they ran, and those scripts are evidence rather
than source: a critic must be free to leave its instruments behind without a later contract
change turning `npm run typecheck` red for everyone. Anything that must keep compiling
belongs in `tools/`.

## `--dist <dir>`: capturing while someone else is building

`expo export` CLEARS `dist/` before it writes it. So one person rebuilding kills another
person's running capture with `ENOENT dist/index.html`, and the failure looks like a broken
server rather than a collision. Three separate agents lost runs to this and each invented the
same workaround by hand: copy `dist` somewhere private and serve from there.

`--dist <dir>` makes that first-class. With `--no-build` it serves an export you already have;
with a build it exports normally and then copies the result to that directory, so the capture
is insulated from anyone else's rebuild for the rest of the run.

```
cp -a dist /tmp/my-dist
node tools/harness/shoot.mjs --no-build --dist /tmp/my-dist --only home
```

If a shoot ever dies with a missing `index.html`, that is this collision rather than a bug.
