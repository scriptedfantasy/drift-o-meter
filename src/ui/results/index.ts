/**
 * Run review kit.
 *
 * Everything the review screen draws. It no longer exports a `./skia` directory at all: the one
 * Skia component in here was the grade reveal's particle burst, and the grade is gone. The
 * sparklines are SVG on purpose — see the note at the top of `Sparkline.tsx`.
 */
export { buildResultsModel } from './model';
export type { DriftRow, GpsQuality, IntegrityNote, NoteLevel, ResultsModel } from './model';
export { buildFixtureSession, fixtureQuery, resolveFixture, FIXTURES, DEFAULT_FIXTURE } from './fixture';
export type { FixtureSpec } from './fixture';
export { cornerLabel, cornerShape, cornerTag, cornerAt } from './corners';
export { sentencesFromPill } from './verdict';
export { mixColor } from './palette';
export { Sparkline } from './Sparkline';
export { BestDriftCard } from './BestDriftCard';
export { DriftList } from './DriftList';
export { IntegrityPanel } from './IntegrityPanel';
export { WhyUnscored } from './WhyUnscored';
export { SectionHead, Stat, Tag } from './parts';
export { useEnter } from './entrance';
export { resultsLayout, LANDSCAPE_MIN_WIDTH, RAIL_GAP, WORDMARK_ASPECT, WORDMARK_WIDTH } from './layout';
export type { ResultsLayout } from './layout';
export { faultStat, refusalFrom, type FaultStat, type Refusal } from './unscored';
