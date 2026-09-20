/** Native: Skia is linked in, render the map directly. (Web: `MiniMapView.web.tsx`.) */
import MiniMap, { type MiniMapProps } from './MiniMap';

export type { MiniMapProps };

export default function MiniMapView(props: MiniMapProps) {
  return <MiniMap {...props} />;
}
