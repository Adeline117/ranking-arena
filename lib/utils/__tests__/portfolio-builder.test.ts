import {
  countTradersMissingRiskData,
  generatePortfolioSuggestion,
  generateAllPortfolioSuggestions,
  type TraderForPortfolio,
} from '../portfolio-builder'

let seq = 0
function t(overrides: Partial<TraderForPortfolio> = {}): TraderForPortfolio {
  seq++
  return {
    trader_id: `t${seq}`,
    source: `ex${seq}`,
    handle: `h${seq}`,
    roi: 50,
    max_drawdown: -8,
    win_rate: 65,
    arena_score: 80,
    followers: 500,
    source_type: 'futures',
    ...overrides,
  }
}

beforeEach(() => {
  seq = 0
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-07-03T00:00:00Z'))
})
afterEach(() => jest.useRealTimers())

describe('generatePortfolioSuggestion — 候选不足', () => {
  it('少于 3 个候选 → null', () => {
    expect(generatePortfolioSuggestion([t(), t()], 'conservative')).toBeNull()
  })

  it('全部被 conservative 门槛刷掉 → null', () => {
    // MDD 太大/WR 太低/score 太低，conservative 一个都不过
    const bad = [
      t({ max_drawdown: -50 }),
      t({ win_rate: 30 }),
      t({ arena_score: 40 }),
      t({ max_drawdown: -80 }),
    ]
    expect(generatePortfolioSuggestion(bad, 'conservative')).toBeNull()
  })
})

describe('generatePortfolioSuggestion — conservative', () => {
  function goodPool(): TraderForPortfolio[] {
    // 5 个都满足 MDD<10 / WR>60 / score>70，来自不同交易所
    return [
      t({ source: 'binance', source_type: 'futures', arena_score: 85 }),
      t({ source: 'bybit', source_type: 'spot', arena_score: 82 }),
      t({ source: 'okx', source_type: 'web3', arena_score: 80 }),
      t({ source: 'bitget', source_type: 'futures', arena_score: 78 }),
      t({ source: 'gate', source_type: 'spot', arena_score: 75 }),
    ]
  }

  it('产出合法组合结构', () => {
    const p = generatePortfolioSuggestion(goodPool(), 'conservative')!
    expect(p).not.toBeNull()
    expect(p.risk_level).toBe('conservative')
    expect(p.name).toBe('稳健型组合')
    expect(p.traders.length).toBeGreaterThanOrEqual(3)
    expect(p.created_at).toBe('2026-07-03T00:00:00.000Z')
  })

  it('配比总和归一到约 100%', () => {
    const p = generatePortfolioSuggestion(goodPool(), 'conservative')!
    const sum = p.traders.reduce((s, tr) => s + tr.allocation_pct, 0)
    expect(sum).toBeGreaterThanOrEqual(98)
    expect(sum).toBeLessThanOrEqual(102) // 取整误差
  })

  it('单个配比不超过 maxAllocation(30)', () => {
    const p = generatePortfolioSuggestion(goodPool(), 'conservative')!
    for (const tr of p.traders) {
      expect(tr.allocation_pct).toBeLessThanOrEqual(31) // 30 + 归一取整余量
    }
  })

  it('多元化得分在 0-100', () => {
    const p = generatePortfolioSuggestion(goodPool(), 'conservative')!
    expect(p.diversification_score).toBeGreaterThanOrEqual(0)
    expect(p.diversification_score).toBeLessThanOrEqual(100)
  })

  it('每个交易员带推荐理由与风险等级', () => {
    const p = generatePortfolioSuggestion(goodPool(), 'conservative')!
    for (const tr of p.traders) {
      expect(tr.reason).toBeTruthy()
      expect(['low', 'medium', 'high']).toContain(tr.risk_level)
    }
  })
})

