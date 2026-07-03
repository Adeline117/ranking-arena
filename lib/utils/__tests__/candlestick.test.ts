import { convertTimeframe, standardizeCandles, TIMEFRAME_SECONDS } from '../candlestick'

type OHLCV = [number, number, number, number, number, number]

describe('standardizeCandles', () => {
  it('ccxt 元组 → 对象映射', () => {
    const raw: OHLCV[] = [[1000, 10, 15, 8, 12, 100]]
    expect(standardizeCandles(raw)).toEqual([
      { time: 1000, open: 10, high: 15, low: 8, close: 12, volume: 100 },
    ])
  })

  it('空输入 → 空数组', () => {
    expect(standardizeCandles([])).toEqual([])
  })
})

describe('convertTimeframe', () => {
  it('相同周期 → 透传（对象化）', () => {
    const c: OHLCV[] = [[60000, 1, 2, 0.5, 1.5, 10]]
    const out = convertTimeframe(c, '1m', '1m')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ open: 1, close: 1.5 })
  })

  it('转到更小周期 → 抛错', () => {
    expect(() => convertTimeframe([], '1h', '1m')).toThrow(/smaller timeframe/)
  })

  it('5 根 1m 聚合成 1 根 5m：open=首、close=尾、high=max、low=min、volume=sum', () => {
    // 5 根连续 1m（时间戳按毫秒，间隔 60000）
    const base = 1_700_000_000_000
    const candles: OHLCV[] = [
      [base + 0 * 60000, 100, 110, 95, 105, 10],
      [base + 1 * 60000, 105, 120, 100, 115, 20],
      [base + 2 * 60000, 115, 118, 90, 92, 15],
      [base + 3 * 60000, 92, 130, 91, 125, 25],
      [base + 4 * 60000, 125, 128, 120, 122, 30],
    ]
    const out = convertTimeframe(candles, '1m', '5m')
    expect(out).toHaveLength(1)
    const bar = out[0]
    expect(bar.open).toBe(100) // 首根 open
    expect(bar.close).toBe(122) // 尾根 close
    expect(bar.high).toBe(130) // 全局 max high
    expect(bar.low).toBe(90) // 全局 min low
    expect(bar.volume).toBe(100) // 10+20+15+25+30
  })
})

describe('TIMEFRAME_SECONDS', () => {
  it('周期秒数正确且严格递增', () => {
    expect(TIMEFRAME_SECONDS['1m']).toBe(60)
    expect(TIMEFRAME_SECONDS['1h']).toBe(3600)
    expect(TIMEFRAME_SECONDS['1d']).toBe(86400)
    const order: (keyof typeof TIMEFRAME_SECONDS)[] = ['1m', '5m', '15m', '1h', '4h', '1d']
    for (let i = 1; i < order.length; i++) {
      expect(TIMEFRAME_SECONDS[order[i]]).toBeGreaterThan(TIMEFRAME_SECONDS[order[i - 1]])
    }
  })
})
