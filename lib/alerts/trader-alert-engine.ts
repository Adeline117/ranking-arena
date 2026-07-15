export const TRADER_ALERT_METRICS = ['roi', 'pnl', 'score', 'rank', 'drawdown'] as const

export type TraderAlertMetric = (typeof TRADER_ALERT_METRICS)[number]

export interface TraderAlertMetricConfig {
  enabled: boolean
  threshold: number
}

export interface TraderAlertObservation {
  roi: number | null
  pnl: number | null
  score: number | null
  rank: number | null
  drawdown: number | null
}

export interface TraderAlertMetricState {
  baselineValue: number | null
  lastValue: number | null
  baselineVersion: number
}

export interface TraderAlertEvaluation {
  metric: TraderAlertMetric
  previousState: TraderAlertMetricState | null
  nextState: TraderAlertMetricState
  event: {
    oldValue: number
    newValue: number
    absoluteChange: number
    baselineVersion: number
    direction: 'up' | 'down'
  } | null
}

function normalizeValue(metric: TraderAlertMetric, value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return metric === 'drawdown' ? Math.abs(value) : value
}

/**
 * Evaluate one metric without I/O.
 *
 * Change metrics retain their baseline until the configured movement is reached,
 * so multiple small 30-minute changes accumulate. Drawdown is edge-triggered:
 * it fires only when moving from below the threshold to at/above it, then rearms
 * after recovery. Disabled metrics continuously rebase to avoid a stale alert
 * immediately after a user turns the metric back on.
 */
export function evaluateTraderAlertMetric(
  metric: TraderAlertMetric,
  config: TraderAlertMetricConfig,
  observation: number | null,
  state: TraderAlertMetricState | null
): TraderAlertEvaluation | null {
  const currentValue = normalizeValue(metric, observation)
  if (currentValue == null) return null

  const safeThreshold = Math.max(0, config.threshold)
  const safeVersion = Math.max(0, state?.baselineVersion ?? 0)

  if (!state || state.baselineValue == null || state.lastValue == null) {
    return {
      metric,
      previousState: state,
      nextState: {
        baselineValue: currentValue,
        lastValue: currentValue,
        baselineVersion: safeVersion,
      },
      event: null,
    }
  }

  if (!config.enabled) {
    return {
      metric,
      previousState: state,
      nextState: {
        baselineValue: currentValue,
        lastValue: currentValue,
        baselineVersion: safeVersion,
      },
      event: null,
    }
  }

  const oldValue = metric === 'drawdown' ? state.lastValue : state.baselineValue
  const absoluteChange = Math.abs(currentValue - oldValue)
  const crossedThreshold =
    metric === 'drawdown'
      ? state.lastValue < safeThreshold && currentValue >= safeThreshold
      : absoluteChange >= safeThreshold

  if (!crossedThreshold) {
    return {
      metric,
      previousState: state,
      nextState: {
        baselineValue: state.baselineValue,
        lastValue: currentValue,
        baselineVersion: safeVersion,
      },
      event: null,
    }
  }

  return {
    metric,
    previousState: state,
    nextState: {
      baselineValue: currentValue,
      lastValue: currentValue,
      baselineVersion: safeVersion + 1,
    },
    event: {
      oldValue,
      newValue: currentValue,
      absoluteChange,
      baselineVersion: safeVersion,
      direction: currentValue >= oldValue ? 'up' : 'down',
    },
  }
}

export function evaluateTraderAlert(
  configs: Record<TraderAlertMetric, TraderAlertMetricConfig>,
  observation: TraderAlertObservation,
  states: Partial<Record<TraderAlertMetric, TraderAlertMetricState>>
): TraderAlertEvaluation[] {
  return TRADER_ALERT_METRICS.flatMap((metric) => {
    const evaluation = evaluateTraderAlertMetric(
      metric,
      configs[metric],
      observation[metric],
      states[metric] ?? null
    )
    return evaluation ? [evaluation] : []
  })
}