describe('generatePortfolioSuggestion — aggressive（不限门槛，按 ROI 排序）', () => {
  it('高 MDD/低 WR 也能入选，优先高 ROI', () => {
    const pool = [
      t({ roi: 200, max_drawdown: -60, win_rate: 20, arena_score: 40, source: 'a' }),
      t({ roi: 180, max_drawdown: -50, win_rate: 25, arena_score: 45, source: 'b' }),
      t({ roi: 150, max_drawdown: -40, win_rate: 30, arena_score: 50, source: 'c' }),
      t({ roi: 100, max_drawdown: -30, win_rate: 35, arena_score: 55, source: 'd' }),
    ]
    const p = generatePortfolioSuggestion(pool, 'aggressive')!
    expect(p).not.toBeNull()
    expect(p.name).toBe('进取型组合')
    // ROI 最高的应入选（不被 MDD 刷掉）
    expect(p.traders.some((tr) => tr.trader_id === 't1')).toBe(true)
  })

  it('保留可信的零胜率和零回撤，且配比始终为有限数', () => {
    const pool = [
      t({ roi: 30, max_drawdown: 0, win_rate: 0, arena_score: 60, source: 'a' }),
      t({ roi: 20, max_drawdown: 0, win_rate: 0, arena_score: 50, source: 'b' }),
      t({ roi: 10, max_drawdown: 0, win_rate: 0, arena_score: 40, source: 'c' }),
    ]

    const p = generatePortfolioSuggestion(pool, 'aggressive')!
    expect(p).not.toBeNull()
    expect(p.traders).toHaveLength(3)
    expect(p.expected_metrics.max_drawdown).toBe(0)
    for (const trader of p.traders) {
      expect(Number.isFinite(trader.allocation_pct)).toBe(true)
      expect(trader.allocation_pct).toBeGreaterThan(0)
    }
  })

  it.each([
    ['unknown win rate', { win_rate: null }],
    ['unknown drawdown', { max_drawdown: null }],
    ['zero score', { arena_score: 0 }],
    ['NaN ROI', { roi: Number.NaN }],
    ['infinite score', { arena_score: Number.POSITIVE_INFINITY }],
    ['100 percent drawdown cap', { max_drawdown: 100 }],
  ])('排除 %s，不将 unknown 伪装成零', (_label, invalidMetrics) => {
    const pool = [t({ source: 'a' }), t({ source: 'b' }), t({ source: 'c', ...invalidMetrics })]

    expect(generatePortfolioSuggestion(pool, 'aggressive')).toBeNull()
  })

  it('全零 score 不会产生 NaN 组合', () => {
    const pool = [
      t({ arena_score: 0, source: 'a' }),
      t({ arena_score: 0, source: 'b' }),
      t({ arena_score: 0, source: 'c' }),
    ]

    expect(generatePortfolioSuggestion(pool, 'aggressive')).toBeNull()
  })
})

describe('generateAllPortfolioSuggestions', () => {
  it('返回各偏好中满足条件的组合', () => {
    const pool = [
      t({ source: 'binance', source_type: 'futures', arena_score: 85, roi: 120 }),
      t({ source: 'bybit', source_type: 'spot', arena_score: 82, roi: 100 }),
      t({ source: 'okx', source_type: 'web3', arena_score: 80, roi: 90 }),
      t({ source: 'bitget', source_type: 'futures', arena_score: 78, roi: 80 }),
      t({ source: 'gate', source_type: 'spot', arena_score: 75, roi: 70 }),
    ]
    const all = generateAllPortfolioSuggestions(pool)
    expect(all.length).toBeGreaterThan(0)
    expect(all.length).toBeLessThanOrEqual(3)
    // 每个 suggestion 的 risk_level 唯一
    const levels = all.map((s) => s.risk_level)
    expect(new Set(levels).size).toBe(levels.length)
  })

  it('空交易员池 → 空数组（不崩）', () => {
    expect(generateAllPortfolioSuggestions([])).toEqual([])
  })
})

/**
 * Missing risk data must never be read as zero risk.
 *
 * The expected value below was recorded from the builder BEFORE its internal
 * types were tightened and the `|| 0` fallbacks on drawdown / win rate were
 * removed, for this exact input (which includes traders with a missing
 * drawdown and with a missing win rate). The refactor must not change who is
 * picked, their allocations, or the expected metrics.
 */
