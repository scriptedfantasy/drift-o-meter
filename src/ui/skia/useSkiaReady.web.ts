/**
 * Web: CanvasKit (Skia compiled to wasm) has to be fetched and instantiated before ANY module
 * that imports `@shopify/react-native-skia` is evaluated, because `Skia.web.js` binds
 * `global.CanvasKit` at import time. The root layout waits on this before mounting routes; the
 * lazy component wrappers in this folder share the same promise so nothing loads twice.
 */
import { LoadSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { useEffect, useState } from 'react';

import { skiaWebOptions } from './skiaWeb';

export type SkiaLoadState = 'loading' | 'ready' | 'error';

let pending: Promise<void> | null = null;

export function preloadSkia(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  pending ??= LoadSkiaWeb(skiaWebOptions);
  return pending;
}

export function useSkiaReady(): SkiaLoadState {
  // Always start as 'loading' so the first client render matches the statically rendered HTML.
  const [state, setState] = useState<SkiaLoadState>('loading');
  useEffect(() => {
    let alive = true;
    preloadSkia().then(
      () => alive && setState('ready'),
      (err: unknown) => {
        console.error('[skia] CanvasKit failed to load', err);
        if (alive) setState('error');
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
