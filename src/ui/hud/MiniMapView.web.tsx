/** Web: load the map only after CanvasKit is ready (see `DialView.web.tsx`). */
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { View } from 'react-native';

import { skiaWebOptions } from '../skia/skiaWeb';
import type { MiniMapProps } from './MiniMap';

export type { MiniMapProps };

export default function MiniMapView(props: MiniMapProps) {
  return (
    <WithSkiaWeb
      getComponent={() => import('./MiniMap')}
      opts={skiaWebOptions}
      componentProps={props}
      fallback={<View style={{ width: props.width, height: props.height }} />}
    />
  );
}
