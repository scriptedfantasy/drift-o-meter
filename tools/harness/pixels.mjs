/**
 * PNG pixel statistics used to prove a screenshot shows what we think it shows.
 *
 * ── THE CLASSIFIER, AND WHY IT IS A HUE BAND ──────────────────────────────────────────────
 * `isEmber` used to be `r >= 170 && g >= 40 && g <= 150 && b <= 110 && r - b >= 90`, which is a
 * box in RGB, and the box swallowed two other palette colours:
 *
 *   • red `#FF3B3B` (255, 59, 59) satisfies it outright. `drive-loose` asserted `minEmber: 100`
 *     under a comment saying the gauge must be drawn MUTED, and measured 30 591 — of which
 *     17 169 were the red LOOSE MOUNT banner and 9 745 the red STOP control. The number had
 *     almost nothing to do with the claim it was under.
 *   • gold `#FFC53D` misses the box at full brightness but every antialiased or dimmed gold
 *     pixel lands inside it: `#B28300`, `#C69200`, `#C89400` — the scrubber's highlight pips —
 *     were counted as ember behind a route comment claiming the frame "really is ember-free".
 *
 * A predicate loose enough to swallow both gold and red cannot support a claim about ember. So
 * the classifier is a HUE band instead, which is the thing that actually separates them: ember
 * sits at 13–16°, red at 0°, gold at 42–44°, magenta at 330°. `isEmber` is 8–32° with a
 * saturation and a brightness floor, which leaves ≥ 8° of margin to red and ≥ 10° to gold, and
 * antialiasing toward the near-black background preserves hue, so a half-dissolved ember glyph
 * is still ember and a half-dissolved gold pip is still gold.
 *
 * ── AFTER THE REPAINT ─────────────────────────────────────────────────────────────────────
 * The palette these bands were cut for is being replaced: green, red, blue and a grey, all
 * measured off the car and the artwork. `isGreen` and `isRed` are the two that carry the new
 * colours (87°/77° and 354°, which `isRed`'s 353° wrap already covered). `isEmber`, `isGold`
 * and `isMagenta` still name hues from the old palette and stay only for the routes that have
 * not been rewritten yet — a check naming one of those on a repainted screen is measuring a
 * colour nothing draws. `isCyan` is the same and worse, because there IS a new colour it looks
 * like it should mean: the palette's blue is 218°, and this band ends at 205°.
 *
 * Every other palette colour has its own predicate on the same footing, so a check can name the
 * colour it means rather than borrowing one that happens to overlap.
 *
 * ── REGIONS AND CEILINGS ──────────────────────────────────────────────────────────────────
 * A FLOOR CANNOT CERTIFY AN ABSENCE. `minEmber` proves something drew; a route whose whole point
 * is that the HUD does NOT celebrate needs the opposite, and it needs it measured in the part of
 * the screen the claim is about — a loose-run peak frame draws 63 983 ember pixels inside the
 * gauge on a run worth zero points, and would pass any floor in the file. So a route can say
 * "at most N pixels of colour C inside rectangle R", with R in FRACTIONS of the image so the
 * same rectangle means the same thing portrait, landscape and at any device scale. See
 * `analyzePng`'s `regions` option and `tools/harness/README.md`.
 */
import { PNG } from 'pngjs';

/**
 * `colors.bg0` — the car's paint in shadow. It was `#07090D`, the old asphalt black, and
 * stayed that way through the repaint: every route then reported `corners:false`, because the
 * corners of every screenshot are the new `#070D18` and no longer matched. Only a warning,
 * since `cornersNearBg` passes at tolerance 24 either way, but the corner check had quietly
 * stopped testing the thing it names.
 */
export const BG0 = { r: 0x07, g: 0x0d, b: 0x18 };

