#!/usr/bin/env node
/**
 * Drift-O-Meter verification harness.
 *
 *   node tools/harness/shoot.mjs [--no-build] [--video] [--landscape] [--routes file] [--only a,b]
 *                                [--out dir] [--video-dir dir] [--port n] [--no-font-check] [--full-page] [--scale n] [--fresh]
 *
 * Builds the web export (unless --no-build), serves dist/ on a free port, drives the real app in
 * headless Chromium with an iPhone 15 Pro profile, screenshots every route into
 * artifacts/shots/<name>.png (+ .webm videos with --video), checks fonts / Skia / background
 * pixels, writes artifacts/shots/console.log and report.json, and exits non-zero on any page
 * error, console.error, failed request, HTTP >= 400 or failed check. See README.md.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launchChromium } from './browser.mjs';
import { analyzePng, rgbHex } from './pixels.mjs';
import { defaultRoutes } from './routes.mjs';
import { startStaticServer } from './staticServer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DIST = path.join(ROOT, 'dist');
const PORTRAIT = { width: 393, height: 852 };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function usage() {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n').replace(/^ \*\/?/gm, ''));
}

function parseArgs(argv) {
  const args = {
    build: true,
    video: false,
    landscape: false,
    routesFile: null,
    only: null,
    out: path.join(ROOT, 'artifacts', 'shots'),
    videoDir: path.join(ROOT, 'artifacts', 'video'),
    port: 0,
    fontCheck: true,
    fullPage: false,
    scale: 3,
    // Where the built app is served from. Concurrent agents matter here: `expo export` clears
    // `dist/` before writing it, so one agent rebuilding kills another's running capture with
    // ENOENT on index.html. Three separate agents lost runs to that and each invented the same
    // workaround by hand. `--dist <dir>` makes a private copy first-class instead.
    dist: DEFAULT_DIST,
    // A partial run MERGES into whatever console.log / report.json are already in `--out`
    // (see `mergeAggregates`). `--fresh` throws the old ones away instead.
    fresh: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--no-build': args.build = false; break;
      case '--video': args.video = true; break;
      case '--landscape': args.landscape = true; break;
      case '--routes': args.routesFile = path.resolve(next()); break;
      case '--only': args.only = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--out': args.out = path.resolve(next()); break;
      case '--dist': args.dist = path.resolve(next()); break;
      case '--video-dir': args.videoDir = path.resolve(next()); break;
      case '--port': args.port = Number(next()); break;
      case '--no-font-check': args.fontCheck = false; break;
      case '--full-page': args.fullPage = true; break;
      case '--scale': args.scale = Number(next()); break;
      case '--fresh': args.fresh = true; break;
      case '-h':
      case '--help': args.help = true; break;
      default: throw new Error(`Unknown argument: ${a} (try --help)`);
    }
  }
  return args;
}

async function loadRoutes(file) {
  // The default list is checked too. It is the one every agent appends to, so it is the one that
  // grows a hole; a guard that skips it guards the wrong file.
  if (!file) {
    assertRouteList(defaultRoutes, 'tools/harness/routes.mjs');
    return defaultRoutes;
  }
  if (file.endsWith('.json')) {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    assertRouteList(json, file);
    return json;
  }
  const mod = await import(pathToFileURL(file).href);
  const routes = mod.default ?? mod.routes ?? mod.defaultRoutes;
  if (!Array.isArray(routes)) throw new Error(`${file} must export an array of routes (default export or "routes")`);
  assertRouteList(routes, file);
  return routes;
}

/**
 * WHY A PARTIAL SHOOT MERGES.
 *
 * `console.log` and `report.json` are the evidence a critic reads: they are how anyone knows a
 * frame was captured without a page error, a failed request or a missing font. They are also
 * ONE file each for the whole app, while almost every capture run is `--only <one screen>`.
 * Rewriting them wholesale meant the last agent to shoot silently erased every other screen's
 * record, leaving an aggregate that looks complete and covers one screen. One agent noticed and
 * restored the files from git by hand after every pass; the rest is the failure nobody noticed.
 *
 * So a run now replaces only the routes it actually shot and keeps the rest, in place. `--fresh`
 * is the old behaviour, for a full run that should start from nothing.
 */
