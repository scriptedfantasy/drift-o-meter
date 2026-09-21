/** Native: Skia is linked in, render the dial directly. (Web: `DialView.web.tsx`.) */
import Dial, { type DialProps } from './Dial';

export type { DialProps };

export default function DialView(props: DialProps) {
  return <Dial {...props} />;
}
