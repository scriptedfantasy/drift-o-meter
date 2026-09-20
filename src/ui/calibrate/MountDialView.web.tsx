/**
 * Web: `MountDial` imports `@shopify/react-native-skia`, which binds `global.CanvasKit` when
 * its module is evaluated — so it may only be imported after `LoadSkiaWeb` has resolved.
 * `WithSkiaWeb` awaits the shared promise and then dynamically imports the component.
 */
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { View } from 'react-native';

import { skiaWebOptions } from '../skia/skiaWeb';
import type { MountDialProps } from './MountDial';

export type { MountDialProps };

export default function MountDialView(props: MountDialProps) {
  return (
    <WithSkiaWeb
      getComponent={() => import('./MountDial')}
      opts={skiaWebOptions}
      componentProps={props}
      fallback={<View style={{ width: props.size, height: props.size }} />}
    />
  );
}
