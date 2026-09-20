/** Native: Skia is linked in, render the gauge directly. (Web: `AngleGaugeView.web.tsx`.) */
import AngleGauge, { type AngleGaugeProps } from './AngleGauge';

export type { AngleGaugeProps };

export default function AngleGaugeView(props: AngleGaugeProps) {
  return <AngleGauge {...props} />;
}
