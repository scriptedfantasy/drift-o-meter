/**
 * Web: `@shopify/react-native-skia` binds `global.CanvasKit` when its module is evaluated, so the
 * gauge may only be imported once `LoadSkiaWeb` has resolved. `WithSkiaWeb` awaits the shared
 * promise (see `src/ui/skia/useSkiaReady.web.ts`) and then dynamically imports the component.
 */
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { View } from 'react-native';

import { skiaWebOptions } from '../skia/skiaWeb';
import type { AngleGaugeProps } from './AngleGauge';

export type { AngleGaugeProps };

export default function AngleGaugeView(props: AngleGaugeProps) {
  return (
    <WithSkiaWeb
      getComponent={() => import('./AngleGauge')}
      opts={skiaWebOptions}
      componentProps={props}
      fallback={<View style={{ width: props.width, height: props.height }} />}
    />
  );
}
