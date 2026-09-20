/** Native: Skia is linked in, render the stage directly. (Web: `ReplayCanvasView.web.tsx`.) */
import ReplayCanvas, { type ReplayCanvasProps } from './ReplayCanvas';

export type { ReplayCanvasProps };

export default function ReplayCanvasView(props: ReplayCanvasProps) {
  return <ReplayCanvas {...props} />;
}
