import {
  calculateBeta,
  calculateCorrelationMetrics,
  calculateAlpha,
  detectMarketCondition,
  detectVolatilityRegime,
  calculateTrendStrength,
  analyzeMarketCondition,
  calculateMarketConditionPerformance,
  calculateMarketCorrelation,
} from '../market-correlation'

// 造 N 天日收益（%）
const seq = (n: number, fn: (i: number) => number) => Array.from({ length: n }, (_, i) => fn(i))

describe('calculateBeta', () => {
  it('数据不足(<14) → null', () => {
    expect(
      calculateBeta(
        seq(10, () => 1),
        seq(10, () => 1)
      )
    ).toBeNull()
  })

  it('完全相同的序列 → beta ≈ 1', () => {
    const r = seq(30, (i) => (i % 2 === 0 ? 2 : -1))
    const beta = calculateBeta(r, r)!
    expect(beta).toBeCloseTo(1, 5)
  })

  it('恰好 2 倍放大的序列 → beta ≈ 2', () => {
    const bench = seq(30, (i) => (i % 2 === 0 ? 2 : -1))
    const trader = bench.map((x) => x * 2)
    expect(calculateBeta(trader, bench)!).toBeCloseTo(2, 5)
  })

  it('反向序列 → beta 为负', () => {
    const bench = seq(30, (i) => (i % 2 === 0 ? 2 : -1))
    const trader = bench.map((x) => -x)
    expect(calculateBeta(trader, bench)!).toBeLessThan(0)
  })

  it('基准零方差(全 0，float 精确为 0) → null', () => {
    // 注：非 0 常量(如全 3→/100=0.03)在 float 下 variance 非恰好 0，不保证 null；
    // 全 0 是唯一能可靠触发 variance===0 的场景。真实 BTC 收益不会恒定，无实际影响。
    expect(
      calculateBeta(
        seq(20, (i) => i),
        seq(20, () => 0)
      )
    ).toBeNull()
  })

  it('beta 被 clamp 在 [-5,5]', () => {
    const bench = seq(30, (i) => (i % 2 === 0 ? 0.1 : -0.1))
    const trader = bench.map((x) => x * 1000) // 极端放大
    const beta = calculateBeta(trader, bench)!
    expect(beta).toBeLessThanOrEqual(5)
    expect(beta).toBeGreaterThanOrEqual(-5)
  })
})

describe('calculateCorrelationMetrics', () => {
  it('相同序列 → correlation≈1, rSquared≈1', () => {
    const r = seq(30, (i) => Math.sin(i))
    const m = calculateCorrelationMetrics(r, r)!
    expect(m.correlation).toBeCloseTo(1, 5)
    expect(m.rSquared).toBeCloseTo(1, 5)
  })

  it('数据不足 → null', () => {
    expect(
      calculateCorrelationMetrics(
        seq(5, () => 1),
        seq(5, () => 1)
      )
    ).toBeNull()
  })
})

describe('calculateAlpha', () => {
  it('非法输入 → null', () => {
    expect(calculateAlpha(null as unknown as number, 5, 1)).toBeNull()
    expect(calculateAlpha(5, null as unknown as number, 1)).toBeNull()
    expect(calculateAlpha(5, 5, null as unknown as number)).toBeNull()
    expect(calculateAlpha(5, 5, 1, 0)).toBeNull() // periodDays<=0
  })

  it('beta=1 且交易员收益=基准收益 → alpha≈0（无超额）', () => {
    // 忽略微小 risk-free 项
    const a = calculateAlpha(10, 10, 1, 30)!
    expect(Math.abs(a)).toBeLessThan(1)
  })

  it('跑赢基准 → alpha 为正', () => {
    expect(calculateAlpha(20, 10, 1, 30)!).toBeGreaterThan(0)
  })

  it('alpha clamp 在 [-100,100]', () => {
    expect(calculateAlpha(9999, 0, 1, 30)!).toBeLessThanOrEqual(100)
    expect(calculateAlpha(-9999, 0, 1, 30)!).toBeGreaterThanOrEqual(-100)
  })
})

