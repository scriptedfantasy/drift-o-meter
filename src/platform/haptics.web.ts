/**
 * Web haptic port — a recorder, not a buzzer. (Native: `haptics.ts`.)
 *
 * expo-haptics DOES have a web implementation (`node_modules/expo-haptics/src/ExpoHaptics.web.ts`):
 * it calls `navigator.vibrate(pattern)`, and on iOS Safari falls back to clicking a hidden
 * `<input type="checkbox" switch>` appended to `document.head`. Neither is wanted here:
 *
 *  - The app has guarded every haptic behind `Platform.OS === 'web'` from the start, so calling
 *    it now would be a behaviour change smuggled in with a sound feature.
 *  - `navigator.vibrate` before a user has tapped the frame makes Chrome log an intervention
 *    ("Blocked call to navigator.vibrate…"). The capture harness records console output and a
 *    clean log is the gate; adding noise to it to no effect is a bad trade.
 *  - Appending and clicking an element in `document.head` sixty times a run, in a browser that
 *    was never going to vibrate, is a real cost for nothing.
 *
 * So the web port records what WOULD have been felt and reports it. The `/sound` lab shows that
 * record, which is the only way a haptic design can be reviewed on a machine with no haptics —
 * and it is the same data the native port acts on, because both sit behind `HapticPort`.
 */
import type { HapticPort } from './audioTypes';

export interface PreparedHapticPort extends HapticPort {
  readonly available: boolean;
  describe(): string;
  /** The last few shapes asked for. On web this is the only evidence the port was reached. */
  recent(): readonly string[];
}

const log: string[] = [];

function record(shape: string): void {
  log.push(shape);
  if (log.length > 16) log.splice(0, log.length - 16);
}

export function createHapticPort(): PreparedHapticPort {
  return {
    available: false,
    impact(shape) {
      record(shape);
    },
    notify(shape) {
      record(shape);
    },
    describe() {
      return 'web · no haptic engine — requests are recorded, not delivered';
    },
    recent() {
      return log;
    },
  };
}
