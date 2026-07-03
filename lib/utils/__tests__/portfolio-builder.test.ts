import {
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