describe('missing risk data', () => {
  const fixture: TraderForPortfolio[] = Array.from({ length: 24 }, (_, i) => ({
    trader_id: `t${i}`,
    source: ['binance_futures', 'bybit', 'okx_spot', 'hyperliquid_web3'][i % 4],
    handle: `Trader ${i}`,
    roi: 15 + ((i * 37) % 180),
    max_drawdown: i % 7 === 3 ? null : 4 + ((i * 11) % 45),
    win_rate: i % 9 === 5 ? null : 40 + ((i * 13) % 45),
    arena_score: 30 + ((i * 17) % 65),
    followers: i * 10,
    source_type: (['futures', 'futures', 'spot', 'web3'] as const)[i % 4],
  }))
  const incomplete = fixture.filter((t) => t.max_drawdown === null || t.win_rate === null)

  it('produces exactly what it produced before the fallbacks were removed', () => {
    const result = generateAllPortfolioSuggestions(fixture).map(
      ({ id: _id, created_at: _createdAt, ...rest }) => rest
    )
    expect(result).toEqual(RECORDED_BEFORE_REFACTOR)
  })

  it('never selects a trader whose drawdown or win rate is missing', () => {
    expect(incomplete.length).toBeGreaterThan(0)
    const picked = new Set(
      generateAllPortfolioSuggestions(fixture).flatMap((s) => s.traders.map((t) => t.trader_id))
    )
    for (const trader of incomplete) expect(picked.has(trader.trader_id)).toBe(false)
  })

  it('counts the traders it had to leave out, so the caller can say so', () => {
    expect(countTradersMissingRiskData(fixture)).toBe(incomplete.length)
    expect(countTradersMissingRiskData(fixture.filter((t) => !incomplete.includes(t)))).toBe(0)
  })

  it('never selects an idle-window account (no ROI, no PnL, no metrics, unscored)', () => {
    const idle: TraderForPortfolio = {
      trader_id: 'idle',
      source: 'binance_futures',
      handle: 'Idle',
      roi: 0,
      max_drawdown: null,
      win_rate: null,
      arena_score: 0,
      followers: 999_999,
      source_type: 'futures',
    }
    // Even with usable-looking metrics, an unscored account has no allocation weight.
    const idleWithMetrics = { ...idle, trader_id: 'idle-metrics', max_drawdown: 0, win_rate: 100 }
    const picked = new Set(
      generateAllPortfolioSuggestions([...fixture, idle, idleWithMetrics]).flatMap((s) =>
        s.traders.map((t) => t.trader_id)
      )
    )
    expect(picked.has('idle')).toBe(false)
    expect(picked.has('idle-metrics')).toBe(false)
    expect(countTradersMissingRiskData([idle])).toBe(1)
  })
})

const RECORDED_BEFORE_REFACTOR = [
  {
    name: '均衡型组合',
    description: '平衡收益与风险，适合大多数投资者',
    risk_level: 'balanced',
    traders: [
      {
        trader_id: 't22',
        source: 'okx_spot',
        handle: 'Trader 22',
        allocation_pct: 31,
        reason: 'Arena Score 优秀、现货交易风险较低',
        risk_level: 'medium',
        expected_contribution: {
          roi: 33.8,
          drawdown: 6.5,
        },
      },
      {
        trader_id: 't13',
        source: 'bybit',
        handle: 'Trader 13',
        allocation_pct: 22,
        reason: '风险控制良好、高胜率',
        risk_level: 'medium',
        expected_contribution: {
          roi: 29.9,
          drawdown: 2.6,
        },
      },
      {
        trader_id: 't6',
        source: 'okx_spot',
        handle: 'Trader 6',
        allocation_pct: 26,
        reason: 'Arena Score 优秀、高胜率、现货交易风险较低',
        risk_level: 'high',
        expected_contribution: {
          roi: 14.8,
          drawdown: 6.5,
        },
      },
      {
        trader_id: 't9',
        source: 'bybit',
        handle: 'Trader 9',
        allocation_pct: 21,
        reason: '风险控制良好、高胜率',
        risk_level: 'medium',
        expected_contribution: {
          roi: 35.3,
          drawdown: 2.7,
        },
      },
    ],
    expected_metrics: {
      roi: 113.8,
      max_drawdown: 18.4,
      sharpe_ratio: 12.17,
    },
    diversification_score: 73,
  },
  {
    name: '进取型组合',
    description: '追求高收益，接受较高波动',
    risk_level: 'aggressive',
    traders: [
      {
        trader_id: 't19',
        source: 'hyperliquid_web3',
        handle: 'Trader 19',
        allocation_pct: 36,
        reason: 'Arena Score 优秀、风险控制良好、高胜率、链上交易透明',
        risk_level: 'high',
        expected_contribution: {
          roi: 64.1,
          drawdown: 11.9,
        },
      },
      {
        trader_id: 't9',
        source: 'bybit',
        handle: 'Trader 9',
        allocation_pct: 18,
        reason: '风险控制良好、高胜率',
        risk_level: 'medium',
        expected_contribution: {
          roi: 30.2,
          drawdown: 2.3,
        },
      },
      {
        trader_id: 't18',
        source: 'okx_spot',
        handle: 'Trader 18',
        allocation_pct: 26,
        reason: 'Arena Score 优秀、风险控制良好、现货交易风险较低',
        risk_level: 'medium',
        expected_contribution: {
          roi: 36.7,
          drawdown: 5.7,
        },
      },
      {
        trader_id: 't13',
        source: 'bybit',
        handle: 'Trader 13',
        allocation_pct: 19,
        reason: '风险控制良好、高胜率',
        risk_level: 'medium',
        expected_contribution: {
          roi: 25.8,
          drawdown: 2.3,
        },
      },
    ],
    expected_metrics: {
      roi: 156.8,
      max_drawdown: 22.2,
      sharpe_ratio: 13.94,
    },
    diversification_score: 82,
  },
]
