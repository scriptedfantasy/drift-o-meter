# Drift-O-Meter — design language

The bar: a frame from this app should sit next to a *Need for Speed* HUD or a *Tokyo Drift*
replay without embarrassment. Every screen is built for a phone in a car mount at arm's
length, at night, with the driver's eyes mostly on the road: enormous numbers, one thing
that matters at a time, and drama exactly at the moments a drift has drama.

## Identity
* World: night street racing. Asphalt black with a blue bias, sodium/ember light, tyre
  smoke, neon telemetry. No daylight UI, no white cards, no rounded-corner card soup.
* Palette (tokens in `src/ui/theme.ts`): bg0 `#07090D`, bg1 `#0E1218`, bg2 `#161C25`,
  line `#232B37`, text `#F2F0EB`, muted `#8A93A6`, ember `#FF5A1F` (drift-active, score),
  cyan `#29E3FF` (telemetry, speed), magenta `#FF2D95` (transitions, callouts),
  gold `#FFC53D` (S grade), green `#3DFF9A` (clean/smooth), red `#FF3B3B` (danger).
  Ember is THE accent; cyan and magenta are spent only on the events they belong to.
* Type: Barlow Condensed (600/700/800, italics for anything that moves: speed, points)
  for every number and headline; Barlow (400/500/600) for body. Numbers are huge and
  tabular (`fontVariant: ['tabular-nums']`). Labels are uppercase, letter-spaced 8–12 %.
  Nothing decorative that is not information. No emojis anywhere.
* Structure: hairline rules (`line`), 4-pt spacing, a strong left/top alignment grid,
  gauges drawn with Skia (arcs, ticks, glows), never stock components.

## Motion language (durations in `theme.motion`)
* Drift entry: ember glow blooms in from the screen edges (220 ms), the angle numeral
  punches to 1.08× and settles (spring), haptic heavy.
* Held angle: glow intensity tracks |β|; the numeral colour shifts ember → gold above 40°.
* Transition: 120 ms magenta flash, callout slams in (scale 1.8 → 1.0 with overshoot,
  320 ms), 2 px screen shake for 100 ms, haptic medium. "TRANSITION ×2" style label.
* Exit: glow fades (420 ms), multiplier chip settles, chain banks with a "BANKED +N"
  ticker sliding up (900 ms), haptic light.
* Score: odometer roll (digits slide), never a jump cut; the multiplier chip scales up
  with each bump.
* Grade reveal (results): letterbox bars close, 900 ms hold on black, the letter slams
  in with a shockwave ring and ember particles, then the numbers cascade in. Gold for S.
* Replay: letterbox bars, vignette, subtle film grain; camera moves are critically
  damped; the trail glows additively; smoke puffs drift and fade.
* Respect reduce-motion: keep state changes, drop shakes/particles.

## The whole app is four steps

This is the product, and anything that does not serve it is in the way:

1. **Calibrate, only if necessary.** Not a step. The engine needs no gesture: it finds the
   vertical from gravity and the forward axis from the first hard acceleration, while driving.
   So calibration is a background process that the drive screen reports on, and the calibration
   SCREEN exists only for when something is actually wrong — a phone lying flat, a loose cradle,
   an axis that will not resolve. A driver who never opens it should never be worse off.
2. **Before the run, one button.** Tapping DRIVE starts recording. There is no second
   confirmation, no arming step, no countdown. If a permission is missing, that is the moment to
   ask for it; if the mount is not yet understood, the display says so while already recording,
   because the calibration finishes during the first corners anyway.
3. **Drive.** The display is read at a glance. One control on it: STOP.
4. **After the run, the verdict.** Stopping saves the session and goes straight to the results.
   No save dialog, no naming step, no confirmation.

Everything else in the app — the replay, the session list, the personal bests, the settings — is
reached from those four, never inserted between them. When a feature and this flow disagree, the
flow wins.

## Screens
### Drive HUD (`/drive`)
Portrait: status row (session clock, lap, integrity pill, GPS pill) → the angle gauge: a
wide arc like a tachometer with a needle for signed β (left slide sweeps left), tick
marks every 10°, the peak of the current drift as a ghost tick → the giant |β|° numeral
with an L/R chevron → speed (km/h, italic, cyan) and a lateral-g ball beside it → score
line: total (odometer) + multiplier chip + chain bar → callout stack above the gauge →
live mini-map (trail so far, ember where drifting) → STOP control at the bottom.
Landscape: gauge + numeral left, speed/score right, mini-map bottom-right.
The HUD must read at a glance at 60 km/h: the angle numeral is the biggest thing on
screen, everything else is secondary.

### Results (`/results/[id]`)
Grade hero (letter, points, name/track/date), component bars (angle, consistency,
quality, speed, style) with the number beside each, best drift card (peak angle,
duration, points, transitions), drift list (mini sparkline of |β| per drift), lap
consistency table when laps exist, integrity notes, buttons: REPLAY, SHARE, DRIVE AGAIN.

### Replay (`/replay/[id]`)
Full-bleed Skia map with letterbox; overlays: angle, speed, points, lap; scrubber with
speed and |β| traces and drift markers; play/pause, ×0.5/×1/×2, camera mode
(overview / chase / cinematic), ghost toggle. Camera and scene come from
`src/engine/replay` — the renderer draws the scene data, it does not invent it.

### Calibrate (`/calibrate`)
"Mount the phone, then drive": a live phone-orientation glyph (from gravity), a quality
meter, plain-language steps ("Drive straight and accelerate once"), forward-axis
resolved state, mount-looseness warning from the integrity monitor.

DONE is the ENGINE'S OWN BAR, not a number written here. It is
`IntegrityMonitor.calibrationOk`: quality at or above `minCalibrationQuality` with the
forward axis resolved. The rule is that the engine names the bar and the screen reports it,
so that a screen can never gate on a threshold the engine cannot clear.

A CORRECTION, LEFT IN PLACE AS A WARNING. This doc previously said DONE at quality ≥ 0.8.
It was then changed on the strength of a measurement that the ceiling is 0.74 — which a
later critic disproved by running 24 combinations of track, mount and seed instead of one:
the real spread at the simulator's default vibration is 0.68 to 0.86, with 8 of 24 above
0.78. Seed 1 happens to be the low one, and it is the harness default, so a single-seed
measurement read as a ceiling. The conclusion survived for a different reason than the one
given — the engine should name its own bar regardless — but the number was wrong, and a
correct conclusion resting on a wrong measurement is luck rather than engineering. Any
claim about what the engine "cannot" do must be measured across seeds before it is written
down here.

### Garage (`/`)
DRIVE call-to-action (dominant), last session grade, personal bests per track, sessions
list (grade, points, best angle, date), settings entry. On web the simulated source is
selectable here for demos.
