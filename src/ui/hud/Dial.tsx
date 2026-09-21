/**
 * THE DIAL. One round instrument: the rim is the slip angle, the middle is the g radar.
 *
 * It replaces a wide shallow arc and a separate friction circle that sat under it. Two
 * instruments meant two things to look at, and the whole reason this screen was stripped is that
 * a driver between corners looks at one. A car's own cluster solves it the way this does — a
 * scale around the edge, a g radar concentric inside it — and it works because the eye lands in
 * the middle of one circle and reads outward instead of choosing.
 *
 * ── the rim ────────────────────────────────────────────────────────────────────────────────
 * Zero is 12 o'clock, the needle sweeps LEFT for a left-hand slide and RIGHT for a right-hand
 * one, ticks every 10°, and a ghost tick holds the peak of the drift in progress. The arc fills
 * out of the top and takes its colour from the angle it has reached.
 *
 * THE COLOUR IS ONE RAMP AND IT LIVES IN THE THEME. `ANGLE_STOPS` (green to 40°, into the
 * artwork's highlight at 55°, into the car's tail-light red at 70°, where a slide is a spin) is
 * read three times here — by the arc's `SweepGradient`, by the needle and numeral through
 * Reanimated's `interpolateColor`, and by the ghost tick — and once more by the results screen
 * through `angleColor`. A dial that interpolated its own stops and a verdict screen that
 * interpolated different ones is how 48° came out one colour on the road and another in the
 * garage; there is now nothing for them to disagree about. `angleColor` parses hex, so it never
 * runs here: the worklets below interpolate the same stops on the UI thread instead.
 *
 * THE WHOLE SCALE IS PAINTED, not just the lit part. The track behind the needle carries the
 * same ramp at `TRACK_OPACITY` — dim enough that the pixel classifier's brightness floor does
 * not count it, bright enough that the red zone is visible BEFORE the needle gets there, which
 * is the one thing a scale can tell a driver in advance.
 *
 * THE SWEEP IS ±150°, NOT ±78°. The old arc was a shallow bowl because it had to leave room
 * under it for eight other elements; a full ring has no such tenant, so the same ±70° of slip
 * now spends nearly twice the travel and a spin drives the needle all the way to the bottom of
 * the dial, which is the one place a needle has obviously run out of road. The 60° left open at
 * 6 o'clock is not a scale gap: it is the far end of both directions, and the two ends of the
 * scale meeting there is the correct reading of ±70°.
 *
 * ── the middle ──────────────────────────────────────────────────────────────────────
 * The g radar, concentric with the scale: rings, crosshairs, and ONE DOT at the tip of the
 * acceleration vector. Right is a right-hand push, up is throttle, down is brake — the same
 * convention the needle uses, which is the whole reason they can share one face. `gVector.ts`
 * owns that conversion and is swept in `hud.test.ts`.
 *
 * THE DOT USED TO TRAIL A LINE BACK TO THE CENTRE, and the line is gone. It was there to say
 * that the middle is zero and that the reading has a direction as well as a size — true, and
 * both facts the rings and the crosshairs already carry. What it actually looked like, once it
 * was on a frame beside a needle on the same face, was a joystick: a stick with a knob on the
 * end, which is a control you push, not a reading you take. A free dot on a gridded field is
 * the thing every g-meter in every car is, and it reads as one.
 *
 * ── under it ─────────────────────────────────────────────────────────────────────────
 * The |β|° numeral and the direction chevron, BELOW the circle rather than inside it. Inside,
 * they took the lower half of the face and pushed the radar off-centre to make room; out, the
 * radar is concentric with the scale — which is what a radar inside a ring should be — and the
 * numeral gets a band of its own and grows. The canvas is therefore taller than it is wide;
 * `DIAL_ASPECT` is the ratio, and the drive screen sizes the dial with it.
 *
 * ── what is NOT on it ───────────────────────────────────────────────────────────────
 * No side letter beside the chevron (an arrow pointing right and an "R" are one fact twice), no
 * number beside the dot (its distance from the middle IS the magnitude), no peak ring on the
 * radar (measured out: across 88 drifts the per-drift peak |g| has a MINIMUM of 0.645 g and
 * 39.8 % of drifts reach full scale, so the ring never leaves the outer third and reads as a
 * second rim).
 *
 * Nothing here re-renders: every moving part is a Reanimated shared value written by the sample
 * callback (see `useDriveRun`) and read on the UI thread — including the numeral's TEXT, which
 * Skia draws from the same shared value, so the biggest number on the screen updates at display
 * rate without React knowing about it.
 *
 * Imports Skia directly, so on web it must only ever be loaded through `DialView`.
 */
