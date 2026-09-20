/** Display formatters shared by screens. Engine values are SI; these turn them into words. */
import { radToDeg } from '../engine/types';

export type SpeedUnits = 'kmh' | 'mph';

export function formatScore(points: number): string {
  if (!Number.isFinite(points)) return '0';
  return Math.round(points).toLocaleString('en-US');
}

/** `2:14` (m:ss) or `1:02:14` above an hour. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `20 Sep · 13:42` */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} · ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function speedUnitLabel(units: SpeedUnits): string {
  return units === 'mph' ? 'mph' : 'km/h';
}

/** m/s → km/h or mph, rounded; `--` when unknown. */
export function formatSpeed(mps: number, units: SpeedUnits = 'kmh'): string {
  if (!Number.isFinite(mps) || mps < 0) return '--';
  const v = units === 'mph' ? mps * 2.23694 : mps * 3.6;
  return String(Math.round(v));
}

/** radians → whole degrees with the degree sign. */
export function formatAngle(rad: number, digits = 0): string {
  if (!Number.isFinite(rad)) return '--°';
  return `${Math.abs(radToDeg(rad)).toFixed(digits)}°`;
}

export function formatG(mps2: number, digits = 2): string {
  if (!Number.isFinite(mps2)) return '--';
  return (mps2 / 9.80665).toFixed(digits);
}
