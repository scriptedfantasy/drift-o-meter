/**
 * Chromium launcher for this sandbox.
 *
 * Gotcha: playwright 1.63 expects Chromium build 1243 but only build 1194 is installed under
 * $PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers), and `playwright install` cannot download (no
 * CDN access). So we resolve the executable ourselves: $CHROMIUM_PATH, then playwright's own
 * idea of the path if it exists, then the newest chromium-<rev>/chrome-linux/chrome we can find.
 *
 * WebGL: headless Chromium 141 renders WebGL through SwiftShader (Vulkan) out of the box in
 * this environment; the extra flags below just make that explicit and stable across builds.
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const FLAGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--font-render-hinting=none',
  '--disable-dev-shm-usage',
];

function newestUnder(dir, prefix, relBinary) {
  if (!existsSync(dir)) return null;
  const builds = readdirSync(dir)
    .filter((n) => n.startsWith(`${prefix}-`))
    .map((n) => ({ n, rev: Number(n.slice(prefix.length + 1)) }))
    .filter((b) => Number.isFinite(b.rev))
    .sort((a, b) => b.rev - a.rev);
  for (const b of builds) {
    const p = path.join(dir, b.n, relBinary);
    if (existsSync(p)) return p;
  }
  return null;
}

export function resolveChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // ignore
  }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    const p = newestUnder(root, 'chromium', path.join('chrome-linux', 'chrome'));
    if (p) candidates.push(p);
  }
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error(`No Chromium executable found. Tried:\n  ${candidates.join('\n  ')}\nSet CHROMIUM_PATH to a chrome binary.`);
}

export async function launchChromium({ headless = true } = {}) {
  const executablePath = resolveChromium();
  const browser = await chromium.launch({ executablePath, headless, args: FLAGS });
  return { browser, executablePath };
}
