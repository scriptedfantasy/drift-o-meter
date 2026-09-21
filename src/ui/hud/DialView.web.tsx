/**
 * Web: `@shopify/react-native-skia` binds `global.CanvasKit` when its module is evaluated, so the
 * dial may only be imported once `LoadSkiaWeb` has resolved. `WithSkiaWeb` awaits the shared
 * promise (see `src/ui/skia/useSkiaReady.web.ts`) and then dynamically imports the component.
 */
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { View } from 'react-native';

import { skiaWebOptions } from '../skia/skiaWeb';
import type { DialProps } from './Dial';

export type { DialProps };

export default function DialView(props: DialProps) {
  return (
    <WithSkiaWeb
      getComponent={() => import('./Dial')}
      opts={skiaWebOptions}
      componentProps={props}
      fallback={<View style={{ width: props.size, height: props.size }} />}
    />
  );
}