function hexToRgb(hex) {
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

function near(a, b, tol) {
  return Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
}

/** Hue in degrees (0 = red, 60 = yellow, …), or −1 for a pixel with no chroma at all. */
export function hueOf(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c === 0) return -1;
  let h;
  if (max === r) h = ((g - b) / c) % 6;
  else if (max === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * A hue-band predicate with a saturation and a brightness floor.
 *
 * The floors are what keep a check about a colour from counting the near-black wash the same
 * colour's own glow leaves over half the screen: `v` is the max channel over 255 and `s` is the
 * chroma over that max, so a 20 %-alpha ember bloom over bg0 (57, 25, 17) is v = 0.22 and does
 * not count, while a 50 % one (131, 50, 22) is v = 0.51 and does.
 */
function band(loHue, hiHue, minS = 0.45, minV = 0.3) {
  return (r, g, b) => {
    const max = Math.max(r, g, b);
    if (max < minV * 255) return false;
    const c = max - Math.min(r, g, b);
    if (c < minS * max) return false;
    const h = hueOf(r, g, b);
    return h >= loHue && h <= hiHue;
  };
}

/** `#FF5A1F` and its glow — drift-active and the score. 13–16° at full strength. */
export const isEmber = band(8, 32);
/** `#FFC53D` — grade S, the multiplier chip, the held-peak ghost tick. 42–44°. */
export const isGold = band(36, 56);
/** `#FF3B3B` — danger: the LOOSE MOUNT banner, the STOP control. 0° (± a little). */
export const isRed = (r, g, b) => {
  const h = hueOf(r, g, b);
  return band(0, 7)(r, g, b) || (h >= 353 && band(0, 360)(r, g, b));
};
/** `#FF2D95` — transitions and callouts. ~330°. */
export const isMagenta = band(310, 345);
/** `#29E3FF` — telemetry and speed. ~187°. */
/**
 * @deprecated Names a hue the app no longer paints. Use `blue`.
 *
 * 170-205 was `#29E3FF`. The palette's blue is `#6C9BEA` at hue 218, outside the band, so any
 * check naming `cyan` on a repainted screen passes by measuring nothing — the most dangerous
 * kind of green tick. Kept only until the last route naming it is gone.
 */
export const isCyan = band(170, 205, 0.4, 0.35);

/**
 * The car at rest: speed, structure, the cold facts nobody is judged on.
 *
 * `#6C9BEA` measures hue 218.2 at S 0.53, V 0.92. The band runs 205-232 and the saturation
 * floor drops to 0.30, both because of what this colour sits ON: against `bg0` (#070D18, hue
 * 219, S 0.71) a half-covered antialiased edge stays on almost exactly the same hue and simply
 * loses saturation, so a floor set for a colour on black would count the numeral and discard
 * its own edges. The upper edge stops at 232 rather than running to the background's 219 + n
 * because past there the two are the same hue and only brightness tells them apart, which is
 * what `minV` is for.
 */
export const isBlue = band(205, 232, 0.3, 0.42);
/**
 * `#8AF606` and `#C4FF2E` — THE LIVE INSTRUMENT. 87° and 77° at full strength.
 *
 * This band used to be 130–165°, for a `#3DFF9A` "clean / smooth" green that the repaint
 * deleted. The palette's green is now the one measured off `assets/brand` (theme.ts, and
 * `assets/brand/README.md`: 36,599 green pixels in the mark), and it is 50° away from the old
 * one — so every check written against `colour: 'green'` before the repaint measured a hue
 * nothing on screen draws any more, and would have read 0 on a screen blazing with it.
 *
 * 62–105 is wide on purpose at both ends, and neither end is slack:
 *   • UP to 105 because antialiasing toward `bg0` (#070D18, hue 219) pulls green UP the wheel,
 *     not down — a 40 %-alpha edge pixel of `#8AF606` measures 92°, and the pool and the glow
 *     are nothing but such pixels.
 *   • DOWN to 62 and no further because the dial's ramp does not stop at the highlight: from 55°
 *     of slip to 70° it runs `#C4FF2E` → `#FF2E43`, and those interpolated pixels sweep 77 → 57
 *     → 45 → 33 → 12 → 354. 62 is the point past which the arc has stopped being green and
 *     started being the warning, which is what a check named `green` should stop counting.
 */
export const isGreen = band(62, 105);
/** `#F2F0EB` and friends: light, near-neutral ink. */
export const isText = (r, g, b) => {
  const max = Math.max(r, g, b);
  const c = max - Math.min(r, g, b);
  return max >= 200 && c <= 0.18 * max;
};
/** `#8A93A6`: the muted grey a refused reading is drawn in. */
export const isMuted = (r, g, b) => {
  const max = Math.max(r, g, b);
  const c = max - Math.min(r, g, b);
  return max >= 90 && max < 200 && c <= 0.28 * max;
};

/** Every predicate a route may name, by the name it names it with. */
export const COLOURS = {
  ember: isEmber,
  gold: isGold,
  red: isRed,
  magenta: isMagenta,
  cyan: isCyan,
  blue: isBlue,
  green: isGreen,
  text: isText,
  muted: isMuted,
};

export function colourPredicate(name) {
  const p = COLOURS[name];
  if (!p) throw new Error(`unknown colour '${name}'; known: ${Object.keys(COLOURS).join(', ')}`);
  return p;
}

/**
 * @param {Buffer} buffer PNG bytes
 * @param {{
 *   bg?: string,
 *   sampleStep?: number,
 *   regions?: Array<{ name: string, colour: string, rect?: { x?: number, y?: number, w?: number, h?: number }, max?: number, min?: number }>,
 * }} opts
 *
 * `regions` counts one colour inside one rectangle, given in FRACTIONS of the image
 * (`{ x: 0, y: 0.06, w: 1, h: 0.36 }` is the top-left-anchored band from 6 % to 42 % of the
 * height, full width). Each entry comes back with its count and whether it satisfied the `max`
 * and/or `min` it carries; `shoot.mjs` turns a violation into a route failure.
 */
export function analyzePng(buffer, { bg = '#070D18', sampleStep = 2, regions = [] } = {}) {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const bgRgb = hexToRgb(bg);
  const px = (x, y) => {
    const i = (y * width + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  const patch = (x0, y0, size) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        const p = px(x, y);
        r += p.r;
        g += p.g;
        b += p.b;
        n++;
      }
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  };
  const s = Math.max(4, Math.round(Math.min(width, height) * 0.01));
  const corners = {
    topLeft: patch(0, 0, s),
    topRight: patch(width - s, 0, s),
    bottomLeft: patch(0, height - s, s),
    bottomRight: patch(width - s, height - s, s),
  };
  // Exactly bg0 (tolerance 6) is the goal; a faint tint (up to 24) is a glow bleeding into the corner,
  // anything beyond that means the page background is wrong (wrong theme, white flash, unstyled body).
  const cornersOnBg = Object.values(corners).every((c) => near(c, bgRgb, 6));
  const cornersNearBg = Object.values(corners).every((c) => near(c, bgRgb, 24));

  let ember = 0;
  let gold = 0;
  let red = 0;
  let cyan = 0;
  let blue = 0;
  let text = 0;
  let nonBg = 0;
  let total = 0;
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const p = px(x, y);
      total++;
      if (!near(p, bgRgb, 8)) nonBg++;
      // NOT an if/else chain any more: the predicates are disjoint by construction (hue bands),
      // so each count is the count of that colour rather than "that colour, minus whatever an
      // earlier branch happened to take first".
      if (isEmber(p.r, p.g, p.b)) ember++;
      if (isGold(p.r, p.g, p.b)) gold++;
      if (isRed(p.r, p.g, p.b)) red++;
      if (isCyan(p.r, p.g, p.b)) cyan++;
      if (isBlue(p.r, p.g, p.b)) blue++;
      if (isText(p.r, p.g, p.b)) text++;
    }
  }
  const scale = sampleStep * sampleStep;
  const regionCounts = regions.map((r) => countRegion(png, r, sampleStep));
  return {
    width,
    height,
    corners,
    cornersOnBg,
    cornersNearBg,
    emberPixels: ember * scale,
    goldPixels: gold * scale,
    redPixels: red * scale,
    cyanPixels: cyan * scale,
    bluePixels: blue * scale,
    textPixels: text * scale,
    nonBgFraction: Number((nonBg / total).toFixed(4)),
    regions: regionCounts,
  };
}

