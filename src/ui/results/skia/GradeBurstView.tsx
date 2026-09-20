/** Native: Skia is linked in, render the burst directly. (Web: `GradeBurstView.web.tsx`.) */
import GradeBurst, { type GradeBurstProps } from './GradeBurst';

export type { GradeBurstProps };

export default function GradeBurstView(props: GradeBurstProps) {
  return <GradeBurst {...props} />;
}
