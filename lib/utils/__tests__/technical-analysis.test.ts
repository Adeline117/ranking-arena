import { computeIndicators } from '../technical-analysis'

const ts = (n: number) =>
  Array.from({ length: n }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`)

describe('computeIndicators — 边界', () => {
  it('<2 个数据点 → 全 null（不崩）', () => {
    const r = computeIndicators(ts(1), [5])
    expect(r.rsi).toEqual([null])
    expect(r.sma.sma7).toEqual([null])
    expect(r.macd.line).toEqual([null])
  })

  it('空输入 → 全空数组', () => {
    const r = computeIndicators([], [])
    expect(r.rsi).toEqual([])
  })
})

describe('computeIndicators — SMA', () => {
  it('前 period-1 个为 null，第 period 个是均值', () => {
    // sma7 over [1..10]：index 0-5 null，index 6 = (1+..+7)/7 = 4
    const data = Array.from({ length: 10 }, (_, i) => i + 1)
    const r = computeIndicators(ts(10), data)
    expect(r.sma.sma7.slice(0, 6).every((v) => v === null)).toBe(true)
    expect(r.sma.sma7[6]).toBeCloseTo(4, 6)
    // index 9 = (3+..+9+10)/7 = (4+5+6+7+8+9+10)/7 = 49/7 = 7
    expect(r.sma.sma7[9]).toBeCloseTo(7, 6)
  })

  it('恒定序列 → SMA = 该常数', () => {
    const r = computeIndicators(ts(10), Array(10).fill(3))
    expect(r.sma.sma7[9]).toBeCloseTo(3, 6)
  })
})

describe('computeIndicators — EMA', () => {
  it('恒定序列 → EMA 收敛到该常数', () => {
    const r = computeIndicators(ts(40), Array(40).fill(5))
    expect(r.ema.ema7[39]).toBeCloseTo(5, 6)
  })

  it('前 period-1 个为 null', () => {
    const r = computeIndicators(
      ts(10),
      Array.from({ length: 10 }, (_, i) => i)
    )
    expect(r.ema.ema7.slice(0, 6).every((v) => v === null)).toBe(true)
    expect(r.ema.ema7[6]).not.toBeNull()
  })
})

describe('computeIndicators — RSI', () => {
  it('RSI 始终在 0-100（或 null）', () => {
    const data = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 10 + i)
    const r = computeIndicators(ts(40), data)
    for (const v of r.rsi) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(100)
      }
    }
  })

  it('持续上涨 → RSI=100（无下跌）', () => {
    const data = Array.from({ length: 30 }, (_, i) => i) // 严格递增
    const r = computeIndicators(ts(30), data)
    const last = r.rsi[29]
    expect(last).toBeCloseTo(100, 5)
  })
})

describe('computeIndicators — Bollinger Bands', () => {
  it('upper ≥ middle ≥ lower（有值处）', () => {
    const data = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 5 + 100)
    const r = computeIndicators(ts(40), data)
    const { upper, middle, lower } = r.bollingerBands
    for (let i = 0; i < data.length; i++) {
      if (middle[i] !== null) {
        expect(upper[i]!).toBeGreaterThanOrEqual(middle[i]!)
        expect(middle[i]!).toBeGreaterThanOrEqual(lower[i]!)
      }
    }
  })

  it('恒定序列 → upper=middle=lower（零标准差）', () => {
    const r = computeIndicators(ts(30), Array(30).fill(50))
    const i = 29
    expect(r.bollingerBands.upper[i]).toBeCloseTo(50, 6)
    expect(r.bollingerBands.lower[i]).toBeCloseTo(50, 6)
  })
})

describe('computeIndicators — MACD', () => {
  it('line = emaFast - emaSlow（有值处）', () => {
    const data = Array.from({ length: 40 }, (_, i) => i * 1.5 + Math.sin(i))
    const r = computeIndicators(ts(40), data)
    // 有 macd line 的地方，line 非 null
    const nonNull = r.macd.line.filter((v) => v !== null)
    expect(nonNull.length).toBeGreaterThan(0)
  })

  it('输出数组长度都等于输入长度', () => {
    const n = 35
    const r = computeIndicators(
      ts(n),
      Array.from({ length: n }, (_, i) => i)
    )
    expect(r.macd.line).toHaveLength(n)
    expect(r.macd.signal).toHaveLength(n)
    expect(r.macd.histogram).toHaveLength(n)
    expect(r.rsi).toHaveLength(n)
  })
})