import { BlurMask, Canvas, Circle, Group, Path, Skia, type SkFont, SweepGradient, Text as SkText, useFont, vec } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { interpolateColor, useDerivedValue } from 'react-native-reanimated';

import { ANGLE_STOPS, colors, MAX_ANGLE_DEG, rgba } from '../theme';
import { gToFace } from './gVector';
import type { HudSignals } from './signals';

/** Half the angular width of the scale on screen, degrees (0 = straight up). */
const HALF_SWEEP = 150;
/**
 * |β| at the ends of the scale. A rigid, well-driven run peaks around 50–60°; 90° left the outer
 * third as dead travel, so the scale ends where a slide ends and anything past it (a spin) pins
 * the needle at the bottom of the dial, which is the correct reading of a spin.
 *
 * It is the theme's `MAX_ANGLE_DEG` — the last `ANGLE_STOPS` breakpoint — and not a 70 typed out
 * again here. The ramp's red end and the scale's end are ONE decision: a dial whose travel ran
 * past its own ramp would spend its last degrees in a colour the ramp had already finished.
 */
const MAX_BETA = MAX_ANGLE_DEG;
const DEG = Math.PI / 180;
/** Where the scale's left end sits, in Skia's arc degrees (0 = three o'clock, clockwise). */
const ARC_START = -90 - HALF_SWEEP;
/**
 * How bright the unlit track is — the mockup's figure, and it has a second job.
 *
 * `tools/harness/pixels.mjs` counts a colour only above a brightness floor of v = 0.3, and the
 * routes that prove this dial goes GREY for a reading the engine refuses assert at most 120
 * green pixels inside its box. `#8AF606` at 0.18 over `bg0` is (31, 55, 21), v = 0.22, so the
 * track is under that floor by a wide margin and a refused frame measures what it should.
 *
 * A 0.13 white hairline used to be stroked over this track — a leftover from when the track was
 * a flat dark grey and needed an edge. Over a coloured one it added +31 to every channel, which
 * put the SAME pixels at v = 0.31 and made three cold routes report 1 700 – 3 340 green pixels
 * on a dial that was drawing nothing hot at all. The ceiling was right and the screen was wrong.
 * The ticks give the rim its edge; the hairline is gone.
 */
const TRACK_OPACITY = 0.18;

/**
 * `ANGLE_STOPS` rewritten as one `SweepGradient`: colour by POSITION ALONG THE ARC, 0 at the
 * left end of the scale and 1 at the right.
 *
 * That is deliberately the same parameter the arc `Path`'s own `start` / `end` trim takes, so
 * the lit part of the ring is a window onto a gradient that never moves — the colour under 48°
 * is the colour of 48° whether the needle has got there yet or not. The scale is symmetric in
 * |β|, so every stop appears twice, once per side, and the 0° stop appears once in the middle.
 *
 * `interpolateColor` below reads the same table over |β| directly. Neither is a copy of the
 * other's numbers: both are derived from `ANGLE_STOPS`, which is where a change goes.
 */
