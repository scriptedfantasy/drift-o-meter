/**
 * Tiny static server for the web export in dist/.
 *  - correct MIME types (notably application/wasm so WebAssembly.instantiateStreaming works)
 *  - expo-router static routes: `/drive` -> drive.html, `/results/abc` -> results/[id].html,
 *    `(group)` directories and `[...catch]` files are matched too
 *  - SPA fallback to index.html for anything else (200, so client routing can take over)
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const isDynamicDir = (name) => /^\[[^.\]]+\]$/.test(name) || /^\(.+\)$/.test(name);
const isDynamicHtml = (name) => /^\[[^.\]]+\]\.html$/.test(name);
const isCatchAllHtml = (name) => /^\[\.\.\..+\]\.html$/.test(name);

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function matchDynamic(dir, segs) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const [head, ...rest] = segs;
  if (rest.length === 0) {
    const exact = entries.find((e) => e.isFile() && e.name === `${head}.html`);
    if (exact) return path.join(dir, exact.name);
    const dyn = entries.find((e) => e.isFile() && isDynamicHtml(e.name));
    if (dyn) return path.join(dir, dyn.name);
  } else {
    const exactDir = entries.find((e) => e.isDirectory() && e.name === head);
    if (exactDir) {
      const r = matchDynamic(path.join(dir, head), rest);
      if (r) return r;
    }
    for (const e of entries) {
      if (e.isDirectory() && isDynamicDir(e.name)) {
        const r = matchDynamic(path.join(dir, e.name), rest);
        if (r) return r;
      }
    }
  }
  // route groups `(name)` are transparent: try descending into them without consuming a segment
  for (const e of entries) {
    if (e.isDirectory() && /^\(.+\)$/.test(e.name)) {
      const r = matchDynamic(path.join(dir, e.name), segs);
      if (r) return r;
    }
  }
  const catchAll = entries.find((e) => e.isFile() && isCatchAllHtml(e.name));
  if (catchAll) return path.join(dir, catchAll.name);
  return null;
}

/** Resolve a URL path to a file under root, or null. */
export function resolveFile(root, urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  const segs = clean.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s.includes('\0'))) return null;
  const direct = path.join(root, ...segs);
  if (!direct.startsWith(root)) return null;
  if (isFile(direct)) return direct;
  if (segs.length === 0) return isFile(path.join(root, 'index.html')) ? path.join(root, 'index.html') : null;
  if (isFile(path.join(direct, 'index.html'))) return path.join(direct, 'index.html');
  if (isFile(`${direct}.html`)) return `${direct}.html`;
  return matchDynamic(root, segs);
}

export async function startStaticServer({ root, port = 0, host = '127.0.0.1', log = () => {} }) {
  const absRoot = path.resolve(root);
  if (!existsSync(path.join(absRoot, 'index.html'))) {
    throw new Error(`No index.html in ${absRoot}. Run "npm run web:export" first (or drop --no-build).`);
  }
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    let file = resolveFile(absRoot, url);
    let status = 200;
    if (!file) {
      // Treat asset-looking misses as 404 so broken references are visible; route-looking ones fall back to the SPA shell.
      const last = url.split('?')[0].split('/').pop() ?? '';
      if (last.includes('.')) {
        status = 404;
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`Not found: ${url}`);
        log(`${status} ${url}`);
        return;
      }
      file = path.join(absRoot, 'index.html');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(status, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
    log(`${status} ${url} -> ${path.relative(absRoot, file)}`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
