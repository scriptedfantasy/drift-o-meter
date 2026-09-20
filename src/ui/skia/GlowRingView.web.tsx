/**
 * Web: defer evaluating `GlowRing` (and therefore `@shopify/react-native-skia`) until CanvasKit
 * has been loaded from `/canvaskit.wasm`. `WithSkiaWeb` awaits `LoadSkiaWeb` (shared promise)
 * and then dynamically imports the component.
 */
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { View } from 'react-native';

import type { GlowRingProps } from './GlowRing';
import { skiaWebOptions } from './skiaWeb';

export type { GlowRingProps };

export default function GlowRingView(props: GlowRingProps) {
  return (
    <WithSkiaWeb
      getComponent={() => import('./GlowRing')}
      opts={skiaWebOptions}
      componentProps={props}
      fallback={<View style={{ width: props.size, height: props.size }} />}
    />
  );
}
