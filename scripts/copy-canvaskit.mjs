#!/usr/bin/env node
/**
 * Copies CanvasKit (Skia for the web) from node_modules into public/ so the web build serves it
 * from the app's own origin: no CDN, no runtime downloads. Runs on postinstall and before every
 * `npm run web:export`. The copy in public/ is also committed, so a checkout works even when
 * install scripts are disabled.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'canvaskit-wasm', 'bin', 'full', 'canvaskit.wasm');
const dest = path.join(root, 'public', 'canvaskit.wasm');

if (!existsSync(src)) {
  console.warn(`[copy-canvaskit] ${path.relative(root, src)} not found (canvaskit-wasm not installed?). Skipping.`);
  process.exit(0);
}

const srcSize = statSync(src).size;
if (existsSync(dest) && statSync(dest).size === srcSize) {
  console.log(`[copy-canvaskit] public/canvaskit.wasm is up to date (${(srcSize / 1024 / 1024).toFixed(2)} MB).`);
  process.exit(0);
}

mkdirSync(path.dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-canvaskit] copied canvaskit.wasm -> public/ (${(srcSize / 1024 / 1024).toFixed(2)} MB).`);
