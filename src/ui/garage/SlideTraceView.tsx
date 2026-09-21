/** Native: Skia is always available, draw the trace directly. (Web: `SlideTraceView.web.tsx`.) */
import SlideTrace, { type SlideTraceProps } from './SlideTrace';

export type { SlideTraceProps };

export default function SlideTraceView(props: SlideTraceProps) {
  return <SlideTrace {...props} />;
}
