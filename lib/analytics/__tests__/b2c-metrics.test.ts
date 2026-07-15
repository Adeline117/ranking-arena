import { parseB2CProductMetrics } from '../b2c-metrics'

const validMetrics = {
  window_days: 7,
  wau: 5,
  total_paying: 2,
  new_paying: 1,
  new_signups: 4,
  activation_eligible: 3,
  activated_7d: 2,
  funnel: { landing_view: 20, view_trader: 8 },
  event_collection_started_at: '2026-07-15T00:00:00Z',
  generated_at: '2026-07-15T01:00:00Z',
}

describe('parseB2CProductMetrics', () => {
  it('maps the database contract to the shared product shape', () => {
    expect(parseB2CProductMetrics(validMetrics)).toEqual({
      windowDays: 7,
      wau: 5,
      totalPaying: 2,
      newPaying: 1,
      newSignups: 4,
      activationEligible: 3,
      activated7d: 2,
      funnel: { landing_view: 20, view_trader: 8 },
      eventCollectionStartedAt: '2026-07-15T00:00:00Z',
      generatedAt: '2026-07-15T01:00:00Z',
    })
  })

  it('rejects a partial contract instead of turning missing facts into zero', () => {
    const { wau: _wau, ...partial } = validMetrics
    expect(parseB2CProductMetrics(partial)).toBeNull()
  })

  it('rejects negative and non-integer counts', () => {
    expect(parseB2CProductMetrics({ ...validMetrics, total_paying: -1 })).toBeNull()
    expect(parseB2CProductMetrics({ ...validMetrics, wau: 1.5 })).toBeNull()
  })

  it('accepts a null collection start before the first event arrives', () => {
    expect(
      parseB2CProductMetrics({
        ...validMetrics,
        event_collection_started_at: null,
        funnel: {},
      })?.eventCollectionStartedAt
    ).toBeNull()
  })
})
