import {
  evaluateTraderAlert,
  evaluateTraderAlertMetric,
  type TraderAlertMetricConfig,
  type TraderAlertMetricState,
} from './trader-alert-engine'

const enabled = (threshold: number): TraderAlertMetricConfig => ({ enabled: true, threshold })
const state = (
  baselineValue: number,
  lastValue = baselineValue,
  baselineVersion = 0
): TraderAlertMetricState => ({ baselineValue, lastValue, baselineVersion })

describe('trader alert engine', () => {
  it('seeds the first observation without notifying', () => {
    const result = evaluateTraderAlertMetric('roi', enabled(10), 42, null)

    expect(result).toMatchObject({
      event: null,
      nextState: { baselineValue: 42, lastValue: 42, baselineVersion: 0 },
    })
  })

  it('accumulates small changes against the last delivered baseline', () => {
    const first = evaluateTraderAlertMetric('roi', enabled(10), 106, state(100))
    expect(first?.event).toBeNull()
    expect(first?.nextState).toEqual(state(100, 106))

    const second = evaluateTraderAlertMetric('roi', enabled(10), 111, first!.nextState)
    expect(second?.event).toMatchObject({
      oldValue: 100,
      newValue: 111,
      absoluteChange: 11,
      baselineVersion: 0,
      direction: 'up',
    })
    expect(second?.nextState).toEqual(state(111, 111, 1))
  })

  it('detects negative changes by absolute movement', () => {
    const result = evaluateTraderAlertMetric('score', enabled(5), 74, state(80, 78, 3))

    expect(result?.event).toMatchObject({
      oldValue: 80,
      newValue: 74,
      absoluteChange: 6,
      baselineVersion: 3,
      direction: 'down',
    })
    expect(result?.nextState.baselineVersion).toBe(4)
  })

  it('fires drawdown only on an upward threshold crossing and rearms after recovery', () => {
    const crossing = evaluateTraderAlertMetric('drawdown', enabled(20), -22, state(12, 18, 2))
    expect(crossing?.event).toMatchObject({ oldValue: 18, newValue: 22, baselineVersion: 2 })

    const stillAbove = evaluateTraderAlertMetric('drawdown', enabled(20), -25, crossing!.nextState)
    expect(stillAbove?.event).toBeNull()

    const recovered = evaluateTraderAlertMetric('drawdown', enabled(20), -15, stillAbove!.nextState)
    expect(recovered?.event).toBeNull()

    const crossedAgain = evaluateTraderAlertMetric(
      'drawdown',
      enabled(20),
      -21,
      recovered!.nextState
    )
    expect(crossedAgain?.event).not.toBeNull()
    expect(crossedAgain?.event?.baselineVersion).toBe(3)
  })

  it('rebases disabled metrics so re-enabling does not emit stale movement', () => {
    const disabled = evaluateTraderAlertMetric(
      'rank',
      { enabled: false, threshold: 5 },
      40,
      state(10, 10, 4)
    )
    expect(disabled?.nextState).toEqual(state(40, 40, 4))
    expect(disabled?.event).toBeNull()

    const reenabled = evaluateTraderAlertMetric('rank', enabled(5), 42, disabled!.nextState)
    expect(reenabled?.event).toBeNull()
  })

  it('ignores missing and non-finite observations without corrupting state', () => {
    expect(evaluateTraderAlertMetric('pnl', enabled(100), null, state(1_000))).toBeNull()
    expect(evaluateTraderAlertMetric('pnl', enabled(100), Number.NaN, state(1_000))).toBeNull()
  })

  it('evaluates all available metrics and preserves metric-specific semantics', () => {
    const results = evaluateTraderAlert(
      {
        roi: enabled(10),
        pnl: enabled(1_000),
        score: enabled(5),
        rank: enabled(5),
        drawdown: enabled(20),
      },
      { roi: 115, pnl: 5_500, score: null, rank: 7, drawdown: -25 },
      {
        roi: state(100),
        pnl: state(5_000),
        rank: state(15),
        drawdown: state(15, 21),
      }
    )

    expect(results.map((result) => result.metric)).toEqual(['roi', 'pnl', 'rank', 'drawdown'])
    expect(results.filter((result) => result.event).map((result) => result.metric)).toEqual([
      'roi',
      'rank',
    ])
  })
})
