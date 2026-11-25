import { runTraderAlerts, SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION } from './run-trader-alerts'
import { hasFeatureAccess } from '@/lib/types/premium'

// Default: paywall on (PRO_FREE_PROMO=false) — only paid tiers have access.
jest.mock('@/lib/types/premium', () => ({
  hasFeatureAccess: jest.fn((tier: string) => tier === 'pro'),
}))
const mockedHasFeatureAccess = hasFeatureAccess as jest.MockedFunction<typeof hasFeatureAccess>

const mockLogInfo = jest.fn()
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

interface Call {
  table: string
  method: string
  args: unknown[]
}

function chain(result: unknown, table: string, calls: Call[]): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => void) => resolve(result)
        }
        return (...args: unknown[]) => {
          calls.push({ table, method: String(property), args })
          return proxy
        }
      },
    }
  )
  return proxy
}

function clientWith(
  results: Record<string, unknown[]>,
  rpcResult: unknown = { data: true, error: null }
) {
  const calls: Call[] = []
  const rpc = jest.fn().mockResolvedValue(rpcResult)
  const client = {
    from: jest.fn((table: string) => {
      const result = results[table]?.shift()
      if (result === undefined) throw new Error(`Unexpected query for ${table}`)
      return chain(result, table, calls)
    }),
    rpc,
  }
  return { client, calls, rpc }
}

const alert = {
  id: 'alert-1',
  user_id: 'user-1',
  trader_id: 'trader-1',
  source: 'binance_futures',
  alert_roi_change: true,
  roi_change_threshold: 10,
  alert_drawdown: false,
  drawdown_threshold: 20,
  alert_pnl_change: false,
  pnl_change_threshold: 5_000,
  alert_score_change: false,
  score_change_threshold: 5,
  alert_rank_change: false,
  rank_change_threshold: 5,
  one_time: false,
}

const observation = {
  season_id: '90D',
  source_trader_id: 'trader-1',
  source: 'binance_futures',
  roi: 25,
  pnl: 2_000,
  win_rate: 55,
  max_drawdown: 12,
  arena_score: 80,
  rank: 15,
  score_completeness: 'full',
  metrics_estimated: false,
  is_outlier: false,
  computed_at: '2026-07-15T05:00:00.000Z',
}

const delivery = {
  id: 'delivery-1',
  alert_id: 'alert-1',
  user_id: 'user-1',
  metric: 'roi',
  baseline_version: SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION,
  old_value: 10,
  new_value: 25,
  absolute_change: 15,
  notification_type: 'trader_alert_roi',
  title: 'ROI change',
  message: 'ROI changed',
  link: '/trader/trader-1?platform=binance_futures',
  status: 'pending',
  attempt_count: 0,
  last_error: null,
  delivered_at: null,
  created_at: '2026-07-15T00:00:00.000Z',
  updated_at: '2026-07-15T00:00:00.000Z',
}

