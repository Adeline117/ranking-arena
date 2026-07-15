import type { TraderAlertMetric } from './trader-alert-engine'

export interface TraderAlertDeliveryPayload {
  notificationType:
    | 'trader_alert_roi'
    | 'trader_alert_pnl'
    | 'trader_alert_score'
    | 'trader_alert_rank'
    | 'trader_alert_drawdown'
  logType: 'roi_change' | 'pnl_change' | 'score_change' | 'rank_change' | 'drawdown'
  title: string
  message: string
  link: string
}

function formatNumber(value: number, maximumFractionDigits = 2): string {
  return value.toLocaleString('en-US', { maximumFractionDigits })
}

function movement(value: number): 'increased' | 'decreased' {
  return value >= 0 ? 'increased' : 'decreased'
}

export function buildTraderAlertDelivery(input: {
  metric: TraderAlertMetric
  traderId: string
  source: string
  oldValue: number
  newValue: number
}): TraderAlertDeliveryPayload {
  const { metric, traderId, source, oldValue, newValue } = input
  const delta = newValue - oldValue
  const link = `/trader/${encodeURIComponent(traderId)}?platform=${encodeURIComponent(source)}`

  switch (metric) {
    case 'roi':
      return {
        notificationType: 'trader_alert_roi',
        logType: 'roi_change',
        title: 'ROI change',
        message: `${traderId} ROI ${movement(delta)} by ${formatNumber(Math.abs(delta))} points (${formatNumber(oldValue)}% → ${formatNumber(newValue)}%)`,
        link,
      }
    case 'pnl':
      return {
        notificationType: 'trader_alert_pnl',
        logType: 'pnl_change',
        title: 'PnL change',
        message: `${traderId} PnL ${movement(delta)} by $${formatNumber(Math.abs(delta), 0)} ($${formatNumber(oldValue, 0)} → $${formatNumber(newValue, 0)})`,
        link,
      }
    case 'score':
      return {
        notificationType: 'trader_alert_score',
        logType: 'score_change',
        title: 'Arena Score change',
        message: `${traderId} Arena Score ${movement(delta)} by ${formatNumber(Math.abs(delta), 1)} points (${formatNumber(oldValue, 1)} → ${formatNumber(newValue, 1)})`,
        link,
      }
    case 'rank': {
      const improved = newValue < oldValue
      return {
        notificationType: 'trader_alert_rank',
        logType: 'rank_change',
        title: 'Ranking change',
        message: `${traderId} ranking ${improved ? 'improved' : 'dropped'} ${formatNumber(Math.abs(delta), 0)} places (#${formatNumber(oldValue, 0)} → #${formatNumber(newValue, 0)})`,
        link,
      }
    }
    case 'drawdown':
      return {
        notificationType: 'trader_alert_drawdown',
        logType: 'drawdown',
        title: 'Drawdown threshold crossed',
        message: `${traderId} max drawdown crossed your threshold (${formatNumber(oldValue)}% → ${formatNumber(newValue)}%)`,
        link,
      }
  }
}
