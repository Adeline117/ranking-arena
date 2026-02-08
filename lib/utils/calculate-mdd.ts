import { moneyAdd } from '@/lib/utils/currency'

/**
 * Max Drawdown (MDD) 自行计算模块
 *
 * 从 equity curve 或 PnL 序列计算 peak-to-trough 最大回撤。
 * 当平台不提供 MDD 数据时，可用此函数从时间序列推算。
 */

export interface EquityCurvePoint {
  ts: string
  value: number
}

/**
 * 从 equity curve 计算最大回撤 (Max Drawdown)。
 *
 * 算法：遍历曲线，追踪历史峰值，计算每个点与峰值之间的回撤比例。
 * 返回最大回撤的百分比值（负数，如 -15.3 表示 15.3% 回撤）。
 *
 * @param equityCurve - 按时间排序的权益曲线 [{ts, value}, ...]
 * @returns 最大回撤百分比（如 -15.3），如果数据不足返回 null
 *
 * @example
 * ```ts
 * const curve = [
 *   { ts: '2024-01-01', value: 10000 },
 *   { ts: '2024-01-02', value: 12000 },  // peak
 *   { ts: '2024-01-03', value: 10200 },  // drawdown: -15%
 *   { ts: '2024-01-04', value: 11000 },
 * ]
 * calculateMaxDrawdown(curve) // => -15.0
 * ```
 */
export function calculateMaxDrawdown(
  equityCurve: EquityCurvePoint[],
): number | null {
  if (!equityCurve || equityCurve.length < 2) {
    return null
  }

  // Filter out invalid data points
  const valid = equityCurve.filter(
    (p) => p.value != null && isFinite(p.value) && p.value > 0,
  )

  if (valid.length < 2) {
    return null
  }

  let peak = valid[0].value
  let maxDrawdown = 0 // 0 means no drawdown yet

  for (let i = 1; i < valid.length; i++) {
    const currentValue = valid[i].value

    // Update peak
    if (currentValue > peak) {
      peak = currentValue
    }

    // Calculate drawdown from peak
    const drawdown = (currentValue - peak) / peak

    // Track worst drawdown (most negative)
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown
    }
  }

  // Return as percentage (e.g., -0.153 → -15.3)
  // Round to 1 decimal place
  return Math.round(maxDrawdown * 1000) / 10
}

/**
 * 从 daily PnL 序列构建 equity curve 并计算 MDD。
 *
 * @param dailyPnl - 每日 PnL 数组 [{ts, value}, ...]，value 为当日盈亏金额
 * @param initialEquity - 初始权益（默认 10000）
 * @returns 最大回撤百分比（负数），数据不足返回 null
 *
 * @example
 * ```ts
 * const pnl = [
 *   { ts: '2024-01-01', value: 500 },
 *   { ts: '2024-01-02', value: -1800 },
 *   { ts: '2024-01-03', value: 300 },
 * ]
 * calculateMaxDrawdownFromPnl(pnl, 10000)
 * // equity: [10000, 10500, 8700, 9000]
 * // MDD = (8700 - 10500) / 10500 = -17.1%
 * ```
 */
export function calculateMaxDrawdownFromPnl(
  dailyPnl: EquityCurvePoint[],
  initialEquity: number = 10000,
): number | null {
  if (!dailyPnl || dailyPnl.length < 1 || initialEquity <= 0) {
    return null
  }

  // Build equity curve from PnL
  const equityCurve: EquityCurvePoint[] = [
    { ts: 'initial', value: initialEquity },
  ]

  let cumulative = initialEquity
  for (const point of dailyPnl) {
    if (point.value == null || !isFinite(point.value)) continue
    cumulative = moneyAdd(cumulative, point.value)
    if (cumulative <= 0) {
      // Total loss — MDD is -100%
      return -100
    }
    equityCurve.push({ ts: point.ts, value: cumulative })
  }

  return calculateMaxDrawdown(equityCurve)
}
