/**
 * Web: `@shopify/react-native-skia` binds `global.CanvasKit` when its module is evaluated, so the
 * replay stage — and the geometry and resource modules it pulls in — may only be imported once
 * `LoadSkiaWeb` has resolved. `WithSkiaWeb` awaits the shared promise (see
 * `src/ui/skia/useSkiaReady.web.ts`) and then dynamically imports the component.
 *
 * In development expo-router evaluates every route module eagerly, so a static Skia import in the
 * replay route would break the web build even for someone who never opens a replay.
 */
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { StyleSheet, View } from 'react-native';

import { colors } from '../theme';
import { skiaWebOptions } from '../skia/skiaWeb';
import type { ReplayCanvasProps } from './ReplayCanvas';

export type { ReplayCanvasProps };

export default function ReplayCanvasView(props: ReplayCanvasProps) {
  return (
    <WithSkiaWeb
      getComponent={() => import('./ReplayCanvas')}
      opts={skiaWebOptions}
      componentProps={props}
      fallback={<View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg0 }]} />}
    />
  );
}
