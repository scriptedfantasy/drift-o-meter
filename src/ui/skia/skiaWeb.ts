/**
 * Where CanvasKit lives on web. `public/canvaskit.wasm` is copied from `canvaskit-wasm` by
 * `scripts/copy-canvaskit.mjs` (runs on postinstall and before every web export) so nothing is
 * fetched from a CDN at runtime.
 */
const baseUrl = (process.env.EXPO_BASE_URL ?? '').replace(/\/$/, '');

export const CANVASKIT_WASM_URL = `${baseUrl}/canvaskit.wasm`;

/** Options for `LoadSkiaWeb` / `WithSkiaWeb`. */
export const skiaWebOptions = {
  locateFile: (file: string) => (file.endsWith('.wasm') ? CANVASKIT_WASM_URL : file),
};
