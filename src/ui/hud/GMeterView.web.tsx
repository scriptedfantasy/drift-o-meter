/**
 * Web: `@shopify/react-native-skia` binds `global.CanvasKit` when its module is evaluated, so the
 * g-meter may only be imported once `LoadSkiaWeb` has resolved. `WithSkiaWeb` awaits the shared
 * promise (see `src/ui/skia/useSkiaReady.web.ts`) and then dynamically imports the component.
 */
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { View } from 'react-native';

import { skiaWebOptions } from '../skia/skiaWeb';
import type { GMeterProps } from './GMeter';

export type { GMeterProps };

export default function GMeterView(props: GMeterProps) {
  return (
    <WithSkiaWeb
      getComponent={() => import('./GMeter')}
      opts={skiaWebOptions}
      componentProps={props}
      fallback={<View style={{ width: props.width, height: props.height }} />}
    />
  );
}
