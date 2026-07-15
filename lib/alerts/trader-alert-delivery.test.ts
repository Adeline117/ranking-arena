import { buildTraderAlertDelivery } from './trader-alert-delivery'

describe('trader alert delivery formatting', () => {
  it('uses a distinct notification type and account-specific link for every metric', () => {
    const cases = [
      ['roi', 'trader_alert_roi'],
      ['pnl', 'trader_alert_pnl'],
      ['score', 'trader_alert_score'],
      ['rank', 'trader_alert_rank'],
      ['drawdown', 'trader_alert_drawdown'],
    ] as const

    for (const [metric, notificationType] of cases) {
      expect(
        buildTraderAlertDelivery({
          metric,
          traderId: 'alpha/beta',
          source: 'binance futures',
          oldValue: 10,
          newValue: 20,
        })
      ).toMatchObject({
        notificationType,
        link: '/trader/alpha%2Fbeta?platform=binance%20futures',
      })
    }
  })

  it('describes lower rank numbers as an improvement', () => {
    const delivery = buildTraderAlertDelivery({
      metric: 'rank',
      traderId: 'alpha',
      source: 'bybit',
      oldValue: 25,
      newValue: 10,
    })

    expect(delivery.message).toContain('improved 15 places (#25 → #10)')
  })

  it('describes drawdown as a crossing rather than a recurring level alert', () => {
    const delivery = buildTraderAlertDelivery({
      metric: 'drawdown',
      traderId: 'alpha',
      source: 'okx',
      oldValue: 18,
      newValue: 22,
    })

    expect(delivery.title).toBe('Drawdown threshold crossed')
    expect(delivery.message).toContain('(18% → 22%)')
  })
})
