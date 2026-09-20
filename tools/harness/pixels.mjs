/** PNG pixel statistics used to prove a screenshot shows what we think it shows. */
import { PNG } from 'pngjs';

export const BG0 = { r: 0x07, g: 0x09, b: 0x0d };

function hexToRgb(hex) {
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

function near(a, b, tol) {
  return Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
}

function isEmber(r, g, b) {
  // #FF5A1F and its glow: hot red-orange, clearly above blue
  return r >= 170 && g >= 40 && g <= 150 && b <= 110 && r - b >= 90;
}
function isCyan(r, g, b) {
  return b >= 150 && g >= 140 && r <= 140 && b - r >= 60;
}
function isText(r, g, b) {
  return r >= 200 && g >= 200 && b >= 190;
}

/**
 * @param {Buffer} buffer PNG bytes
 * @param {{ bg?: string, sampleStep?: number }} opts
 */
export function analyzePng(buffer, { bg = '#07090D', sampleStep = 2 } = {}) {
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
  let cyan = 0;
  let text = 0;
  let nonBg = 0;
  let total = 0;
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const p = px(x, y);
      total++;
      if (!near(p, bgRgb, 8)) nonBg++;
      if (isEmber(p.r, p.g, p.b)) ember++;
      else if (isCyan(p.r, p.g, p.b)) cyan++;
      else if (isText(p.r, p.g, p.b)) text++;
    }
  }
  const scale = sampleStep * sampleStep;
  return {
    width,
    height,
    corners,
    cornersOnBg,
    cornersNearBg,
    emberPixels: ember * scale,
    cyanPixels: cyan * scale,
    textPixels: text * scale,
    nonBgFraction: Number((nonBg / total).toFixed(4)),
  };
}

export function rgbHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
