/**
 * 技术分析服务 - 基于 ta-math 库
 * 
 * 对交易员 ROI 时间序列计算技术指标
 */

import TA from 'ta-math'

export interface IndicatorResults {
  /** 时间戳数组 */
  timestamps: string[]
  /** RSI (相对强弱指标) */
  rsi: (number | null)[]
  /** MACD */
  macd: {
    line: (number | null)[]
    signal: (number | null)[]
    histogram: (number | null)[]
  }
  /** 布林带 */
  bollingerBands: {
    upper: (number | null)[]
    middle: (number | null)[]
    lower: (number | null)[]
  }
  /** 简单移动平均线 */
  sma: {
    sma7: (number | null)[]
    sma14: (number | null)[]
    sma30: (number | null)[]
  }
  /** 指数移动平均线 */
  ema: {
    ema7: (number | null)[]
    ema14: (number | null)[]
    ema30: (number | null)[]
  }
}

/**
 * 将 ta-math 输出数组中的 NaN/undefined 替换为 null
 */
function sanitize(arr: any[]): (number | null)[] {
  return arr.map(v => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : null)
}

/**
 * 计算 ROI 时间序列的技术指标
 * 
 * @param timestamps - ISO 时间字符串数组（升序）
 * @param roiValues - 对应的 ROI 数值数组
 * @returns 各项技术指标结果
 */
export function computeIndicators(
  timestamps: string[],
  roiValues: number[]
): IndicatorResults {
  if (roiValues.length < 2) {
    const empty = timestamps.map(() => null)
    return {
      timestamps,
      rsi: empty,
      macd: { line: empty, signal: empty, histogram: empty },
      bollingerBands: { upper: empty, middle: empty, lower: empty },
      sma: { sma7: empty, sma14: empty, sma30: empty },
      ema: { ema7: empty, ema14: empty, ema30: empty },
    }
  }

  // ta-math 静态方法直接操作数值数组
  const $close = roiValues

  const rsi = sanitize(TA.rsi($close, 14))
  const macd = TA.macd($close, 12, 26, 9)
  const bb = TA.bb($close, 20, 2)

  return {
    timestamps,
    rsi,
    macd: {
      line: sanitize(macd.line),
      signal: sanitize(macd.signal),
      histogram: sanitize(macd.hist),
    },
    bollingerBands: {
      upper: sanitize(bb.upper),
      middle: sanitize(bb.middle),
      lower: sanitize(bb.lower),
    },
    sma: {
      sma7: sanitize(TA.sma($close, 7)),
      sma14: sanitize(TA.sma($close, 14)),
      sma30: sanitize(TA.sma($close, 30)),
    },
    ema: {
      ema7: sanitize(TA.ema($close, 7)),
      ema14: sanitize(TA.ema($close, 14)),
      ema30: sanitize(TA.ema($close, 30)),
    },
  }
}
