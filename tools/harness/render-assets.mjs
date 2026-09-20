#!/usr/bin/env node
/**
 * Renders the app icons and splash glyph (assets/images/*.png) from an inline SVG with headless
 * Chromium, so the brand mark is reproducible from code: ember gauge ring + italic "D" on asphalt.
 *
 *   node tools/harness/render-assets.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchChromium } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'assets', 'images');
const FONT = path.join(ROOT, 'node_modules', '@expo-google-fonts', 'barlow-condensed', '800ExtraBold_Italic', 'BarlowCondensed_800ExtraBold_Italic.ttf');

const BG0 = '#07090D';
const LINE = '#232B37';
const EMBER = '#FF5A1F';
const CYAN = '#29E3FF';
const TEXT = '#F2F0EB';

function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx, cy, r, startDeg, sweepDeg) {
  const [x0, y0] = polar(cx, cy, r, startDeg);
  const [x1, y1] = polar(cx, cy, r, startDeg + sweepDeg);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${sweepDeg > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** The mark, drawn in a 1000x1000 box centred at (500,500); `scale` shrinks it for safe zones. */
function mark({ scale = 1, mono = false, glyph = true }) {
  const c = 500;
  const r = 330 * scale;
  const w = 64 * scale;
  const start = 135;
  const track = arc(c, c, r, start, 270);
  const fill = arc(c, c, r, start, 270 * 0.72);
  const tick = [...Array(10)].map((_, i) => {
    const deg = start + (270 * i) / 9;
    const [x0, y0] = polar(c, c, r - w * 1.35, deg);
    const [x1, y1] = polar(c, c, r - w * 1.9, deg);
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }).join(' ');
  const ink = mono ? '#FFFFFF' : EMBER;
  return `
    ${mono ? '' : `<path d="${track}" stroke="${EMBER}" stroke-opacity="0.45" stroke-width="${w * 2.4}" fill="none" stroke-linecap="round" filter="url(#glow)"/>`}
    <path d="${track}" stroke="${mono ? '#FFFFFF' : LINE}" stroke-opacity="${mono ? 0.35 : 1}" stroke-width="${w}" fill="none" stroke-linecap="round"/>
    <path d="${fill}" stroke="${ink}" stroke-width="${w}" fill="none" stroke-linecap="round"/>
    ${mono ? '' : `<path d="${fill}" stroke="#FFFFFF" stroke-opacity="0.32" stroke-width="${w * 0.28}" fill="none" stroke-linecap="round"/>`}
    <path d="${tick}" stroke="${mono ? '#FFFFFF' : TEXT}" stroke-opacity="${mono ? 0.7 : 0.35}" stroke-width="${6 * scale}" stroke-linecap="round" fill="none"/>
    ${mono ? '' : `<circle cx="${polar(c, c, r + w * 1.2, start + 270 * 0.72)[0].toFixed(1)}" cy="${polar(c, c, r + w * 1.2, start + 270 * 0.72)[1].toFixed(1)}" r="${18 * scale}" fill="${CYAN}"/>`}
    ${glyph ? `<text x="${c + 8 * scale}" y="${c + 150 * scale}" text-anchor="middle" font-family="BarlowCondensed" font-weight="800" font-style="italic" font-size="${430 * scale}" fill="${mono ? '#FFFFFF' : TEXT}">D</text>` : ''}
  `;
}

function svg(size, inner, { background = null, vignette = false } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1000 1000">
    <defs>
      <filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="26"/></filter>
      <radialGradient id="vig" cx="78%" cy="18%" r="85%"><stop offset="0" stop-color="${EMBER}" stop-opacity="0.16"/><stop offset="1" stop-color="${EMBER}" stop-opacity="0"/></radialGradient>
    </defs>
    ${background ? `<rect width="1000" height="1000" fill="${background}"/>` : ''}
    ${vignette ? '<rect width="1000" height="1000" fill="url(#vig)"/>' : ''}
    ${inner}
  </svg>`;
}

const ASSETS = [
  { file: 'icon.png', size: 1024, svg: svg(1024, mark({}), { background: BG0, vignette: true }), transparent: false },
  { file: 'splash-icon.png', size: 512, svg: svg(512, mark({ scale: 0.95 })), transparent: true },
  { file: 'favicon.png', size: 64, svg: svg(64, mark({ scale: 1.05, glyph: true }), { background: BG0 }), transparent: false },
  { file: 'android-icon-foreground.png', size: 1024, svg: svg(1024, mark({ scale: 0.62 })), transparent: true },
  { file: 'android-icon-background.png', size: 1024, svg: svg(1024, '', { background: BG0, vignette: true }), transparent: false },
  { file: 'android-icon-monochrome.png', size: 1024, svg: svg(1024, mark({ scale: 0.62, mono: true })), transparent: true },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const font = readFileSync(FONT).toString('base64');
  const { browser } = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 1 });
  for (const a of ASSETS) {
    const html = `<!doctype html><html><head><style>
      @font-face { font-family: BarlowCondensed; font-weight: 800; font-style: italic; src: url(data:font/ttf;base64,${font}); }
      html, body { margin: 0; background: ${a.transparent ? 'transparent' : BG0}; }
      #a { width: ${a.size}px; height: ${a.size}px; }
      svg { display: block; }
    </style></head><body><div id="a">${a.svg}</div></body></html>`;
    await page.setContent(html);
    await page.evaluate(async () => {
      await document.fonts.load('italic 800 100px BarlowCondensed');
      await document.fonts.ready;
    });
    const buf = await page.locator('#a').screenshot({ omitBackground: a.transparent, type: 'png' });
    writeFileSync(path.join(OUT, a.file), buf);
    console.log(`[assets] ${a.file} ${a.size}x${a.size} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
