/** Native: Skia is always there, draw the dial directly. (Web: `MountDialView.web.tsx`.) */
import MountDial, { type MountDialProps } from './MountDial';

export type { MountDialProps };

export default function MountDialView(props: MountDialProps) {
  return <MountDial {...props} />;
}
