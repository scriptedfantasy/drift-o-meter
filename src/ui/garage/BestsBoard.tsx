/**
 * BIGGEST ANGLE: one row per driver, in order.
 *
 * It was four record tiles per track — best grade, most points, biggest angle, longest chain —
 * and the panel took its colour from the grade, so the board's whole accent was an opinion
 * about a letter. What several people sharing one car actually argue about is one number, so
 * that is the board: rank, who, how far sideways they got, and how long they kept it there.
 *
 * Every row is a link to the run that holds the angle, because a record with no run behind it
 * is a claim rather than a fact. A driver with nothing the engine vouched for keeps their row
 * and shows a dash — they have been out, and a board that drops them looks like it lost their
 * runs — and the unassigned bucket is a row like any other. It is listed, never hidden.
 *
 * The angle takes its colour from `angleColor`, the ramp the dial and the results screen also
 * read, so 61° is the same colour wherever it appears and a row up in the red zone reads as
 * the limit rather than as a high score.
 */
import { Pressable, StyleSheet, View } from 'react-native';

import { formatDuration } from '../format';
import { AppText, Micro } from '../Text';
import { angleColor, colors, radii, space } from '../theme';
import type { DriverStanding } from './bests';
import { driverHandle } from './driverCopy';
import { holdText } from './labels';

export interface BestsBoardProps {
  standings: readonly DriverStanding[];
  /** Who is at the wheel. Their row is outlined, the rest are hairlined. */
  activeId?: string | null;
  /** Landscape or a tablet: the rows sit two abreast instead of stacking. */
  wide?: boolean;
  onOpen(standing: DriverStanding): void;
}

export function BestsBoard({ standings, activeId = null, wide = false, onOpen }: BestsBoardProps) {
  return (
    <View style={[styles.board, wide && styles.boardWide]}>
      {standings.map((s) => (
        <BoardRow key={s.driverId ?? 'unassigned'} standing={s} active={s.driverId !== null && s.driverId === activeId} wide={wide} onOpen={onOpen} />
      ))}
      <Micro numberOfLines={2} style={styles.footnote}>
        Only runs the engine vouched for can take a place — and the angle is one you held and drove out of, not one you
        spun into
      </Micro>
    </View>
  );
}

function BoardRow({ standing, active, wide, onOpen }: { standing: DriverStanding; active: boolean; wide: boolean; onOpen(s: DriverStanding): void }) {
  const { empty, peakDeg } = standing;
  const angle = empty ? '--' : `${Math.round(peakDeg)}°`;
  const slide = empty ? '--' : holdText(standing.slideS);
  return (
    <Pressable
      disabled={empty}
      onPress={() => onOpen(standing)}
      accessibilityRole="button"
      accessibilityLabel={
        empty
          ? `${standing.name}, ${standing.runs === 1 ? '1 run' : `${standing.runs} runs`}, nothing judged yet`
          : `${standing.name}, place ${standing.rank}, biggest angle ${angle}, in a ${slide} slide`
      }
      testID={`board-${driverHandle(standing.driverId ? { id: standing.driverId, name: standing.name } : null)}`}
      style={({ pressed }) => [
        styles.row,
        wide && styles.rowWide,
        { borderColor: active ? colors.text : colors.line },
        pressed && styles.pressed,
      ]}>
      <Micro numberOfLines={1} style={styles.rank}>
        {standing.rank > 0 ? String(standing.rank) : '--'}
      </Micro>
      <View style={styles.who}>
        <AppText variant="subheading" numberOfLines={1} color={empty ? colors.muted : colors.text} style={styles.name}>
          {standing.name}
        </AppText>
        <Micro numberOfLines={1}>
          {standing.runs === 1 ? '1 run' : `${standing.runs} runs`}
          {standing.scored < standing.runs ? ` · ${standing.runs - standing.scored} not judged` : ''}
        </Micro>
      </View>
      <View style={styles.figure}>
        <AppText variant="display" numeric numberOfLines={1} color={empty ? colors.muted : angleColor(peakDeg)} style={styles.angle}>
          {angle}
        </AppText>
        <Micro numberOfLines={1}>{empty ? 'no angle yet' : `${slide} slide`}</Micro>
      </View>
      <View style={styles.sideways}>
        <AppText variant="subheading" numeric numberOfLines={1} color={colors.blue} style={styles.sidewaysValue}>
          {standing.sidewaysS > 0 ? formatDuration(standing.sidewaysS) : '--'}
        </AppText>
        <Micro numberOfLines={1}>Sideways</Micro>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  board: { gap: space[2] },
  boardWide: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    // 44 dp is the floor for anything reached for at arm's length; a board row is also the
    // way into the run that holds the record, so it is a real target and not a table cell.
    minHeight: 56,
    backgroundColor: colors.bg1,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: space[2],
    paddingHorizontal: space[3],
  },
  rowWide: { flexBasis: '48.5%', flexGrow: 1, minWidth: 300 },
  rank: { width: 16 },
  who: { flex: 1, minWidth: 0, gap: 1 },
  name: { letterSpacing: 0.8 },
  figure: { alignItems: 'flex-end', minWidth: 0 },
  angle: { fontSize: 28, lineHeight: 28, letterSpacing: -1 },
  sideways: { alignItems: 'flex-end', width: 62 },
  sidewaysValue: { fontSize: 18, lineHeight: 22, letterSpacing: 0 },
  footnote: { textTransform: 'none', letterSpacing: 0.2, opacity: 0.75, maxWidth: 420, marginTop: space[1] },
  pressed: { opacity: 0.7 },
});
