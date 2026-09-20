/** Native: Skia is always available, render the ring directly. (Web: `GlowRingView.web.tsx`.) */
import GlowRing, { type GlowRingProps } from './GlowRing';

export type { GlowRingProps };

export default function GlowRingView(props: GlowRingProps) {
  return <GlowRing {...props} />;
}
