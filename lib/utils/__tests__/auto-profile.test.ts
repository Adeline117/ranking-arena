jest.mock('@/lib/constants/exchanges', () => ({
  SOURCE_TYPE_MAP: {
    hyperliquid: 'web3',
    binance_futures: 'futures',
    binance_spot: 'spot',
  },
  EXCHANGE_CONFIG: {},
}))

import { generateAutoTags } from '../auto-profile'
import type { AutoProfileInput } from '../auto-profile'

// 构造最小 input
function input(overrides: {
  platform?: string
  is_bot?: boolean
  total?: number | null
  snapshot?: Record<string, unknown> | null
}): AutoProfileInput {
  return {
    platform: overrides.platform ?? 'binance_futures',
    trader_key: 'k',
    display_name: null,
    snapshot: (overrides.snapshot ?? null) as AutoProfileInput['snapshot'],
    total_traders_on_platform: overrides.total ?? 1000,
    is_bot: overrides.is_bot ?? false,
  }
}

describe('generateAutoTags — 平台/bot 标签', () => {
  it('DEX(web3) 平台 → defi', () => {
    expect(generateAutoTags(input({ platform: 'hyperliquid' }))).toContain('defi')
  })

  it('CEX 平台 → 无 defi', () => {
    expect(generateAutoTags(input({ platform: 'binance_futures' }))).not.toContain('defi')
  })

  it('is_bot → bot 标签', () => {
    expect(generateAutoTags(input({ is_bot: true }))).toContain('bot')
  })

  it('无 snapshot → 只返回平台/bot 标签（提前返回）', () => {
    expect(
      generateAutoTags(input({ platform: 'hyperliquid', is_bot: true, snapshot: null }))
    ).toEqual(expect.arrayContaining(['defi', 'bot']))
    // 无 snapshot 时不含业绩标签
    expect(generateAutoTags(input({ snapshot: null }))).not.toContain('whale')
  })
})

describe('generateAutoTags — 业绩阈值标签', () => {
  it('whale：|pnl| ≥ 100k', () => {
    expect(generateAutoTags(input({ snapshot: { pnl: 100_000 } }))).toContain('whale')
    expect(generateAutoTags(input({ snapshot: { pnl: -500_000 } }))).toContain('whale') // 绝对值
    expect(generateAutoTags(input({ snapshot: { pnl: 99_999 } }))).not.toContain('whale')
  })

  it('active：trades ≥ 1000', () => {
    expect(generateAutoTags(input({ snapshot: { trades_count: 1000 } }))).toContain('active')
    expect(generateAutoTags(input({ snapshot: { trades_count: 999 } }))).not.toContain('active')
  })

  it('high-winrate：win_rate ≥ 70', () => {
    expect(generateAutoTags(input({ snapshot: { win_rate: 70 } }))).toContain('high-winrate')
    expect(generateAutoTags(input({ snapshot: { win_rate: 69 } }))).not.toContain('high-winrate')
  })

  it('high-roi：roi > 100', () => {
    expect(generateAutoTags(input({ snapshot: { roi: 101 } }))).toContain('high-roi')
    expect(generateAutoTags(input({ snapshot: { roi: 100 } }))).not.toContain('high-roi') // 严格 >
  })

  it('elite：arena_score ≥ 80', () => {
    expect(generateAutoTags(input({ snapshot: { arena_score: 80 } }))).toContain('elite')
    expect(generateAutoTags(input({ snapshot: { arena_score: 79 } }))).not.toContain('elite')
  })

  it('风险标签：mdd ≤10 low / ≤30 moderate / >30 high', () => {
    expect(generateAutoTags(input({ snapshot: { max_drawdown: 5 } }))).toContain('low-risk')
    expect(generateAutoTags(input({ snapshot: { max_drawdown: 25 } }))).toContain('moderate-risk')
    expect(generateAutoTags(input({ snapshot: { max_drawdown: 50 } }))).toContain('high-risk')
  })
})

describe('generateAutoTags — 组合 + 去重', () => {
  it('多阈值同时命中 → 多标签', () => {
    const tags = generateAutoTags(
      input({
        platform: 'hyperliquid',
        snapshot: {
          pnl: 200_000,
          trades_count: 2000,
          win_rate: 75,
          roi: 150,
          arena_score: 85,
          max_drawdown: 5,
        },
      })
    )
    expect(tags).toEqual(
      expect.arrayContaining([
        'defi',
        'whale',
        'active',
        'high-winrate',
        'high-roi',
        'elite',
        'low-risk',
      ])
    )
  })

  it('标签去重（无重复）', () => {
    const tags = generateAutoTags(input({ snapshot: { pnl: 100_000 } }))
    expect(tags.length).toBe(new Set(tags).size)
  })
})