const BLOCK = /^===== (\S+)/;

/** Split an existing console.log into `name -> block`, preserving order. */
function consoleBlocks(text) {
  const out = new Map();
  let name = null;
  let buf = [];
  for (const line of text.split('\n')) {
    const m = BLOCK.exec(line);
    if (m) {
      if (name !== null) out.set(name, buf.join('\n'));
      name = m[1];
      buf = [line];
    } else if (name !== null) {
      buf.push(line);
    }
  }
  if (name !== null) out.set(name, buf.join('\n'));
  return out;
}

function mergeConsole(args, shot, lines) {
  const fresh = lines.join('\n');
  const file = path.join(args.out, 'console.log');
  if (args.fresh || !existsSync(file)) return fresh;
  let prior;
  try {
    prior = consoleBlocks(readFileSync(file, 'utf8'));
  } catch {
    return fresh;
  }
  const now = consoleBlocks(fresh);
  // Replace in place what we re-shot; append what is new; leave everything else untouched.
  for (const [name, block] of now) prior.set(name, block);
  const kept = [...prior.keys()].filter((n) => !shot.includes(n)).length;
  if (kept > 0) console.log(`[shoot] merged into console.log: ${now.size} re-shot, ${kept} other route(s) kept`);
  return [...prior.values()].join('\n');
}

function mergeReport(args, shot, report) {
  const file = path.join(args.out, 'report.json');
  for (const r of report.routes) r.shotAt = report.finishedAt;
  if (args.fresh || !existsSync(file)) return report;
  let prior;
  try {
    prior = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return report;
  }
  if (!Array.isArray(prior.routes)) return report;
  const byName = new Map(prior.routes.map((r) => [r.name, r]));
  for (const r of report.routes) byName.set(r.name, r);
  const merged = [...byName.values()];
  return {
    ...report,
    // `failed` counts THIS run; `failedAll` counts the aggregate, which is what a reader of the
    // file cares about. Both are stated so neither can be mistaken for the other.
    failedAll: merged.filter((r) => r.ok === false).length,
    shotThisRun: shot,
    routes: merged,
  };
}

/**
 * A route list is checked BEFORE the browser starts, because the alternative is finding out 105
 * frames into a forty-minute capture.
 *
 * The hole this catches is specific and it has happened: two agents appended near the same place
 * and left `},,`, which in JavaScript is a sparse array. `routes.length` still says 114, the
 * module still parses, and every check anyone had run — "114 routes, no duplicates" — still
 * passed. The undefined only surfaces when something iterates far enough to reach it.
 *
 * Append-only editing stopped one file being clobbered and produced this instead; a rule that
 * makes concurrent edits safe does not make them correct.
 */
function assertRouteList(routes, where) {
  const problems = [];
  const seen = new Map();
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    if (!r || typeof r !== 'object') {
      problems.push(`index ${i} is ${r === undefined ? 'a hole (look for a double comma)' : JSON.stringify(r)}, between ${routes[i - 1]?.name ?? 'the start'} and ${routes[i + 1]?.name ?? 'the end'}`);
      continue;
    }
    if (typeof r.name !== 'string' || !r.name) problems.push(`index ${i} has no name`);
    else if (seen.has(r.name)) problems.push(`duplicate name "${r.name}" at ${seen.get(r.name)} and ${i}`);
    else seen.set(r.name, i);
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) problems.push(`route "${r.name ?? i}" has no usable path`);
  }
  if (problems.length) {
    console.error(`[shoot] ${where} is not a usable route list:`);
    for (const p of problems) console.error(`          - ${p}`);
    process.exit(1);
  }
}

