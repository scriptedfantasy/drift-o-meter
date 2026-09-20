/**
 * |β| sparkline: the shape of one slide, drawn from the estimator's own samples.
 *
 * SVG rather than Skia on purpose — the drift list draws a dozen of these, and a dozen Skia
 * canvases on one scroll view is a bad trade. The reveal's particle work is where Skia earns it.
 */
import { memo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, Line, LinearGradient, Path, Stop, Circle as SvgCircle } from 'react-native-svg';

import { alpha, colors } from '../theme';

export interface SparklineProps {
  /** |β| in degrees, evenly spaced in time. */
  trace: number[];
  width: number;
  height: number;
  color?: string;
  /** Top of the y axis in degrees. Pass the same value for every row so they compare. */
  maxDeg?: number;
  /** Mark the spin threshold and draw the trace in red. */
  spun?: boolean;
  /** Dot the peak. */
  showPeak?: boolean;
  /** Dashed guide at 45° (EXTREME ANGLE). */
  showGuides?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const SPIN_DEG = 85;
const EXTREME_DEG = 45;

function niceMax(trace: number[], spun: boolean): number {
  const peak = trace.reduce((m, v) => Math.max(m, v), 0);
  const target = Math.max(peak * 1.12, spun ? SPIN_DEG * 1.1 : 30);
  return Math.ceil(target / 15) * 15;
}

export const Sparkline = memo(function Sparkline({
  trace,
  width,
  height,
  color = colors.ember,
  maxDeg,
  spun = false,
  showPeak = true,
  showGuides = true,
  style,
  testID,
}: SparklineProps) {
  const data = trace.length >= 2 ? trace : [0, 0];
  const top = maxDeg && maxDeg > 0 ? maxDeg : niceMax(data, spun);
  const pad = 1.5;
  const h = height - pad * 2;
  const stroke = spun ? colors.red : color;
  const x = (i: number) => (i / (data.length - 1)) * width;
  const y = (v: number) => pad + h - (Math.min(v, top) / top) * h;

  let d = '';
  let peakIdx = 0;
  for (let i = 0; i < data.length; i++) {
    d += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(data[i]).toFixed(1)}`;
    if (data[i] > data[peakIdx]) peakIdx = i;
  }
  const area = `${d}L${width.toFixed(1)},${(height - pad).toFixed(1)}L0,${(height - pad).toFixed(1)}Z`;
  const gradientId = `spark-${Math.round(width)}-${Math.round(height)}-${stroke.slice(1)}`;

  return (
    <View style={style} testID={testID}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={stroke} stopOpacity={0.42} />
            <Stop offset="1" stopColor={stroke} stopOpacity={0.02} />
          </LinearGradient>
        </Defs>
        {showGuides && top >= EXTREME_DEG ? (
          <Line x1={0} y1={y(EXTREME_DEG)} x2={width} y2={y(EXTREME_DEG)} stroke={alpha(colors.gold, 0.45)} strokeWidth={1} strokeDasharray="3 4" />
        ) : null}
        {spun ? <Line x1={0} y1={y(SPIN_DEG)} x2={width} y2={y(SPIN_DEG)} stroke={alpha(colors.red, 0.75)} strokeWidth={1} strokeDasharray="2 3" /> : null}
        <Line x1={0} y1={height - pad} x2={width} y2={height - pad} stroke={colors.line} strokeWidth={1} />
        <Path d={area} fill={`url(#${gradientId})`} />
        <Path d={d} fill="none" stroke={stroke} strokeWidth={height > 40 ? 2.4 : 1.8} strokeLinejoin="round" strokeLinecap="round" />
        {showPeak ? (
          <>
            <SvgCircle cx={x(peakIdx)} cy={y(data[peakIdx])} r={height > 40 ? 7 : 4.5} fill={alpha(stroke, 0.22)} />
            <SvgCircle cx={x(peakIdx)} cy={y(data[peakIdx])} r={height > 40 ? 3 : 2} fill={colors.text} />
          </>
        ) : null}
      </Svg>
    </View>
  );
});
