/**
 * The end-of-run verdict: may this run's numbers be shown as an achievement at all?
 *
 * This is where `Session.integrity` is assembled. It used to be assembled at the bottom of
 * `scoreSession`, which made the run's honesty a by-product of computing its points — so
 * the day the points went, the verdict would have gone with them, silently, and a run
 * recorded with the phone loose in a cup holder would have published its angles like any
 * other. The two are separate questions and they now live apart: the monitor watches, this
 * decides, and nothing here knows what a point is.
 *
 * WHAT IT IS FOR. A phone waved about in a parked car produces large slip angles, high yaw
 * rates and a perfectly well-formed run. Everything downstream of the estimator believes
 * it, because nothing downstream of the estimator can tell. The integrity monitor can — it
 * watches the mount for movement, the accelerations for physical impossibility and the GPS
 * for coverage — and this turns its per-sample suspicion into one answer a screen can act
 * on.
 *
 * THE RULE. The monitor marks each sample believed or not. Sum the unbelieved seconds
 * inside slides, divide by all the observed slide seconds, and compare against one
 * threshold. Past it, nothing from the run may be presented as a result: `trusted` is
 * false, `message` says why in the driver's words, and a consumer MUST show the message
 * instead of the figures.
 *
 * A run with no slides at all is trusted. There is nothing to doubt, and calling an empty
 * recording dishonest would put a warning on every drive to the petrol station.
 */
import type { SessionIntegrity } from '../types';
import type { IntegrityState } from './monitor';

/** What the monitor concluded about a whole run. A subset of `IntegrityState`, so it accepts one. */
export interface MonitorVerdict {
  mount: 'rigid' | 'suspect' | 'loose';
  physics: 'ok' | 'implausible';
  gps: 'good' | 'poor' | 'none';
  message: string;
}

export interface IntegrityInput {
  /**
   * Seconds inside each slide that the monitor refused to believe — `DriftStats.implausibleS`,
   * one entry per slide. A run with no slides passes an empty array and is trusted.
   */
  implausiblePerDrift: readonly number[];
  /**
   * Seconds of sliding the monitor DID believe, across the run.
   *
   * Believed seconds only, so that `believed + unbelieved` is the whole observed total and
   * the fraction below has a denominator that means something. Passing the observed total
   * here instead would double-count the suppressed part and quietly understate the doubt.
   */
  believedDriftS: number;
  /** The monitor's own end-of-run verdict, or null when no monitor ran. */
  monitor: MonitorVerdict | IntegrityState | null;
  /** Fraction of observed sliding that may be unbelieved before the run stops publishing. */
  maxImplausibleFraction: number;
}

/**
 * The two rounded fields round to different places, and that asymmetry is deliberate.
 *
 * `suppressedS` is seconds, and 10 ms is already finer than anything a driver can act on.
 * `implausibleDriftFraction` is a ratio the screens render as a percentage — the refusal
 * message says "37% of this run's sliding could not be trusted" — so it carries a third
 * decimal, which is one decimal place on the percentage. Rounding the two alike would look
 * tidier and would coarsen every stored fraction by a factor of ten.
 */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Turn the monitor's suspicion into the verdict a screen acts on.
 *
 * Defaults are deliberately optimistic where the monitor is SILENT (`rigid` / `ok` /
 * `good`) and deliberately pessimistic where it has SPOKEN. A session recorded before the
 * monitor existed has no verdict to report and should not wear a warning it never earned;
 * a session the monitor doubted must not have that doubt rounded away.
 */
export function sessionIntegrity(input: IntegrityInput): SessionIntegrity {
  const n = input.implausiblePerDrift.length;
  const suppressedS = input.implausiblePerDrift.reduce((a, s) => a + (Number.isFinite(s) ? s : 0), 0);
  const believedS = Number.isFinite(input.believedDriftS) ? Math.max(0, input.believedDriftS) : 0;
  const observedDriftS = believedS + suppressedS;
  const implausibleDriftFraction = observedDriftS > 0 ? suppressedS / observedDriftS : 0;
  const m = input.monitor;
  const trusted = implausibleDriftFraction <= input.maxImplausibleFraction;

  return {
    mount: m?.mount ?? 'rigid',
    physics: m?.physics ?? 'ok',
    gps: m?.gps ?? 'good',
    implausibleDriftFraction: round3(implausibleDriftFraction),
    suppressedS: round2(suppressedS),
    scoreTrusted: n === 0 || trusted,
    message: trusted
      ? ''
      : `${Math.round(implausibleDriftFraction * 100)}% of this run's sliding could not be trusted` +
        `${m?.message ? ` — ${m.message}` : ' — check the phone is rigidly mounted'}`,
  };
}