function build(dist) {
  console.log('\n[shoot] building web export (npm run web:export)...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'web:export'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  if (r.status !== 0) {
    console.error('[shoot] web export FAILED');
    process.exit(r.status ?? 1);
  }
  // Building into a private dist means copying the fresh export there, so the capture is
  // insulated from anyone else's rebuild for the rest of the run.
  if (dist !== DEFAULT_DIST) {
    rmSync(dist, { recursive: true, force: true });
    cpSync(DEFAULT_DIST, dist, { recursive: true });
    console.log(`[shoot] copied the export to ${dist}`);
  }
}

async function waitForApp(page) {
  // The root layout renders a bare bg0 view (data-testid="boot") until fonts + CanvasKit are ready.
  await page.waitForSelector('[data-testid="boot"]', { state: 'detached', timeout: 30000 }).catch(() => {});
}

async function fontReport(page, timeoutMs) {
  return page.evaluate(async (timeout) => {
    const deadline = Date.now() + timeout;
    const loaded = () => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, ''));
    try {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, timeout))]);
    } catch {
      // ignore
    }
    while (Date.now() < deadline && !loaded().some((f) => /Barlow/i.test(f))) await new Promise((r) => setTimeout(r, 100));
    let display = 0;
    let body = 0;
    let other = 0;
    for (const el of document.querySelectorAll('div, span, p, h1, h2, h3, button')) {
      if (!el.textContent || !el.textContent.trim() || el.children.length > 0) continue;
      const ff = getComputedStyle(el).fontFamily;
      if (ff.includes('BarlowCondensed')) display++;
      else if (ff.includes('Barlow')) body++;
      else other++;
    }
    return { status: document.fonts.status, families: [...new Set(loaded())].sort(), displayTextNodes: display, bodyTextNodes: body, otherTextNodes: other };
  }, timeoutMs);
}

/**
 * Turn a route's region list into rectangles `pixels.mjs` can count in.
 *
 * A region may give its rectangle as fractions of the viewport (`rect`) or, better, NAME THE
 * ELEMENT it is about (`testId`). Naming the element is what keeps a ceiling honest as the
 * layout moves: "at most N ember pixels inside the gauge" stays a statement about the gauge in
 * portrait, in landscape and at any device scale, while a hand-written fraction silently starts
 * measuring the wrong band the first time a row changes height. `padFrac` grows the box (as a
 * fraction of the viewport) so a glow just outside the element's own bounds is still counted.
 */
async function resolveRegions(page, regions) {
  if (regions.length === 0) return [];
  const out = [];
  for (const r of regions) {
    if (!r.testId) {
      out.push(r);
      continue;
    }
    const box = await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x / window.innerWidth, y: b.y / window.innerHeight, w: b.width / window.innerWidth, h: b.height / window.innerHeight };
    }, r.testId);
    if (!box) throw new Error(`region '${r.name}': no element with testID '${r.testId}'`);
    const pad = r.padFrac ?? 0;

    // The element's own box, which may sit partly or wholly outside the frame.
    const want = { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
    // ...and the part of it the screenshot actually contains.
    const x0 = Math.min(1, Math.max(0, want.x));
    const y0 = Math.min(1, Math.max(0, want.y));
    const x1 = Math.min(1, Math.max(0, want.x + want.w));
    const y1 = Math.min(1, Math.max(0, want.y + want.h));
    const rect = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };

    /**
     * How much of the element the frame holds.
     *
     * The bottom edge used to go unclamped, and that is a way for a check to pass without
     * reading a pixel: an element below the fold yields y > 1, `countRegion` starts its walk
     * past the last row, counts nothing, and a `max` ceiling is satisfied by the absence of a
     * rectangle rather than by the absence of a colour. Three garage routes were green that
     * way. A ceiling is the only shape of check that can certify an absence (see the header of
     * pixels.mjs), which is exactly why it must never be handed an empty region.
     */
    const area = Math.max(0, want.w) * Math.max(0, want.h);
    const visibleFrac = area > 0 ? (rect.w * rect.h) / area : 0;
    if (rect.w <= 0 || rect.h <= 0) {
      throw new Error(
        `region '${r.name}': '${r.testId}' is not in the frame (its box is at y=${want.y.toFixed(2)}..${(want.y + want.h).toFixed(2)}, ` +
          `x=${want.x.toFixed(2)}..${(want.x + want.w).toFixed(2)}); scroll the route to it, or measure something that is on screen`,
      );
    }
    out.push({ ...r, rect, visibleFrac });
  }
  return out;
}