/** Count one colour inside one fractional rectangle of an already-decoded PNG. */
function countRegion(png, region, sampleStep) {
  const { width, height, data } = png;
  const match = colourPredicate(region.colour);
  const rect = region.rect ?? {};
  const x0 = Math.max(0, Math.round((rect.x ?? 0) * width));
  const y0 = Math.max(0, Math.round((rect.y ?? 0) * height));
  const x1 = Math.min(width, Math.round(((rect.x ?? 0) + (rect.w ?? 1)) * width));
  const y1 = Math.min(height, Math.round(((rect.y ?? 0) + (rect.h ?? 1)) * height));
  let n = 0;
  for (let y = y0; y < y1; y += sampleStep) {
    for (let x = x0; x < x1; x += sampleStep) {
      const i = (y * width + x) * 4;
      if (match(data[i], data[i + 1], data[i + 2])) n++;
    }
  }
  const pixels = n * sampleStep * sampleStep;
  const failures = [];
  if (region.max !== undefined && pixels > region.max) failures.push(`at most ${region.max}`);
  if (region.min !== undefined && pixels < region.min) failures.push(`at least ${region.min}`);
  return {
    name: region.name,
    colour: region.colour,
    rect: { x: rect.x ?? 0, y: rect.y ?? 0, w: rect.w ?? 1, h: rect.h ?? 1 },
    box: { x0, y0, x1, y1 },
    pixels,
    max: region.max,
    min: region.min,
    ok: failures.length === 0,
    wanted: failures.join(' and '),
  };
}

/** Decode once and count several regions — for tools that are exploring rather than asserting. */
export function countRegions(buffer, regions, sampleStep = 2) {
  const png = PNG.sync.read(buffer);
  return regions.map((r) => countRegion(png, r, sampleStep));
}

export function rgbHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
