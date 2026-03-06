/**
 * Technical analysis indicators - native implementation
 * Replaces ta-math to eliminate 22 npm audit vulnerabilities
 */

export interface IndicatorResults {
  timestamps: string[]
  rsi: (number | null)[]
  macd: {
    line: (number | null)[]
    signal: (number | null)[]
    histogram: (number | null)[]
  }
  bollingerBands: {
    upper: (number | null)[]
    middle: (number | null)[]
    lower: (number | null)[]
  }
  sma: {
    sma7: (number | null)[]
    sma14: (number | null)[]
    sma30: (number | null)[]
  }
  ema: {
    ema7: (number | null)[]
    ema14: (number | null)[]
    ema30: (number | null)[]
  }
}

function sma(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = []
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null)
    } else {
      let sum = 0
      for (let j = i - period + 1; j <= i; j++) sum += data[j]
      result.push(sum / period)
    }
  }
  return result
}

function ema(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = []
  const k = 2 / (period + 1)
  let prev: number | null = null

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null)
    } else if (prev === null) {
      let sum = 0
      for (let j = i - period + 1; j <= i; j++) sum += data[j]
      prev = sum / period
      result.push(prev)
    } else {
      prev = data[i] * k + prev * (1 - k)
      result.push(prev)
    }
  }
  return result
}

function rsi(data: number[], period: number): (number | null)[] {
  if (data.length < period + 1) return data.map(() => null)

  const result: (number | null)[] = new Array(period).fill(null)
  let avgGain = 0
  let avgLoss = 0

  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1]
    if (diff > 0) avgGain += diff
    else avgLoss -= diff
  }
  avgGain /= period
  avgLoss /= period

  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  }

  return result
}

function macd(data: number[], fast: number, slow: number, signal: number) {
  const emaFast = ema(data, fast)
  const emaSlow = ema(data, slow)
  const macdLine: (number | null)[] = []

  for (let i = 0; i < data.length; i++) {
    const f = emaFast[i]
    const s = emaSlow[i]
    macdLine.push(f !== null && s !== null ? f - s : null)
  }

  const validMacd = macdLine.filter((v): v is number => v !== null)
  const signalLine = ema(validMacd, signal)

  const fullSignal: (number | null)[] = []
  const histogram: (number | null)[] = []
  let validIdx = 0
  for (let i = 0; i < data.length; i++) {
    if (macdLine[i] === null) {
      fullSignal.push(null)
      histogram.push(null)
    } else {
      const sig = signalLine[validIdx] ?? null
      fullSignal.push(sig)
      histogram.push(sig !== null ? macdLine[i]! - sig : null)
      validIdx++
    }
  }

  return { line: macdLine, signal: fullSignal, histogram }
}

function bollingerBands(data: number[], period: number, stdDev: number) {
  const middle = sma(data, period)
  const upper: (number | null)[] = []
  const lower: (number | null)[] = []

  for (let i = 0; i < data.length; i++) {
    const m = middle[i]
    if (m === null) {
      upper.push(null)
      lower.push(null)
    } else {
      let variance = 0
      for (let j = i - period + 1; j <= i; j++) {
        variance += (data[j] - m) ** 2
      }
      const sd = Math.sqrt(variance / period)
      upper.push(m + stdDev * sd)
      lower.push(m - stdDev * sd)
    }
  }

  return { upper, middle, lower }
}

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

  return {
    timestamps,
    rsi: rsi(roiValues, 14),
    macd: macd(roiValues, 12, 26, 9),
    bollingerBands: bollingerBands(roiValues, 20, 2),
    sma: {
      sma7: sma(roiValues, 7),
      sma14: sma(roiValues, 14),
      sma30: sma(roiValues, 30),
    },
    ema: {
      ema7: ema(roiValues, 7),
      ema14: ema(roiValues, 14),
      ema30: ema(roiValues, 30),
    },
  }
}
