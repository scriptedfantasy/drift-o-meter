/**
 * Web: `@shopify/react-native-skia` binds `global.CanvasKit` when its module is evaluated, so the
 * burst may only be imported after `LoadSkiaWeb` has resolved. `WithSkiaWeb` awaits the same
 * shared promise the root layout uses and then dynamically imports the component.
 *
 * NEVER import `./GradeBurst` from a route: expo-router evaluates every route module eagerly.
 */
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { View } from 'react-native';

import { skiaWebOptions } from '../../skia/skiaWeb';
import type { GradeBurstProps } from './GradeBurst';

export type { GradeBurstProps };

export default function GradeBurstView(props: GradeBurstProps) {
  return (
    <WithSkiaWeb
      getComponent={() => import('./GradeBurst')}
      opts={skiaWebOptions}
      componentProps={props}
      fallback={<View style={{ width: props.size, height: props.height ?? props.size }} />}
    />
  );
}
