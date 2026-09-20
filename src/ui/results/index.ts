/**
 * Results screen kit.
 *
 * Deliberately does NOT export anything under `./skia`: Skia components must be reached through
 * their `*View` wrappers so that, on web, CanvasKit is loaded before the module is evaluated
 * (see `src/ui/skia/GlowRingView.web.tsx`). `GradeReveal` already does that internally.
 */
export { buildResultsModel } from './model';
export type { ComponentRow, DriftRow, GpsQuality, IntegrityNote, NoteLevel, ResultsBase, ResultsModel, CalloutTally } from './model';
export { buildFixtureSession, fixtureQuery, resolveFixture, FIXTURES, DEFAULT_FIXTURE } from './fixture';
export type { FixtureSpec } from './fixture';
export { cornerLabel, cornerShape, cornerTag, cornerAt } from './corners';
export { verdictFor, componentRows, worstCorner, bestCorner, weightedHeldPeak, weightedJitter } from './verdict';
export { calloutColor, GRADE_SCALE, GRADE_WORDS, gradeWord, KIND_NAMES, scoreColor } from './palette';
export { GradeReveal, REVEAL_MODES } from './GradeReveal';
export type { RevealMode } from './GradeReveal';
export { GradeScale } from './GradeScale';
export { Odometer } from './Odometer';
export { Sparkline } from './Sparkline';
export { ComponentBars } from './ComponentBars';
export { BestDriftCard } from './BestDriftCard';
export { DriftList } from './DriftList';
export { LapTable } from './LapTable';
export { IntegrityPanel } from './IntegrityPanel';
export { CalloutReel } from './CalloutReel';
export { SectionHead, Stat, Tag } from './parts';
export { useEnter, useFill } from './entrance';