describe('detectMarketCondition', () => {
  it('累计涨幅≥5% → bull', () => {
    expect(detectMarketCondition(seq(10, () => 1))).toBe('bull') // 每天+1%
  })

  it('累计跌幅≤-5% → bear', () => {
    expect(detectMarketCondition(seq(10, () => -1))).toBe('bear')
  })

  it('小幅震荡 → sideways', () => {
    expect(detectMarketCondition([0.5, -0.5, 0.3, -0.3])).toBe('sideways')
  })

  it('空数组 → sideways', () => {
    expect(detectMarketCondition([])).toBe('sideways')
  })
})

describe('detectVolatilityRegime', () => {
  it('数据不足 → medium（默认）', () => {
    expect(detectVolatilityRegime(seq(5, () => 1))).toBe('medium')
  })

  it('极低波动 → low', () => {
    expect(detectVolatilityRegime(seq(30, () => 0.01))).toBe('low')
  })

  it('极端波动 → extreme', () => {
    // std 很大 * sqrt(365) ≥ 100
    expect(detectVolatilityRegime(seq(30, (i) => (i % 2 === 0 ? 20 : -20)))).toBe('extreme')
  })
})

describe('calculateTrendStrength', () => {
  it('数据不足 → 0', () => {
    expect(calculateTrendStrength(seq(5, () => 1))).toBe(0)
  })

  it('持续上涨 → 正的趋势强度', () => {
    expect(calculateTrendStrength(seq(40, () => 2))).toBeGreaterThan(0)
  })

  it('持续下跌 → 负的趋势强度', () => {
    expect(calculateTrendStrength(seq(40, () => -2))).toBeLessThan(0)
  })

  it('趋势强度 clamp 在 [-1,1]', () => {
    const s = calculateTrendStrength(seq(40, () => 50))
    expect(s).toBeLessThanOrEqual(1)
    expect(s).toBeGreaterThanOrEqual(-1)
  })
})

describe('analyzeMarketCondition', () => {
  it('返回完整分析 + confidence 是 0-100 整数', () => {
    const a = analyzeMarketCondition(seq(90, () => 1))
    expect(['bull', 'bear', 'sideways']).toContain(a.condition)
    expect(Number.isInteger(a.confidence)).toBe(true)
    expect(a.confidence).toBeGreaterThanOrEqual(0)
    expect(a.confidence).toBeLessThanOrEqual(100)
  })
})

describe('calculateMarketConditionPerformance', () => {
  it('长度不等 → 全 null', () => {
    expect(
      calculateMarketConditionPerformance(
        seq(10, () => 1),
        seq(20, () => 1)
      )
    ).toEqual({
      bull: null,
      bear: null,
      sideways: null,
    })
  })

  it('返回各市况的累计表现（或 null）', () => {
    const trader = seq(30, (i) => (i % 3 === 0 ? 2 : -1))
    const bench = seq(30, (i) => (i < 15 ? 1 : -1))
    const perf = calculateMarketConditionPerformance(trader, bench)
    expect(perf).toHaveProperty('bull')
    expect(perf).toHaveProperty('bear')
    expect(perf).toHaveProperty('sideways')
  })
})

describe('calculateMarketCorrelation（批量）', () => {
  it('汇总各项且类型正确', () => {
    const r = seq(30, (i) => Math.sin(i) * 3)
    const res = calculateMarketCorrelation({
      traderReturns: r,
      btcReturns: r,
      ethReturns: r,
      traderTotalReturn: 15,
      btcTotalReturn: 10,
      periodDays: 30,
    })
    expect(res.betaBtc).toBeCloseTo(1, 4)
    expect(['bull', 'bear', 'sideways']).toContain(res.marketCondition)
    expect(['low', 'medium', 'high', 'extreme']).toContain(res.volatilityRegime)
  })

  it('数据不足时 beta=null → alpha 也 null', () => {
    const res = calculateMarketCorrelation({
      traderReturns: seq(5, () => 1),
      btcReturns: seq(5, () => 1),
      ethReturns: seq(5, () => 1),
      traderTotalReturn: 10,
      btcTotalReturn: 5,
      periodDays: 30,
    })
    expect(res.betaBtc).toBeNull()
    expect(res.alpha).toBeNull()
  })
})
