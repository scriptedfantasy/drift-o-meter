/** The calibration screen's small pieces: the three lights, the two steps, banners, readout. */
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText, Micro, Small } from '../Text';
import { alpha, colors, radii, space } from '../theme';
import type { Caution, Light, Step } from './model';

/**
 * Four tiers, because the engine reaches four states and the lights are read at arm's length.
 * `warn` (gold) is the one that was missing: `suspect` is a verdict the monitor HAS delivered,
 * and it shared cyan with `unknown` — "still listening" — while the headline two rows above
 * painted the same state gold. A light that cannot tell a verdict from an absence is not doing
 * the one job it has.
 */
const LIGHT_COLORS = { on: colors.green, working: colors.cyan, warn: colors.gold, bad: colors.red } as const;

/**
 * Three states the driver can check at a glance: vertical, forward, mount. `compact` puts each
 * on one line, for landscape, where 393 px of height has to hold the instructions as well.
 */
export function Lights({ lights, compact = false, style }: { lights: readonly Light[]; compact?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.lights, style]} testID="calibrate-lights">
      {lights.map((l) => {
        const color = LIGHT_COLORS[l.state];
        return (
          <View
            key={l.key}
            style={[styles.light, compact && styles.lightCompact, { borderColor: alpha(color, l.state === 'on' || l.state === 'warn' ? 0.75 : 0.4) }]}
            testID={`light-${l.key}`}>
            <View style={styles.lightHead}>
              <View style={[styles.dot, { backgroundColor: color, opacity: l.state === 'working' ? 0.55 : 1 }]} />
              <Micro color={color} numberOfLines={1}>
                {l.label}
              </Micro>
            </View>
            <AppText
              variant="bodyStrong"
              color={l.state === 'working' ? colors.muted : colors.text}
              numberOfLines={compact ? 1 : 2}
              style={[styles.lightDetail, compact && styles.lightDetailCompact]}>
              {l.detail}
            </AppText>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The two things a driver actually has to do, with the reason in one clause.
 *
 * A step that is neither done nor doable yet keeps its title and loses its reason: the driver
 * cannot act on it, and those two lines were part of what pushed the call to action off the
 * bottom of the frame on the commonest route into this screen (`?why=rejected`).
 *
 * `compact` extends that rule to a DONE step. 393 px of landscape has to carry the instrument,
 * the verdict, a caution banner, the three lights and the way out before it gets here, and a
 * reason for something the driver has already done is the 38 px that decides whether the last
 * step clears the fold. The reason on the step they CAN act on keeps both its lines: capping it
 * to one turned "nothing else can fix the axis" into "nothing else can fix th…", and an
 * ellipsis mid-clause is worse than a row that ends at the fold.
 */
export function Steps({ steps, compact = false, style }: { steps: readonly Step[]; compact?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.steps, style]} testID="calibrate-steps">
      {steps.map((s, i) => {
        const done = s.state === 'done';
        const active = s.state === 'active';
        const color = done ? colors.green : active ? colors.ember : colors.muted;
        return (
          <View key={s.n} style={[styles.step, compact && styles.stepCompact, i > 0 && styles.stepBorder]} testID={`step-${s.n}`}>
            <View style={styles.stepMark}>
              <AppText variant="heading" color={color} style={styles.stepNo}>
                {done ? '✓' : s.n}
              </AppText>
            </View>
            <View style={styles.stepText}>
              <AppText variant="bodyStrong" color={done ? colors.muted : colors.text} style={done ? styles.stepDone : undefined}>
                {s.title}
              </AppText>
              {s.state === 'todo' || (compact && done) ? null : <Small numberOfLines={2}>{s.because}</Small>}
              {active && s.progress > 0.02 && s.progress < 1 ? (
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.round(s.progress * 100)}%` }]} />
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** The loud state. Wording comes in from outside; this only decides how hard it shouts. */
export function Banner({ title, body, tone, testID }: { title: string; body: string; tone: 'red' | 'gold'; testID?: string }) {
  const color = tone === 'red' ? colors.red : colors.gold;
  return (
    <View style={[styles.banner, { borderColor: alpha(color, 0.85), backgroundColor: alpha(color, 0.14) }]} testID={testID}>
      <View style={[styles.bannerBar, { backgroundColor: color }]} />
      <View style={styles.bannerText}>
        <AppText variant="subheading" color={color} numberOfLines={2} style={styles.bannerTitle}>
          {title}
        </AppText>
        {body ? (
          <Small color={colors.text} numberOfLines={4}>
            {body}
          </Small>
        ) : null}
      </View>
    </View>
  );
}

export function Cautions({ cautions }: { cautions: readonly Caution[] }) {
  if (cautions.length === 0) return null;
  return (
    <View style={styles.cautions} testID="calibrate-cautions">
      {cautions.map((c) => (
        <Banner key={c.title} title={c.title} body={c.body} tone={c.tone} testID={`caution-${c.tone}`} />
      ))}
    </View>
  );
}

/**
 * What the engine sees, for anyone who wants to check the app's working.
 *
 * A fixed four-up grid, not content-width cells: `STRAIGHT-LINE` was wide enough to push the
 * eight values onto three rows, and the third row sat below the fold on the route the README
 * calls the normal way into this screen.
 */
export function EngineStrip({ rows, testID }: { rows: Array<[string, string]>; testID?: string }) {
  return (
    <View style={styles.strip} testID={testID}>
      {rows.map(([k, v]) => (
        <View key={k} style={styles.stripCell}>
          <Micro numberOfLines={1}>{k}</Micro>
          <AppText variant="bodyStrong" color="muted" numeric numberOfLines={1} style={styles.stripValue}>
            {v}
          </AppText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  lights: { flexDirection: 'row', gap: space[2] },
  light: { flex: 1, borderWidth: 1, borderRadius: radii.md, backgroundColor: colors.bg1, paddingHorizontal: space[3], paddingVertical: space[2], gap: 2, minWidth: 0 },
  lightCompact: { paddingVertical: space[1], paddingHorizontal: space[2] },
  lightHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  lightDetail: { fontSize: 14, lineHeight: 17 },
  lightDetailCompact: { fontSize: 13, lineHeight: 16 },

  steps: { backgroundColor: colors.bg1, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space[4] },
  step: { flexDirection: 'row', gap: space[3], paddingVertical: 10 },
  // 2 pt, not 4: the last 7 px of the two-step list on a landscape caution frame. Measured.
  stepCompact: { paddingVertical: 2 },
  stepBorder: { borderTopWidth: 1, borderTopColor: colors.line },
  stepMark: { width: 32, alignItems: 'center' },
  stepNo: { fontStyle: 'italic', fontSize: 24, lineHeight: 26 },
  stepText: { flex: 1, gap: 3 },
  stepDone: { textDecorationLine: 'line-through' },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: colors.bg2, overflow: 'hidden', marginTop: space[1] },
  progressFill: { height: '100%', backgroundColor: colors.ember, borderRadius: 2 },

  banner: { flexDirection: 'row', alignItems: 'center', gap: space[3], borderWidth: 1, borderRadius: radii.md, paddingHorizontal: space[3], paddingVertical: space[2] },
  bannerBar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  bannerText: { flex: 1, gap: 2 },
  bannerTitle: { fontSize: 18, lineHeight: 21 },
  cautions: { gap: space[2] },

  strip: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space[2], columnGap: space[2], borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space[2] },
  stripCell: { width: '23%', minWidth: 0, gap: 0 },
  stripValue: { fontSize: 14, lineHeight: 17 },
});
