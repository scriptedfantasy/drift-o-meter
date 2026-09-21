/**
 * Web: defer evaluating `SlideTrace` (and therefore `@shopify/react-native-skia`) until
 * CanvasKit has been loaded from `/canvaskit.wasm`. `WithSkiaWeb` awaits `LoadSkiaWeb` (the
 * shared promise the root layout already holds) and then dynamically imports the component.
 */
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { View } from 'react-native';

import { skiaWebOptions } from '../skia/skiaWeb';
import type { SlideTraceProps } from './SlideTrace';

export type { SlideTraceProps };

export default function SlideTraceView(props: SlideTraceProps) {
  return (
    <WithSkiaWeb
      getComponent={() => import('./SlideTrace')}
      opts={skiaWebOptions}
      componentProps={props}
      fallback={<View style={{ width: props.width, height: props.height ?? 58 }} />}
    />
  );
}
