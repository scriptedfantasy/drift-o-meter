/** Native: Skia is linked in, render the g-meter directly. (Web: `GMeterView.web.tsx`.) */
import GMeter, { type GMeterProps } from './GMeter';

export type { GMeterProps };

export default function GMeterView(props: GMeterProps) {
  return <GMeter {...props} />;
}