describe('runTraderAlerts', () => {
  const now = new Date('2026-07-15T05:00:00.000Z')

  beforeEach(() => mockLogInfo.mockClear())

  it('does not evaluate or deliver alerts for users without an active paid subscription', async () => {
    const { client, calls } = clientWith({
      trader_alerts: [{ data: [alert], error: null }],
      subscriptions: [{ data: [], error: null }],
      user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
    })

    const result = await runTraderAlerts(client as never, now)

    expect(result).toMatchObject({
      alertsConfigured: 1,
      alertsChecked: 0,
      alertsSkippedNoSubscription: 1,
      alertsSent: 0,
    })
    expect(client.from).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'subscriptions',
          method: 'in',
          args: ['status', ['active', 'trialing']],
        }),
        expect.objectContaining({
          table: 'subscriptions',
          method: 'in',
          args: ['tier', ['pro', 'lifetime']],
        }),
      ])
    )
  })

  it('does not skip unpaid users while the Pro free promo unlocks trader alerts', async () => {
    mockedHasFeatureAccess.mockImplementation(() => true)
    try {
      const { client } = clientWith({
        trader_alerts: [{ data: [alert], error: null }],
        subscriptions: [{ data: [], error: null }],
        user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
      })
      // The run proceeds past the entitlement filter to the ranking read.
      await expect(runTraderAlerts(client as never, now)).rejects.toThrow(
        'Unexpected query for public_ranked_leaderboard'
      )
    } finally {
      mockedHasFeatureAccess.mockImplementation((tier) => tier === 'pro')
    }
  })

  it('does not notify a paid account while deletion is pending', async () => {
    const { client, rpc } = clientWith({
      trader_alerts: [{ data: [alert], error: null }],
      subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
      user_profiles: [{ data: [], error: null }],
    })

    const result = await runTraderAlerts(client as never, now)

    expect(result).toMatchObject({
      alertsConfigured: 1,
      alertsChecked: 0,
      alertsSkippedNoSubscription: 1,
      alertsSent: 0,
    })
    expect(client.from).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('seeds every available metric on first observation without sending an alert', async () => {
    const { client, calls, rpc } = clientWith({
      trader_alerts: [{ data: [alert], error: null }],
      subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
      user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
      public_ranked_leaderboard: [{ data: [observation], error: null }],
      trader_alert_states: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      trader_alert_deliveries: [{ data: [], error: null }],
    })

    const result = await runTraderAlerts(client as never, now)

    expect(result).toMatchObject({ statesWritten: 5, alertsSent: 0, deliveryFailures: 0 })
    expect(rpc).not.toHaveBeenCalled()
    expect(client.from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(client.from).not.toHaveBeenCalledWith('leaderboard_ranks')
    const upsert = calls.find(
      (call) => call.table === 'trader_alert_states' && call.method === 'upsert'
    )
    expect(upsert?.args[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: 'roi',
          baseline_value: 25,
          baseline_version: SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION,
        }),
        expect.objectContaining({ metric: 'drawdown', baseline_value: 12 }),
      ])
    )
  })

  it('keeps duplicate trader ids source-scoped and skips ambiguous legacy alerts', async () => {
    const bybitAlert = {
      ...alert,
      id: 'alert-bybit',
      source: 'bybit',
    }
    const binanceAlert = {
      ...alert,
      id: 'alert-binance',
      source: 'binance_futures',
    }
    const legacyAlert = {
      ...alert,
      id: 'alert-legacy',
      source: null,
    }
    const { client, calls, rpc } = clientWith({
      trader_alerts: [{ data: [bybitAlert, binanceAlert, legacyAlert], error: null }],
      subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
      user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
      public_ranked_leaderboard: [
        {
          data: [
            { ...observation, source: 'bybit', roi: 11 },
            { ...observation, source: 'binance_futures', roi: 22 },
          ],
          error: null,
        },
      ],
      trader_alert_states: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      trader_alert_deliveries: [{ data: [], error: null }],
    })

    const result = await runTraderAlerts(client as never, now)

    expect(result).toMatchObject({
      alertsConfigured: 3,
      alertsChecked: 3,
      tradersChecked: 2,
      statesWritten: 10,
      alertsSent: 0,
    })
    expect(rpc).not.toHaveBeenCalled()
    const upsert = calls.find(
      (call) => call.table === 'trader_alert_states' && call.method === 'upsert'
    )
    expect(upsert?.args[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alert_id: 'alert-bybit',
          metric: 'roi',
          baseline_value: 11,
        }),
        expect.objectContaining({
          alert_id: 'alert-binance',
          metric: 'roi',
          baseline_value: 22,
        }),
      ])
    )
    expect(upsert?.args[0]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ alert_id: 'alert-legacy' })])
    )
  })

  it('keeps a source-less legacy alert inert even when one public row is currently visible', async () => {
    const legacyAlert = { ...alert, id: 'alert-legacy', source: null }
    const { client, calls, rpc } = clientWith({
      trader_alerts: [{ data: [legacyAlert], error: null }],
      subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
      user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
      public_ranked_leaderboard: [{ data: [observation], error: null }],
      trader_alert_states: [{ data: [], error: null }],
      trader_alert_deliveries: [{ data: [], error: null }],
    })

    const result = await runTraderAlerts(client as never, now)

    expect(result).toMatchObject({ alertsChecked: 1, tradersChecked: 0, statesWritten: 0 })
    expect(rpc).not.toHaveBeenCalled()
    expect(calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'trader_alert_states', method: 'upsert' }),
      ])
    )
  })

  it('does not write a baseline or delivery when the sealed cohort is partial', async () => {
    const { client, calls, rpc } = clientWith({
      trader_alerts: [{ data: [alert], error: null }],
      subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
      user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
      public_ranked_leaderboard: [
        { data: [{ ...observation, metrics_estimated: true }], error: null },
      ],
      trader_alert_states: [{ data: [], error: null }],
      trader_alert_deliveries: [{ data: [], error: null }],
    })

    const result = await runTraderAlerts(client as never, now)

    expect(result).toMatchObject({ statesWritten: 0, alertsSent: 0, deliveryFailures: 0 })
    expect(rpc).not.toHaveBeenCalled()
    expect(calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'trader_alert_states', method: 'upsert' }),
      ])
    )
  })

  it('re-seeds legacy raw baselines without calculating an alert from them', async () => {
    const { client, calls, rpc } = clientWith({
      trader_alerts: [{ data: [alert], error: null }],
      subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
      user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
      public_ranked_leaderboard: [{ data: [observation], error: null }],
      trader_alert_states: [
        {
          data: [
            {
              alert_id: 'alert-1',
              metric: 'roi',
              baseline_value: 10,
              last_value: 10,
              baseline_version: 0,
              observed_at: '2026-07-15T04:30:00.000Z',
              updated_at: '2026-07-15T04:30:00.000Z',
            },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      trader_alert_deliveries: [{ data: [], error: null }],
    })

    const result = await runTraderAlerts(client as never, now)

    expect(result).toMatchObject({ statesWritten: 5, alertsSent: 0, deliveryFailures: 0 })
    expect(rpc).not.toHaveBeenCalled()
    const upsert = calls.find(
      (call) => call.table === 'trader_alert_states' && call.method === 'upsert'
    )
    expect(upsert?.args[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: 'roi',
          baseline_value: 25,
          baseline_version: SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION,
        }),
      ])
    )
  })

  it('does not retry a legacy raw pending delivery', async () => {
    const disabledAlert = { ...alert, alert_roi_change: false }
    const { client, rpc } = clientWith({
      trader_alerts: [{ data: [disabledAlert], error: null }],
      subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
      user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
      public_ranked_leaderboard: [{ data: [observation], error: null }],
      trader_alert_states: [
        {
          data: [
            {
              alert_id: 'alert-1',
              metric: 'roi',
              baseline_value: 10,
              last_value: 10,
              baseline_version: SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION,
              observed_at: '2026-07-15T04:30:00.000Z',
              updated_at: '2026-07-15T04:30:00.000Z',
            },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      trader_alert_deliveries: [
        {
          data: [{ ...delivery, baseline_version: 0 }],
          error: null,
        },
      ],
    })

    const result = await runTraderAlerts(client as never, now)

    expect(result).toMatchObject({ alertsSent: 0, deliveryFailures: 0 })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reserves and atomically finalizes a threshold event', async () => {
    const { client, rpc } = clientWith({
      trader_alerts: [{ data: [alert], error: null }],
      subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
      user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
      public_ranked_leaderboard: [{ data: [observation], error: null }],
      trader_alert_states: [
        {
          data: [
            {
              alert_id: 'alert-1',
              metric: 'roi',
              baseline_value: 10,
              last_value: 10,
              baseline_version: SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION,
              observed_at: '2026-07-15T04:30:00.000Z',
              updated_at: '2026-07-15T04:30:00.000Z',
            },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      trader_alert_deliveries: [
        { data: [], error: null },
        { data: delivery, error: null },
      ],
    })

    const result = await runTraderAlerts(client as never, now)

    expect(result.alertsSent).toBe(1)
    expect(result.deliveredAlerts).toEqual([
      expect.objectContaining({ deliveryId: 'delivery-1', notificationType: 'trader_alert_roi' }),
    ])
    expect(rpc).toHaveBeenCalledWith('finalize_trader_alert_delivery', {
      p_delivery_id: 'delivery-1',
      p_last_value: 25,
      p_observed_at: now.toISOString(),
    })
  })

  it('retries a pending reservation once and does not reserve a second event in the same run', async () => {
    const { client, rpc } = clientWith({
      trader_alerts: [{ data: [alert], error: null }],
      subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
      user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
      public_ranked_leaderboard: [{ data: [observation], error: null }],
      trader_alert_states: [
        {
          data: [
            {
              alert_id: 'alert-1',
              metric: 'roi',
              baseline_value: 10,
              last_value: 10,
              baseline_version: SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION,
              observed_at: '2026-07-15T04:30:00.000Z',
              updated_at: '2026-07-15T04:30:00.000Z',
            },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      trader_alert_deliveries: [{ data: [delivery], error: null }],
    })

    const result = await runTraderAlerts(client as never, now)

    expect(result.alertsSent).toBe(1)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(client.from).toHaveBeenCalledWith('trader_alert_deliveries')
    expect(
      client.from.mock.calls.filter(([table]) => table === 'trader_alert_deliveries')
    ).toHaveLength(1)
  })

  describe('rows without max drawdown and idle-window rows', () => {
    const sealedState = (metric: string, value: number) => ({
      alert_id: 'alert-1',
      metric,
      baseline_value: value,
      last_value: value,
      baseline_version: SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION,
      observed_at: '2026-07-15T04:30:00.000Z',
      updated_at: '2026-07-15T04:30:00.000Z',
    })
    // Published without a max drawdown: score_completeness says so.
    const noDrawdownRow = {
      ...observation,
      max_drawdown: null,
      score_completeness: 'partial',
      idle_window: false,
    }
    // No ROI and no PnL in the period: placeholders, not performance.
    const idleRow = {
      ...observation,
      roi: 0,
      pnl: 0,
      win_rate: null,
      max_drawdown: null,
      arena_score: 0.01,
      rank: 8_000,
      score_completeness: 'minimal',
      idle_window: true,
    }
    const everyCondition = {
      ...alert,
      alert_drawdown: true,
      alert_pnl_change: true,
      alert_score_change: true,
      alert_rank_change: true,
    }

    it('skips only the drawdown condition when the trader publishes no max drawdown', async () => {
      const { client, calls, rpc } = clientWith({
        trader_alerts: [{ data: [everyCondition], error: null }],
        subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
        user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
        public_ranked_leaderboard: [{ data: [noDrawdownRow], error: null }],
        trader_alert_states: [
          { data: [sealedState('roi', 10), sealedState('drawdown', 12)], error: null },
          { data: null, error: null },
        ],
        trader_alert_deliveries: [
          { data: [], error: null },
          { data: delivery, error: null },
        ],
      })

      const result = await runTraderAlerts(client as never, now)

      // The ROI alert (10 -> 25, threshold 10) still fires.
      expect(result).toMatchObject({
        alertsSent: 1,
        tradersChecked: 1,
        drawdownConditionsSkippedNoDrawdown: 1,
        alertsSkippedIdleWindow: 0,
        // pnl, score, rank are seeded; drawdown is not touched.
        statesWritten: 3,
      })
      expect(rpc).toHaveBeenCalledTimes(1)
      const upsert = calls.find(
        (call) => call.table === 'trader_alert_states' && call.method === 'upsert'
      )
      expect((upsert?.args[0] as { metric: string }[]).map((row) => row.metric).sort()).toEqual([
        'pnl',
        'rank',
        'score',
      ])
      expect(mockLogInfo).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ drawdownConditionsSkippedNoDrawdown: 1 })
      )
    })

    it('does not count a missing drawdown when the owner never enabled that condition', async () => {
      const { client } = clientWith({
        trader_alerts: [{ data: [alert], error: null }],
        subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
        user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
        public_ranked_leaderboard: [{ data: [noDrawdownRow], error: null }],
        trader_alert_states: [
          { data: [], error: null },
          { data: null, error: null },
        ],
        trader_alert_deliveries: [{ data: [], error: null }],
      })

      const result = await runTraderAlerts(client as never, now)

      expect(result).toMatchObject({ statesWritten: 4, drawdownConditionsSkippedNoDrawdown: 0 })
      expect(mockLogInfo).not.toHaveBeenCalled()
    })

    it('still rejects a row whose drawdown is present but not a number', async () => {
      const { client, calls } = clientWith({
        trader_alerts: [{ data: [alert], error: null }],
        subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
        user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
        public_ranked_leaderboard: [
          { data: [{ ...observation, max_drawdown: '12' }], error: null },
        ],
        trader_alert_states: [{ data: [], error: null }],
        trader_alert_deliveries: [{ data: [], error: null }],
      })

      const result = await runTraderAlerts(client as never, now)

      expect(result).toMatchObject({ statesWritten: 0, tradersChecked: 0 })
      expect(calls).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: 'trader_alert_states', method: 'upsert' }),
        ])
      )
    })

    it('fires nothing and moves no baseline for an idle-window row', async () => {
      // Every stored baseline is far enough from the idle placeholders
      // (ROI 0, PnL 0, score 0.01, rank 8000) to cross its threshold.
      const { client, calls, rpc } = clientWith({
        trader_alerts: [{ data: [everyCondition], error: null }],
        subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
        user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
        public_ranked_leaderboard: [{ data: [idleRow], error: null }],
        trader_alert_states: [
          {
            data: [
              sealedState('roi', 25),
              sealedState('pnl', 20_000),
              sealedState('score', 80),
              sealedState('rank', 15),
            ],
            error: null,
          },
        ],
        trader_alert_deliveries: [{ data: [delivery], error: null }],
      })

      const result = await runTraderAlerts(client as never, now)

      expect(result).toMatchObject({
        alertsChecked: 1,
        tradersChecked: 0,
        statesWritten: 0,
        alertsSent: 0,
        deliveryFailures: 0,
        alertsSkippedIdleWindow: 1,
        drawdownConditionsSkippedNoDrawdown: 0,
      })
      expect(rpc).not.toHaveBeenCalled()
      expect(calls).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: 'trader_alert_states', method: 'upsert' }),
        ])
      )
      expect(mockLogInfo).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ alertsSkippedIdleWindow: 1 })
      )
    })

    it('reads idle_window from the public view', async () => {
      const { client, calls } = clientWith({
        trader_alerts: [{ data: [alert], error: null }],
        subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
        user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
        public_ranked_leaderboard: [{ data: [], error: null }],
        trader_alert_states: [{ data: [], error: null }],
        trader_alert_deliveries: [{ data: [], error: null }],
      })

      await runTraderAlerts(client as never, now)

      const select = calls.find(
        (call) => call.table === 'public_ranked_leaderboard' && call.method === 'select'
      )
      expect(String(select?.args[0]).split(',')).toContain('idle_window')
    })

    it('behaves exactly as before under the old rule (full rows, both flags false)', async () => {
      const run = async (rankingRow: Record<string, unknown>) => {
        const { client, calls, rpc } = clientWith({
          trader_alerts: [{ data: [everyCondition], error: null }],
          subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
          user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
          public_ranked_leaderboard: [{ data: [rankingRow], error: null }],
          trader_alert_states: [
            { data: [sealedState('roi', 10), sealedState('drawdown', 12)], error: null },
            { data: null, error: null },
          ],
          trader_alert_deliveries: [
            { data: [], error: null },
            { data: delivery, error: null },
          ],
        })
        const result = await runTraderAlerts(client as never, now)
        const upsert = calls.find(
          (call) => call.table === 'trader_alert_states' && call.method === 'upsert'
        )
        return { result, upsert: upsert?.args[0], rpcCalls: rpc.mock.calls }
      }

      // The row as the view served it before the flag columns existed, and the
      // same row with both flags false, must produce the same run.
      const before = await run(observation)
      const after = await run({ ...observation, idle_window: false, mdd_contradiction: false })

      expect(after).toEqual(before)
      // What the pre-change runner produced for this input: one ROI delivery,
      // and pnl / score / rank / drawdown all seeded or advanced.
      expect(before.result).toMatchObject({
        alertsSent: 1,
        tradersChecked: 1,
        statesWritten: 4,
        alertsSkippedIdleWindow: 0,
        drawdownConditionsSkippedNoDrawdown: 0,
      })
      expect((before.upsert as { metric: string }[]).map((row) => row.metric).sort()).toEqual([
        'drawdown',
        'pnl',
        'rank',
        'score',
      ])
      expect(mockLogInfo).not.toHaveBeenCalled()
    })
  })
})
