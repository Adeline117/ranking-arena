import { PipelineCalculator, getCalculator, quickArenaScore } from '../calculator'
import type { StandardTraderData } from '../types'

const calc = new PipelineCalculator()

function trader(o: Partial<StandardTraderData>): StandardTraderData {
  return {
    platform: 'binance_futures',
    window: '30d',
    trader_id: 't1',
    roi_pct: 50,
    pnl_usd: 10000,
    confidence: 'full',
    trades_count: 100,
    avg_holding_hours: 24,
    win_rate_pct: 55,
    ...(o as StandardTraderData),
  } as StandardTraderData
}

describe('calculateArenaScore', () => {
  it('分数 clamp 在 [0,100]', () => {
    const s = calc.calculateArenaScore(trader({ roi_pct: 99999, pnl_usd: 1e12 }))
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(100)
  })

  it('roi/pnl 都非正 → 0 分', () => {
    expect(calc.calculateArenaScore(trader({ roi_pct: -10, pnl_usd: -100 }))).toBe(0)
    expect(calc.calculateArenaScore(trader({ roi_pct: 0, pnl_usd: 0 }))).toBe(0)
  })

  it('roi 越高分越高（单调）', () => {
    const low = calc.calculateArenaScore(trader({ roi_pct: 10, pnl_usd: 0 }))
    const high = calc.calculateArenaScore(trader({ roi_pct: 200, pnl_usd: 0 }))
    expect(high).toBeGreaterThan(low)
  })
})

describe('detectTraderType（bot 启发式）', () => {
  it('非 DEX 平台 → null', () => {
    expect(
      calc.detectTraderType(trader({ platform: 'binance_futures', trader_id: '0xabc' }))
    ).toBeNull()
  })

  it('DEX 但非 0x 地址 → null', () => {
    expect(
      calc.detectTraderType(trader({ platform: 'hyperliquid', trader_id: 'alice' }))
    ).toBeNull()
  })

  it('DEX + 0x + 交易数 >500 → suspected_bot', () => {
    expect(
      calc.detectTraderType(
        trader({ platform: 'hyperliquid', trader_id: '0xabc', trades_count: 600 })
      )
    ).toBe('suspected_bot')
  })

  it('DEX + 0x + 超短持仓(<0.5h) + 交易>100 → suspected_bot', () => {
    expect(
      calc.detectTraderType(
        trader({
          platform: 'hyperliquid',
          trader_id: '0xabc',
          avg_holding_hours: 0.2,
          trades_count: 200,
        })
      )
    ).toBe('suspected_bot')
  })

  it('DEX + 0x + 胜率≥95 + 交易>50 → suspected_bot', () => {
    expect(
      calc.detectTraderType(
        trader({ platform: 'hyperliquid', trader_id: '0xabc', win_rate_pct: 96, trades_count: 60 })
      )
    ).toBe('suspected_bot')
  })

  it('DEX + 0x + 正常指标 → null（非 bot）', () => {
    expect(
      calc.detectTraderType(
        trader({
          platform: 'hyperliquid',
          trader_id: '0xabc',
          trades_count: 100,
          avg_holding_hours: 24,
          win_rate_pct: 55,
        })
      )
    ).toBeNull()
  })
})

describe('calculateOverallScore（跨窗口加权 90d*0.7+30d*0.25+7d*0.05）', () => {
  it('全部有分 → 加权平均', () => {
    const s = calc.calculateOverallScore({ '90d': 80, '30d': 60, '7d': 40 })!
    // 80*0.7 + 60*0.25 + 40*0.05 = 56+15+2 = 73；totalWeight=1 → 73
    expect(s).toBeCloseTo(73, 5)
  })

  it('部分 null → 只按有分的重新归一化', () => {
    // 只有 90d=80 → weightedSum=56, totalWeight=0.7 → 80
    expect(calc.calculateOverallScore({ '90d': 80, '30d': null, '7d': null })!).toBeCloseTo(80, 5)
  })

  it('全 null → null', () => {
    expect(calc.calculateOverallScore({ '90d': null, '30d': null, '7d': null })).toBeNull()
  })
})

describe('enrich（分组 + 排名）', () => {
  it('空输入 → 空', () => {
    expect(calc.enrich([])).toEqual([])
  })

  it('按 arena_score 降序分配 platform_rank', () => {
    const out = calc.enrich([
      trader({ trader_id: 'low', roi_pct: 5, pnl_usd: 100 }),
      trader({ trader_id: 'high', roi_pct: 300, pnl_usd: 1e6 }),
    ])
    const sorted = out.sort((a, b) => a.platform_rank! - b.platform_rank!)
    expect(sorted[0].trader_id).toBe('high') // rank 1
    expect(sorted[0].platform_rank).toBe(1)
    expect(sorted[1].platform_rank).toBe(2)
  })

  it('不同 platform:window 分组独立排名', () => {
    const out = calc.enrich([
      trader({ trader_id: 'a', platform: 'binance_futures', roi_pct: 100, pnl_usd: 1000 }),
      trader({ trader_id: 'b', platform: 'bybit', roi_pct: 100, pnl_usd: 1000 }),
    ])
    // 各组独立 → 都是各自组的 rank 1
    expect(out.every((t) => t.platform_rank === 1)).toBe(true)
  })
})

describe('quickArenaScore', () => {
  it('clamp [0,100]', () => {
    expect(quickArenaScore(99999, 1e12)).toBeLessThanOrEqual(100)
    expect(quickArenaScore(-10, -10)).toBe(0)
  })

  it('null 输入 → 0 分量', () => {
    expect(quickArenaScore(null, null)).toBe(0)
  })
})

describe('getCalculator（单例）', () => {
  it('多次调用返回同一实例', () => {
    expect(getCalculator()).toBe(getCalculator())
  })
})
