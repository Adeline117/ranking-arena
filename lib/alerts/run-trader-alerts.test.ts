import { runTraderAlerts } from './run-trader-alerts'

interface Call {
  table: string
  method: string
  args: unknown[]
}

function chain(result: unknown, table: string, calls: Call[]): unknown {
  let proxy: unknown
  proxy = new Proxy(
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
  source_trader_id: 'trader-1',
  source: 'binance_futures',
  roi: 25,
  pnl: 2_000,
  max_drawdown: -12,
  arena_score: 80,
  rank: 15,
}

const delivery = {
  id: 'delivery-1',
  alert_id: 'alert-1',
  user_id: 'user-1',
  metric: 'roi',
  baseline_version: 0,
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
      leaderboard_ranks: [{ data: [observation], error: null }],
      trader_alert_states: [
        { data: [], error: null },
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
        expect.objectContaining({ metric: 'roi', baseline_value: 25, baseline_version: 0 }),
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
      source: 'binance',
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
      leaderboard_ranks: [
        {
          data: [
            { ...observation, source: 'bybit', roi: 11 },
            { ...observation, source: 'binance', roi: 22 },
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

  it('reserves and atomically finalizes a threshold event', async () => {
    const { client, rpc } = clientWith({
      trader_alerts: [{ data: [alert], error: null }],
      subscriptions: [{ data: [{ user_id: 'user-1' }], error: null }],
      user_profiles: [{ data: [{ id: 'user-1' }], error: null }],
      leaderboard_ranks: [{ data: [observation], error: null }],
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
      leaderboard_ranks: [{ data: [observation], error: null }],
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
})