async function skiaReport(page) {
  return page.evaluate(() => {
    let webgl = false;
    try {
      const c = document.createElement('canvas');
      webgl = !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      // ignore
    }
    return { canvases: document.querySelectorAll('canvas').length, webgl, canvasKit: typeof globalThis.CanvasKit !== 'undefined' };
  });
}

async function runAction(page, action, ctx) {
  const timeout = action.timeout ?? 10000;
  switch (action.type) {
    case 'tap': {
      const loc = action.selector ? page.locator(action.selector) : action.testId ? page.getByTestId(action.testId) : page.getByText(action.text, { exact: action.exact ?? false });
      await loc.first().tap({ timeout });
      return;
    }
    case 'wait':
      await page.waitForTimeout(action.ms ?? 500);
      return;
    case 'waitFor': {
      const loc = action.selector ? page.locator(action.selector) : action.testId ? page.getByTestId(action.testId) : page.getByText(action.text, { exact: action.exact ?? false });
      await loc.first().waitFor({ timeout, state: action.state ?? 'visible' });
      return;
    }
    case 'scroll':
      await page.mouse.move(action.x ?? ctx.viewport.width / 2, action.yFrom ?? ctx.viewport.height / 2);
      await page.mouse.wheel(0, action.y ?? 400);
      return;
    case 'press':
      await page.keyboard.press(action.key);
      return;
    case 'eval':
      await page.evaluate(action.js);
      return;
    case 'goto':
      await page.goto(ctx.base + action.path, { waitUntil: 'load', timeout: 60000 });
      await waitForApp(page);
      return;
    case 'screenshot':
      await page.screenshot({ path: ctx.shotPath(action.name), fullPage: action.fullPage ?? false });
      return;
    default:
      throw new Error(`Unknown action type "${action.type}"`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  let routes = await loadRoutes(args.routesFile);
  if (args.only) routes = routes.filter((r) => args.only.includes(r.name));
  if (routes.length === 0) throw new Error('No routes selected');

  if (args.build) build(args.dist);
  if (!existsSync(path.join(args.dist, 'index.html'))) {
    throw new Error(`${path.relative(ROOT, args.dist)}/index.html missing; run without --no-build, or pass --dist <dir> pointing at an export you already have`);
  }

  mkdirSync(args.out, { recursive: true });
  if (args.video) mkdirSync(args.videoDir, { recursive: true });
  const suffix = args.landscape ? '-landscape' : '';
  const viewport = args.landscape ? { width: PORTRAIT.height, height: PORTRAIT.width } : PORTRAIT;
  const consoleLines = [];
  const log = (line) => {
    consoleLines.push(line);
  };

  const server = await startStaticServer({ root: args.dist, port: args.port });
  const { browser, executablePath } = await launchChromium();
  console.log(`[shoot] serving ${path.relative(ROOT, args.dist)} at ${server.url}`);
  console.log(`[shoot] chromium: ${executablePath} (${browser.version()})`);
  console.log(`[shoot] viewport ${viewport.width}x${viewport.height} @${args.scale}x, ${args.landscape ? 'landscape' : 'portrait'}${args.video ? ', recording video' : ''}`);

  const report = { startedAt: new Date().toISOString(), viewport, scale: args.scale, landscape: args.landscape, chromium: browser.version(), routes: [] };
  const tmpVideo = args.video ? mkdtempSync(path.join(os.tmpdir(), 'dom-video-')) : null;
  let failed = 0;

  for (const route of routes) {
    const name = `${route.name}${suffix}`;
    const shotPath = path.join(args.out, `${name}.png`);
    const result = { name, path: route.path, url: server.url + route.path, ok: true, errors: [], warnings: [], screenshot: path.relative(ROOT, shotPath), video: null, ms: 0 };
    const t0 = Date.now();
    log(`\n===== ${name}  ${result.url}`);
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: args.scale,
      isMobile: true,
      hasTouch: true,
      userAgent: IPHONE_UA,
      colorScheme: 'dark',
      locale: 'en-US',
      recordVideo: args.video ? { dir: tmpVideo, size: viewport } : undefined,
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const type = msg.type();
      log(`[${name}] console.${type}: ${msg.text()}`);
      if (type === 'error') result.errors.push(`console.error: ${msg.text().slice(0, 500)}`);
      else if (type === 'warning') result.warnings.push(msg.text().slice(0, 300));
    });
    page.on('pageerror', (err) => {
      log(`[${name}] pageerror: ${err.stack ?? err.message}`);
      result.errors.push(`pageerror: ${err.message}`);
    });
    page.on('requestfailed', (req) => {
      const why = req.failure()?.errorText ?? 'unknown';
      log(`[${name}] requestfailed: ${req.url()} (${why})`);
      if (why !== 'net::ERR_ABORTED') result.errors.push(`requestfailed: ${req.url()} (${why})`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        log(`[${name}] http ${res.status()}: ${res.url()}`);
        result.errors.push(`http ${res.status()}: ${res.url()}`);
      }
    });
    const ctx = { base: server.url, viewport, shotPath: (n) => path.join(args.out, `${n}${suffix}.png`) };
    try {
      await page.goto(result.url, { waitUntil: 'load', timeout: 60000 });
      await waitForApp(page);
      result.fonts = await fontReport(page, 15000);
      if (route.expectCanvas) {
        await page.waitForSelector('canvas', { timeout: 20000 }).catch((e) => result.errors.push(`no <canvas> appeared: ${e.message.split('\n')[0]}`));
      }
      await page.waitForTimeout(route.waitMs ?? 800);
      for (const action of route.actions ?? []) await runAction(page, action, ctx);
      result.skia = await skiaReport(page);
      const buf = await page.screenshot({ path: shotPath, fullPage: route.fullPage ?? args.fullPage });
      result.pixels = analyzePng(buf, { regions: await resolveRegions(page, route.regions ?? []) });

      if (args.fontCheck) {
        if (!result.fonts.families.some((f) => /Barlow/i.test(f))) result.errors.push(`fonts: no Barlow face loaded (loaded: ${result.fonts.families.join(', ') || 'none'})`);
        if (result.fonts.displayTextNodes === 0) result.errors.push('fonts: no text rendered in BarlowCondensed');
        if (result.fonts.otherTextNodes > 0) result.warnings.push(`${result.fonts.otherTextNodes} text nodes use a non-Barlow font`);
      }
      if (route.expectCanvas && result.skia.canvases === 0) result.errors.push('skia: expected a <canvas>, found none');
      if (route.minEmber && result.pixels.emberPixels < route.minEmber) result.errors.push(`pixels: only ${result.pixels.emberPixels} ember pixels (< ${route.minEmber}); the ring did not render`);
      // Region checks: "at most / at least N pixels of colour C inside rectangle R". A ceiling is
      // the only shape of check that can certify an ABSENCE — see the header of pixels.mjs.
      for (const r of result.pixels.regions ?? []) {
        // A ceiling on a region the frame mostly does not hold certifies almost nothing: most
        // of what it claims is absent was never looked at. A floor is safe — it fails loudly.
        if (typeof r.max === 'number' && typeof r.visibleFrac === 'number' && r.visibleFrac < 0.6) {
          result.errors.push(
            `region '${r.name}': only ${Math.round(r.visibleFrac * 100)}% of it is in the frame, so a ceiling on it proves nothing; scroll to it first`,
          );
        }
        if (!r.ok) {
          const b = r.box;
          result.errors.push(
            `pixels: region '${r.name}' has ${r.pixels} ${r.colour} pixels, wanted ${r.wanted} (x ${b.x0}–${b.x1}, y ${b.y0}–${b.y1})`,
          );
        }
      }
      if (!result.pixels.cornersNearBg) {
        const c = result.pixels.corners;
        result.errors.push(`pixels: page background is not bg0 (corners ${rgbHex(c.topLeft)} ${rgbHex(c.topRight)} ${rgbHex(c.bottomLeft)} ${rgbHex(c.bottomRight)})`);
      } else if (!result.pixels.cornersOnBg) {
        const c = result.pixels.corners;
        result.warnings.push(`pixels: a glow tints a corner (${rgbHex(c.topLeft)} ${rgbHex(c.topRight)} ${rgbHex(c.bottomLeft)} ${rgbHex(c.bottomRight)})`);
      }
    } catch (err) {
      result.errors.push(`harness: ${err.message.split('\n')[0]}`);
      try {
        await page.screenshot({ path: shotPath });
      } catch {
        // ignore
      }
    }
    const video = args.video ? page.video() : null;
    await context.close();
    if (video) {
      const target = path.join(args.videoDir, `${name}.webm`);
      try {
        await video.saveAs(target);
        await video.delete();
        result.video = path.relative(ROOT, target);
      } catch (err) {
        result.warnings.push(`video: ${err.message}`);
      }
    }
    result.ms = Date.now() - t0;
    result.ok = result.errors.length === 0;
    if (!result.ok) failed++;
    report.routes.push(result);

    const f = result.fonts ?? {};
    const px = result.pixels ?? {};
    const sk = result.skia ?? {};
    console.log(
      `[shoot] ${result.ok ? 'OK  ' : 'FAIL'} ${name.padEnd(20)} ${String(result.ms).padStart(5)} ms  fonts:${(f.families ?? []).filter((x) => /Barlow/.test(x)).length}/9 display:${f.displayTextNodes ?? '-'} body:${f.bodyTextNodes ?? '-'} other:${f.otherTextNodes ?? '-'}  canvas:${sk.canvases ?? '-'} webgl:${sk.webgl ?? '-'}  ember:${px.emberPixels ?? '-'} gold:${px.goldPixels ?? '-'} red:${px.redPixels ?? '-'} cyan:${px.cyanPixels ?? '-'} nonBg:${px.nonBgFraction ?? '-'} corners:${px.cornersOnBg ?? '-'}${(px.regions ?? []).map((r) => `  ${r.name}[${r.colour}]:${r.pixels}`).join('')}`,
    );
    for (const e of result.errors) console.log(`         - ${e}`);
  }

  await browser.close();
  await server.close();
  if (tmpVideo) rmSync(tmpVideo, { recursive: true, force: true });

  report.finishedAt = new Date().toISOString();
  report.failed = failed;
  const shot = routes.map((r) => `${r.name}${suffix}`);
  writeFileSync(path.join(args.out, 'console.log'), mergeConsole(args, shot, consoleLines) + '\n');
  writeFileSync(path.join(args.out, 'report.json'), JSON.stringify(mergeReport(args, shot, report), null, 2) + '\n');
  console.log(`\n[shoot] screenshots -> ${path.relative(ROOT, args.out)}/  console -> ${path.relative(ROOT, path.join(args.out, 'console.log'))}  report -> report.json`);
  if (failed > 0) {
    console.error(`\n[shoot] FAILED: ${failed} of ${routes.length} routes had errors. See ${path.relative(ROOT, path.join(args.out, 'console.log'))}`);
    process.exit(1);
  }
  console.log(`[shoot] all ${routes.length} routes clean`);
}

main().catch((err) => {
  console.error(`[shoot] ${err.stack ?? err}`);
  process.exit(1);
});
