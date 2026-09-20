/**
 * Real sensors: expo-sensors DeviceMotion at 100 Hz + expo-location at the best navigation
 * accuracy. iOS is the target; Android gets the same code with its own axis mapping; web has
 * no usable sensors and `start()` rejects with `unsupported` (use the simulated source).
 */
import * as Location from 'expo-location';
import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors';
import { Platform } from 'react-native';

import { now } from './clock';
import { deviceMotionTimestampS, gpsSampleFromLocation, motionSampleFromDeviceMotion, type DevicePlatform } from './deviceConvert';
import { SensorSourceError, type SensorListeners, type SensorSource } from './sensorSource';

/** DeviceMotion update interval in ms (100 Hz). */
export const MOTION_INTERVAL_MS = 10;

export class DeviceSensorSource implements SensorSource {
  readonly kind = 'device' as const;

  private motionSub: { remove(): void } | null = null;
  private gpsSub: Location.LocationSubscription | null = null;
  private running = false;
  /** live clock − sensor clock, estimated from the first sample and re-estimated on jumps. */
  private offset: number | null = null;
  private readonly platform: DevicePlatform = Platform.OS === 'android' ? 'android' : 'ios';

  static isSupported(): boolean {
    return Platform.OS === 'ios' || Platform.OS === 'android';
  }

  async start(listeners: SensorListeners): Promise<void> {
    if (!DeviceSensorSource.isSupported()) {
      throw new SensorSourceError('unsupported', 'Real sensors are only available on iOS and Android. On web, run with the simulated source (?sim=harbor).');
    }
    this.stop();

    let available = false;
    try {
      available = await DeviceMotion.isAvailableAsync();
    } catch (err) {
      throw new SensorSourceError('unavailable', 'Could not query the motion sensors.', err);
    }
    if (!available) throw new SensorSourceError('unavailable', 'This device has no usable motion sensors.');

    try {
      const perm = await DeviceMotion.requestPermissionsAsync();
      if (perm.status === 'denied' && !perm.canAskAgain) {
        throw new SensorSourceError('permission-denied', 'Motion access was denied. Enable Motion & Fitness for Drift-O-Meter in Settings.');
      }
    } catch (err) {
      if (err instanceof SensorSourceError) throw err;
      // Some platforms have no motion permission concept; carry on.
    }

    const loc = await Location.requestForegroundPermissionsAsync().catch((err: unknown) => {
      throw new SensorSourceError('failed', 'Could not request location permission.', err);
    });
    if (loc.status !== 'granted') {
      throw new SensorSourceError('permission-denied', 'Location access is required to measure speed and direction of travel. Allow location while using the app.');
    }
    const enabled = await Location.hasServicesEnabledAsync().catch(() => true);
    if (!enabled) throw new SensorSourceError('services-disabled', 'Location Services are switched off. Turn them on in Settings.');

    this.offset = null;
    this.running = true;

    DeviceMotion.setUpdateInterval(MOTION_INTERVAL_MS);
    this.motionSub = DeviceMotion.addListener((m: DeviceMotionMeasurement) => {
      if (!this.running) return;
      listeners.onMotion(motionSampleFromDeviceMotion(m, this.toClock(deviceMotionTimestampS(m)), this.platform));
    });

    try {
      this.gpsSub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 100,
          distanceInterval: 0,
          mayShowUserSettingsDialog: true,
        },
        (fix) => {
          if (!this.running) return;
          listeners.onGps(gpsSampleFromLocation(fix, now()));
        },
        (err) => {
          console.warn('[sensors] location error', err);
        },
      );
    } catch (err) {
      this.stop();
      throw new SensorSourceError('failed', 'Could not start GPS updates.', err);
    }
  }

  stop(): void {
    this.running = false;
    this.motionSub?.remove();
    this.motionSub = null;
    this.gpsSub?.remove();
    this.gpsSub = null;
  }

  /**
   * Map a sensor timestamp (seconds since boot) onto the app's monotonic clock. The offset is
   * fixed by the first sample so the stream keeps the sensor's own, jitter-free spacing; if the
   * two clocks ever disagree by more than 0.5 s (app suspended, clock reset) we re-base.
   */
  private toClock(sensorTs: number | null): number {
    const live = now();
    if (sensorTs === null) return live;
    if (this.offset === null || Math.abs(sensorTs + this.offset - live) > 0.5) this.offset = live - sensorTs;
    return sensorTs + this.offset;
  }
}