const RAMP: { colors: string[]; positions: number[] } = (() => {
  const colors: string[] = [];
  const positions: number[] = [];
  const at = (deg: number) => Math.max(0, Math.min(0.5, deg / (2 * MAX_BETA)));
  for (let i = ANGLE_STOPS.length - 1; i >= 0; i--) {
    colors.push(ANGLE_STOPS[i].color);
    positions.push(0.5 - at(ANGLE_STOPS[i].deg));
  }
  for (let i = 1; i < ANGLE_STOPS.length; i++) {
    colors.push(ANGLE_STOPS[i].color);
    positions.push(0.5 + at(ANGLE_STOPS[i].deg));
  }
  return { colors, positions };
})();

/** `ANGLE_STOPS` split into the two arrays `interpolateColor` wants, built once. */
const RAMP_DEG: number[] = ANGLE_STOPS.map((s) => s.deg);
const RAMP_COLOR: string[] = ANGLE_STOPS.map((s) => s.color);

/**
 * |(a_x, a_y)| in g at the radar's outer ring, MEASURED rather than chosen.
 *
 * Over 16 runs (2 tracks × 4 seeds × 2 aggressions, 168 165 valid frames, 113 172 of them at
 * |β| ≥ 8°), the magnitude the pipeline's own `SlipState` reports while the car is sideways has
 * median 0.471 g, p75 0.568, p90 0.669, p99 0.841 and max 1.315.
 *
 * At 0.8 g — the full scale the old one-dimensional lateral ball used — the median vector reaches
 * 59 % of the radius and p90 84 %, so it spends nearly its whole life against the outer ring,
 * where a circle's travel is most compressed. At 1.0 g the median reaches 47 %, p90 67 % and p99
 * 84 %: the vector ranges over the whole radar and still hits the edge on the moments that
 * deserve it, pinning on 0.33 % of drifting samples. 1.0 g is also the one figure on this scale
 * a driver already has a feel for.
 */
export const FULL_SCALE_G = 1.0;

/**
 * The radar's own ramp: the SAME shape as the rim's, on the radar's own quantity.
 *
 * The dot's colour is the LOAD, not the angle — a phone can be reading 0.9 g with the wheel
 * straight — so it cannot borrow the needle's colour. What it can borrow is the ramp: each
 * `ANGLE_STOPS` breakpoint is carried across as the same FRACTION of full scale, so the two
 * instruments on one face go green, highlight and red together and there is no second set of
 * breakpoints to tune. 40°/70° and 0.57 g/1.0 g are one number written once.
 */
const RAMP_G: number[] = ANGLE_STOPS.map((s) => (s.deg / MAX_BETA) * FULL_SCALE_G);

const NUMERAL_FONT = require('@expo-google-fonts/barlow-condensed/800ExtraBold_Italic/BarlowCondensed_800ExtraBold_Italic.ttf');

/**
 * The numeral's cap height as a fraction of the canvas width. 0.32 of the CIRCLE's diameter,
 * which is the size the approved drive mockup sets it at (96 pt on a 300 pt circle).
 *
 * It was 0.2 — 0.23 of the diameter — and the difference is the whole point of the element: a
 * number read at 60 km/h out of the corner of an eye is the one thing on this screen that can
 * afford to be enormous, and the 60° the scale leaves open at six o'clock is space nothing else
 * is using.
 */
const NUMERAL_SIZE = 0.28;
/**
 * How far the numeral's band reaches BELOW the circle's box, as a fraction of it.
 *
 * The numeral does not hang off the bottom of the dial — it sits IN THE OPENING. The scale stops
 * at ±150°, which leaves 60° of empty face at six o'clock and a 1.0 R-wide gap between the two
 * ends of the arc; the numeral is about 0.6 R wide, so it drops into that gap and reads as part
 * of the instrument. Set flush under the box instead, it floated 92 pt clear of the arc's ends
 * with nothing between, and looked like a caption.
 *
 * The band is the room the BASELINE needs past the circle: cap top level with the bottom of the
 * circle (0.94 of the width, at R = 0.44) puts the baseline at 0.94 + 0.7 × `NUMERAL_SIZE`, and
 * the rest is the descender room a "°" does not use but a clipped glyph would show.
 */
