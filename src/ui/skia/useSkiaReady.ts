/** Native: Skia is linked in, nothing to load. (Web variant: `useSkiaReady.web.ts`.) */
export type SkiaLoadState = 'loading' | 'ready' | 'error';

export function preloadSkia(): Promise<void> {
  return Promise.resolve();
}

export function useSkiaReady(): SkiaLoadState {
  return 'ready';
}
