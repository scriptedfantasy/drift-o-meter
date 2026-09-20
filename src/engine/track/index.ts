/**
 * Track & lap model: live lap detection, reference-lap centre-line, corners,
 * arc-length projection and cross-lap consistency. Pure TypeScript.
 */
export { TrackBuilder, DEFAULT_TRACK_OPTIONS } from './builder';
export type { TrackOptions, TrackTick } from './builder';
export { lapConsistency, DEFAULT_CONSISTENCY_OPTIONS } from './consistency';
export type { LapConsistency, CornerConsistency, CornerLapStat, ConsistencyOptions } from './consistency';
export { findCornersOnPath, cornerContainsS, DEFAULT_CORNER_OPTIONS } from './corners';
export type { CornerOptions } from './corners';
export { PathIndex } from './projector';
export type { Projection } from './projector';
export { resamplePolyline, closeLoop, curvatureProfile, smoothPolyline, polylineLength, segmentIntersection, wrapS, modS } from './geometry';
export type { Pt, RefPoint } from './geometry';