const NUMERAL_BAND = 0.19;
/** Canvas height ÷ width. The drive screen divides the height it has by this to get `size`. */
export const DIAL_ASPECT = 1 + NUMERAL_BAND;

export interface DialProps {
  /** The side of the dial's CIRCLE. The canvas is `size` wide and `size * DIAL_ASPECT` tall,
      because the numeral sits in a band under it. */
  size: number;
  signals: HudSignals;
  testID?: string;
}

export default function Dial({ size, signals, testID }: DialProps) {
  const cx = size / 2;
  const cy = size / 2;
  const canvasH = size * DIAL_ASPECT;
  /**
   * The scale's radius. The rest of the square is the glow's room to fade out in rather than be
   * CLIPPED — a glow that ends in a hard edge reads as a rendering bug — and 0.44 did not give
   * it that room.
   *
   * MEASURED, because the comment above used to stand over a number that could not honour it.
   * The lit arc blooms through a `BlurMask` of 1.35 × `stroke` on a stroke 2.1 × as wide as the
   * scale's, so it reaches R + 1.05 × stroke + 3σ = 1.485 R from the centre. At R = 0.44 size
   * the canvas edge is at 1.136 R, which cuts the bloom at 0.28σ — nearly four fifths of its
   * height — and the landscape frame stepped from (16, 41, 21) to bg0 across one pixel down the
   * right edge of the canvas, a bright rectangle in open space beside the instrument. Portrait
   * hid it only because the canvas is the full screen width there and the cut landed under the
   * edge bloom.
   *
   * 0.385 puts the edge at 1.30 R, so the bloom is cut at 1.55σ instead — about a tenth of its
   * height. Re-measured across the same edge: the step is 6 to 12 in green against a background
   * of 13, where it was 28, and it is no longer a line the eye finds. It is also the approved
   * mockup's own proportion — a 300 pt circle on a 390 pt board, 0.77 of the width against the
   * 0.88 this was drawing — so the instrument did not lose anything the design asked for.
   */
  const R = size * 0.385;
  const stroke = Math.max(9, R * 0.095);

  /** The radar is CONCENTRIC with the scale, now that the numeral is not sharing the face. That
      is not only tidier: the needle's base sits at a fixed 0.68 R from the centre, so a radar on
      the same centre keeps the same clearance from it at every angle, where an off-centre one
      was closest at 12 o'clock — the exact spot the needle spends small slip angles in. */
  const radar = useMemo(() => ({ cy, r: R * 0.56 }), [cy, R]);
  const numeralSize = size * NUMERAL_SIZE;
  /** Cap top level with the bottom of the circle, so the numeral drops into the scale's gap. */
  const baselineY = cy + R + numeralSize * 0.7;
  const numeralMidY = baselineY - numeralSize * 0.35;

  const font = useFont(NUMERAL_FONT, numeralSize);

  /**
   * Measured once per font: a digit's advance and the degree sign's advance. `getTextWidth` (not
   * `measureText`, which CanvasKit's RN-Web shim does not implement) gives the ADVANCE, which is
   * what a layout needs; Barlow Condensed's digits are tabular, so one measurement covers all
   * ten. The worklets below only multiply these numbers, so the hero numeral is laid out on the
   * UI thread without touching the font again.
   *
   * The degree sign is part of the numeral STRING rather than a second text node: placing it by
   * advance left it visibly detached after a narrow glyph like "1". Skia sets it where the
   * typeface says it goes.
   */
  const metrics = useMemo(() => {
    const width = (f: SkFont | null, text: string, fallback: number) => {
      if (!f) return fallback;
      try {
        const w = f.getTextWidth(text);
        return Number.isFinite(w) && w > 0 ? w : fallback;
      } catch {
        return fallback;
      }
    };
    return { advance: width(font, '0', numeralSize * 0.5), deg: width(font, '°', numeralSize * 0.3) };
  }, [font, numeralSize]);

  /**
   * Distance from the centre to the direction chevron. The numeral block is centred, so its right
   * edge is at `advance + deg / 2`; the rest is clearance. It was `0.14 × numeralSize` and the
   * chevron's own left point eats 0.078 of that, which left about 5 pt against the round shoulder
   * of a degree sign — close enough to read as "48°»", one glyph.
   */
  const chevronOffset = metrics.advance + metrics.deg * 0.5 + numeralSize * 0.26;

  const rect = useMemo(() => ({ x: cx - R, y: cy - R, width: 2 * R, height: 2 * R }), [cx, cy, R]);
  const rampTransform = useMemo(() => [{ rotate: ARC_START * DEG }], []);

  /** The face, drawn clockwise from the left end of the scale; t = 0.5 is straight up (β = 0). */
  const arc = useMemo(() => Skia.PathBuilder.Make().addArc(rect, -90 - HALF_SWEEP, 2 * HALF_SWEEP).detach(), [rect]);

  const ticks = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    for (let d = -MAX_BETA; d <= MAX_BETA; d += 10) {
      const major = d % 30 === 0;
      const a = (d / MAX_BETA) * HALF_SWEEP * DEG - Math.PI / 2;
      const outer = R - stroke * 1.25;
      const inner = outer - (major ? stroke * 0.95 : stroke * 0.45);
      b.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner).lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    }
    return b.detach();
  }, [cx, cy, R, stroke]);

  /** The needle lives in the band between the radar and the scale and nowhere else: a longer one
      would reach across the radar exactly when the driver is reading the dot. */
  const needle = useMemo(() => {
    // The tip runs INTO the track rather than stopping short of it. A needle that ends in the gap
    // before the scale is a needle pointing at nothing, and on a ring this size the gap was wide
    // enough to read as one.
    const tip = R - stroke * 0.25;
    // The base stays outside the radar at EVERY angle, including 12 o'clock where the two are
    // closest: the radar reaches cy − 0.65 R there, so a longer needle crosses the rings at small
    // slip — exactly when the driver is reading the dot to feel whether the car has taken a set.
    const base = R * 0.68;
    // SLENDER. At 0.055 R the base was 19 pt across on a 35 pt-long needle, which on a 300° ring
    // reads as a white blob stuck to the rim rather than as something pointing at a number. A
    // ring gauge's needle is a line; its authority comes from the taper and the glow, not width.
    const halfBase = Math.max(2.5, R * 0.026);
    const halfTip = Math.max(1.2, R * 0.009);
    return Skia.PathBuilder.Make()
      .moveTo(cx - halfBase, cy - base)
      .lineTo(cx - halfTip, cy - tip)
      .lineTo(cx + halfTip, cy - tip)
      .lineTo(cx + halfBase, cy - base)
      .close()
      .detach();
  }, [cx, cy, R, stroke]);

  /** One bar across the scale at 12 o'clock, rotated to the peak angle. */
  const ghost = useMemo(() => {
    const outer = R - stroke * 0.1;
    const inner = R - stroke * 2.4;
    const half = Math.max(1.4, R * 0.008);
    return Skia.PathBuilder.Make()
      .moveTo(cx - half, cy - inner)
      .lineTo(cx - half, cy - outer)
      .lineTo(cx + half, cy - outer)
      .lineTo(cx + half, cy - inner)
      .close()
      .detach();
  }, [cx, cy, R, stroke]);

  /** Two stacked chevrons pointing away from the centre, drawn around (0, 0). */
  const chevron = useMemo(() => {
    const s = numeralSize * 0.125;
    const b = Skia.PathBuilder.Make();
    for (let i = 0; i < 2; i++) {
      const x = i * s * 0.8;
      b.moveTo(x - s * 0.34, -s)
        .lineTo(x + s * 0.3, 0)
        .lineTo(x - s * 0.34, s)
        .lineTo(x - s * 0.02, s)
        .lineTo(x + s * 0.62, 0)
        .lineTo(x - s * 0.02, -s)
        .close();
    }
    return b.detach();
  }, [numeralSize]);

  /** The radar's rings and crosshairs. The hairs run past the outer ring, the way a gunsight's
      do and the way a car cluster's do: it is what makes a set of concentric circles read as a
      measuring field rather than as a target. */
  const radarRings = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    for (const f of [1 / 3, 2 / 3, 1]) b.addCircle(cx, radar.cy, radar.r * f);
    return b.detach();
  }, [cx, radar.cy, radar.r]);

  const radarHairs = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    // 1.05, not 1.16: the needle's base sits at 0.68 R and the radar now reaches 0.56 R, so a
    // longer hair would cross it. The hairs still run past the outer ring, which is what makes a
    // set of concentric circles read as a measuring field rather than as a target.
    const e = radar.r * 1.05;
    b.moveTo(cx - e, radar.cy).lineTo(cx + e, radar.cy);
    b.moveTo(cx, radar.cy - e).lineTo(cx, radar.cy + e);
    return b.detach();
  }, [cx, radar.cy, radar.r]);

  const dotR = Math.max(5, radar.r * 0.155);

  // ── everything below moves on the UI thread ────────────────────────────────────────
  const clamped = useDerivedValue(() => Math.max(-MAX_BETA, Math.min(MAX_BETA, signals.betaDeg.value)));
  const fillStart = useDerivedValue(() => Math.min(0.5, 0.5 + clamped.value / (2 * MAX_BETA)));
  const fillEnd = useDerivedValue(() => Math.max(0.5, 0.5 + clamped.value / (2 * MAX_BETA)));
  const needleTransform = useDerivedValue(() => [{ rotate: (clamped.value / MAX_BETA) * HALF_SWEEP * DEG }]);
  const peakTransform = useDerivedValue(() => [{ rotate: (Math.max(-MAX_BETA, Math.min(MAX_BETA, signals.peakDeg.value)) / MAX_BETA) * HALF_SWEEP * DEG }]);
  const peakOpacity = useDerivedValue(() => (Math.abs(signals.peakDeg.value) > 8 ? 0.9 : 0));
  // The ghost tick marks an ANGLE, so it is drawn in that angle's own colour off the same ramp
  // rather than in a marker colour of its own — a peak held at 62° is already in the red zone
  // and says so. On a reading the engine will not stand behind it turns grey with the rest of
  // the dial instead of being the one bright thing on screen.
  const peakColor = useDerivedValue(() =>
    signals.trust.value <= 0 ? colors.muted : interpolateColor(Math.abs(signals.peakDeg.value), RAMP_DEG, RAMP_COLOR),
  );
  // The needle and the numeral, on `ANGLE_STOPS` — the same table the arc's gradient is built
  // from, so the pointer is always the colour of the part of the ring it is over. An untrusted
  // reading is drawn in muted grey instead: the engine is not counting it, so the dial does not
  // celebrate it.
  const hot = useDerivedValue(() =>
    signals.trust.value <= 0 ? colors.muted : interpolateColor(signals.absDeg.value, RAMP_DEG, RAMP_COLOR),
  );
  const glowOpacity = useDerivedValue(() => (0.22 + 0.68 * signals.intensity.value) * signals.trust.value);
  const bowlOpacity = useDerivedValue(() => (0.14 + 0.42 * signals.intensity.value) * signals.trust.value);
  const dimmed = useDerivedValue(() => 0.45 + 0.35 * signals.valid.value + 0.2 * signals.trust.value);
  /**
   * How much of the LIT arc is the ramp and how much is the grey under it.
   *
   * The gradient is a fixed paint — it cannot turn grey the way the needle's single colour can —
   * so the refusal is a cross-fade instead: a muted arc underneath, always drawn, and the ramp
   * over it at `trust`. At trust 1 the ramp covers the grey exactly (same path, same trim); at
   * trust 0 the grey is all that is left, which is what `drive-loose` photographs and what the
   * harness's ceiling inside `hud-dial-box` asserts.
   */
  const believed = useDerivedValue(() => signals.trust.value);

  // The radar, on the same honesty rule and on its own quantity: the vector's colour is the LOAD,
  // not the angle, so it runs the same ramp over `RAMP_G` rather than borrowing the needle's.
  // At `trust` 0 both go grey together, because a phone loose in a cup holder reads a LARGER g
  // than the car does, not a smaller one.
  const face = useDerivedValue(() => gToFace(signals.ayG.value, signals.axG.value, FULL_SCALE_G));
  const gMag = useDerivedValue(() => face.value.mag);
  const dotTransform = useDerivedValue(() => [{ translateX: face.value.x * radar.r }, { translateY: face.value.y * radar.r }]);
  const gHot = useDerivedValue(() =>
    signals.trust.value <= 0 ? colors.muted : interpolateColor(gMag.value * FULL_SCALE_G, RAMP_G, RAMP_COLOR),
  );
  const gGlow = useDerivedValue(() => (0.12 + 0.72 * gMag.value) * signals.trust.value);

  const digits = useDerivedValue(() => String(Math.round(Math.min(99, signals.absDeg.value))));
  const numeral = useDerivedValue(() => digits.value + '°');
  const blockLeft = useDerivedValue(() => cx - (digits.value.length * metrics.advance + metrics.deg) / 2);
  const numeralScale = useDerivedValue(() => [{ scale: 1 + 0.08 * signals.punch.value }]);
  const chevronTransform = useDerivedValue(() => [
    { translateX: cx + signals.side.value * chevronOffset },
    { translateY: numeralMidY },
    { scaleX: signals.side.value },
  ]);
  /**
   * The chevron says which way the car is sliding, so at 0° it must say NOTHING. `side` holds its
   * last direction (it only updates past |β| > 3°, so a straight road keeps the last slide's side,
   * and a run that has never slid keeps its initial right) — a grey chevron on a car pointing
   * straight ahead is a claim about a slide that is not happening. It fades in with the angle
   * instead, over the same 3° the signal itself waits for.
   */
  const sideOpacity = useDerivedValue(() => 0.95 * Math.max(0, Math.min(1, (Math.abs(signals.betaDeg.value) - 1.5) / 2.5)));

  const centre = useMemo(() => vec(cx, cy), [cx, cy]);
  const numeralOrigin = useMemo(() => vec(cx, numeralMidY), [cx, numeralMidY]);

  /**
   * The ramp, laid over the face so that position 0 of the gradient falls on the LEFT end of the
   * scale and position 1 on the right.
   *
   * Skia measures a sweep from three o'clock and takes its `start` / `end` in [0, 360), so a
   * scale that begins at −240° cannot be expressed by those two numbers alone — angles past the
   * wrap clamp to the first stop, which paints the right-hand half of the dial red. The gradient
   * is instead declared over a plain 0…300° sweep and its own local frame is rotated onto the
   * arc, which is the same rotation the arc itself was built with (`ARC_START`).
   */
  const rampShader = (
    <SweepGradient
      c={centre}
      start={0}
      end={2 * HALF_SWEEP}
      colors={RAMP.colors}
      positions={RAMP.positions}
      origin={centre}
      transform={rampTransform}
    />
  );

  return (
    <Canvas style={{ width: size, height: canvasH }} testID={testID}>
      {/* The face: the live colour pooling inside the ring, fading to nothing before the rim.
          A blurred disc rather than a radial gradient, because the pool follows the ANGLE — the
          mockup's pool is the ramp colour, not a fixed wash — and a gradient's stops would have
          to be rebuilt on the UI thread every frame to do that, hex parsing and all.

          0.40 R of disc and 0.24 R of blur, which is a BUDGET and not a look: a Gaussian is
          gone by 3 sigma, so the pool is spent by 1.12 R, and the canvas edge is at 1.136 R
          (`size / 2` against `R = 0.44 size`). A wider one is cut off square by the canvas and
          the cut is visible — measured at 0.46 R + 0.36 R of blur, the landscape frame stepped
          from (16, 41, 21) to bg0 across one pixel down the canvas's right edge, which is the
          rectangle a driver reads as a rendering fault rather than as light. */}
      <Circle cx={cx} cy={cy} r={R * 0.4} color={hot} opacity={bowlOpacity}>
        <BlurMask blur={R * 0.24} style="normal" />
      </Circle>

      {/* the scale: the whole ramp at 0.18, so the red zone is visible before the needle reaches
          it, and the ticks over it */}
      <Path path={arc} style="stroke" strokeWidth={stroke} strokeCap="butt" opacity={TRACK_OPACITY}>
        {rampShader}
      </Path>
      <Path path={ticks} color={rgba(colors.text, 0.5)} style="stroke" strokeWidth={Math.max(1.6, R * 0.011)} />

      {/* ghost tick: the peak of the drift in progress */}
      <Group origin={centre} transform={peakTransform} opacity={peakOpacity}>
        <Path path={ghost} color={peakColor}>
          <BlurMask blur={4} style="solid" />
        </Path>
      </Group>

      {/* the live arc, blooming out of the top. The glow already scales with `trust`, so it needs
          no grey twin: a refused reading simply does not bloom. */}
      <Group opacity={glowOpacity}>
        <Path path={arc} style="stroke" strokeWidth={stroke * 2.1} strokeCap="round" start={fillStart} end={fillEnd}>
          <BlurMask blur={stroke * 1.35} style="normal" />
          {rampShader}
        </Path>
      </Group>
      <Group opacity={dimmed}>
        <Path path={arc} color={colors.muted} style="stroke" strokeWidth={stroke} strokeCap="butt" start={fillStart} end={fillEnd} />
        <Path path={arc} style="stroke" strokeWidth={stroke} strokeCap="butt" start={fillStart} end={fillEnd} opacity={believed}>
          {rampShader}
        </Path>
        <Path path={arc} color={rgba('#FFFFFF', 0.45)} style="stroke" strokeWidth={stroke * 0.2} strokeCap="butt" start={fillStart} end={fillEnd} />

        {/* the needle, in the band between the radar and the scale */}
        <Group origin={centre} transform={needleTransform}>
          <Path path={needle} color={hot} opacity={0.95}>
            <BlurMask blur={7} style="solid" />
          </Path>
          <Path path={needle} color={rgba('#FFFFFF', 0.9)} />
        </Group>
      </Group>

      {/* ── the g radar ──────────────────────────────────────────────────────────────── */}
      <Path path={radarHairs} color={rgba(colors.text, 0.22)} style="stroke" strokeWidth={Math.max(1, R * 0.005)} />
      <Path path={radarRings} color={rgba(colors.text, 0.17)} style="stroke" strokeWidth={Math.max(1, R * 0.006)} />
      <Group opacity={gGlow}>
        <Group transform={dotTransform}>
          <Circle cx={cx} cy={radar.cy} r={dotR * 1.7} color={gHot}>
            <BlurMask blur={dotR * 1.2} style="normal" />
          </Circle>
        </Group>
      </Group>
      <Group opacity={dimmed}>
        <Group transform={dotTransform}>
          <Circle cx={cx} cy={radar.cy} r={dotR} color={gHot} />
          <Circle cx={cx} cy={radar.cy} r={dotR * 0.3} color={rgba('#FFFFFF', 0.9)} />
        </Group>
      </Group>

      {/* the hero numeral, in the quiet lower middle of the face */}
      {font ? (
        <Group origin={numeralOrigin} transform={numeralScale} opacity={dimmed}>
          <Group opacity={0.45}>
            <SkText x={blockLeft} y={baselineY} text={numeral} font={font} color={hot}>
              <BlurMask blur={16} style="normal" />
            </SkText>
          </Group>
          <SkText x={blockLeft} y={baselineY} text={numeral} font={font} color={hot} />
          <Group transform={chevronTransform}>
            <Path path={chevron} color={hot} opacity={sideOpacity} />
          </Group>
        </Group>
      ) : null}
    </Canvas>
  );
}
