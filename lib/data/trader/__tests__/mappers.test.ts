jest.mock('@/lib/constants/exchanges', () => ({
  SOURCE_TYPE_MAP: { binance_futures: 'futures', hyperliquid: 'web3' },
}))

import {
  normalizePeriod,
  normalizeWinRate,
  normalizeScoreConfidence,
  getSourceAliases,
  mapLeaderboardRow,
} from '../mappers'

describe('normalizePeriod', () => {
  it('7D/30D/90D（大小写不敏感）', () => {
    expect(normalizePeriod('7d')).toBe('7D')
    expect(normalizePeriod('30D')).toBe('30D')
    expect(normalizePeriod('90d')).toBe('90D')
  })
  it('null/未知 → 90D 兜底', () => {
    expect(normalizePeriod(null)).toBe('90D')
    expect(normalizePeriod('weird')).toBe('90D')
  })
})

describe('normalizeWinRate（ratio↔percentage 单位）', () => {
  it('≤1 视为 ratio → ×100', () => {
    expect(normalizeWinRate(0.5)).toBe(50)
    expect(normalizeWinRate(0.01)).toBe(1)
    expect(normalizeWinRate(1)).toBe(100) // 边界：1 当 ratio → 100%
  })
  it('>1 视为已是百分比 → 原样', () => {
    expect(normalizeWinRate(55)).toBe(55)
    expect(normalizeWinRate(99.9)).toBe(99.9)
  })
  it('clamp 到 0-100', () => {
    expect(normalizeWinRate(150)).toBe(100)
  })
  it('null → null', () => {
    expect(normalizeWinRate(null)).toBeNull()
    expect(normalizeWinRate(undefined)).toBeNull()
  })
})

describe('normalizeScoreConfidence', () => {
  it('preserves current confidence labels including insufficient', () => {
    expect(normalizeScoreConfidence('full')).toBe('full')
    expect(normalizeScoreConfidence('partial')).toBe('partial')
    expect(normalizeScoreConfidence('minimal')).toBe('minimal')
    expect(normalizeScoreConfidence('insufficient')).toBe('insufficient')
  })

  it('normalizes bounded legacy numeric values', () => {
    expect(normalizeScoreConfidence(80)).toBe('full')
    expect(normalizeScoreConfidence('50')).toBe('partial')
    expect(normalizeScoreConfidence(0)).toBe('minimal')
  })

  it.each([
    null,
    undefined,
    '',
    '  ',
    ' 50',
    '0x50',
    '1e2',
    '+80',
    'unknown',
    false,
    {},
    Number.NaN,
    -1,
    101,
  ])('keeps invalid confidence %p unknown', (value) => {
    expect(normalizeScoreConfidence(value)).toBeNull()
  })
})

describe('getSourceAliases（遗留源名映射）', () => {
  it('已知平台 → 别名数组（含旧名）', () => {
    expect(getSourceAliases('binance_futures')).toEqual(['binance', 'binance_futures'])
    expect(getSourceAliases('okx_web3')).toEqual(['okx', 'okx_web3'])
  })
  it('未知平台 → [platform] 兜底', () => {
    expect(getSourceAliases('brandnew')).toEqual(['brandnew'])
  })
})

describe('leaderboard ROI 单位', () => {
  it('mapLeaderboardRow：roi 已是百分比 → 原样', () => {
    expect(mapLeaderboardRow({ roi: 50 }).roi).toBe(50)
  })
})

describe('mapLeaderboardRow — 列名兼容 + 字段映射', () => {
  it('兼容 source/platform 两种列名', () => {
    expect(mapLeaderboardRow({ source: 'binance_futures' }).platform).toBe('binance_futures')
    expect(mapLeaderboardRow({ platform: 'hyperliquid' }).platform).toBe('hyperliquid')
  })

  it('兼容 source_trader_id/trader_key', () => {
    expect(mapLeaderboardRow({ source_trader_id: 'abc' }).traderKey).toBe('abc')
    expect(mapLeaderboardRow({ trader_key: 'xyz' }).traderKey).toBe('xyz')
  })

  it('period 从 period 或 season_id 归一化', () => {
    expect(mapLeaderboardRow({ season_id: '7d' }).period).toBe('7D')
    expect(mapLeaderboardRow({ period: '30D' }).period).toBe('30D')
  })

  it('sourceType 从 SOURCE_TYPE_MAP 推导', () => {
    expect(mapLeaderboardRow({ platform: 'hyperliquid' }).sourceType).toBe('web3')
  })

  it('web3_bot 平台 → traderType=bot', () => {
    expect(mapLeaderboardRow({ platform: 'web3_bot' }).traderType).toBe('bot')
  })

  it('数值型 score_completeness → 置信度字符串（≥80 full/≥50 partial/else minimal）', () => {
    expect(mapLeaderboardRow({ score_completeness: 90 }).scoreConfidence).toBe('full')
    expect(mapLeaderboardRow({ score_completeness: 60 }).scoreConfidence).toBe('partial')
    expect(mapLeaderboardRow({ score_completeness: 30 }).scoreConfidence).toBe('minimal')
  })

  it('字符串型 score_completeness → 已知标签保留', () => {
    expect(mapLeaderboardRow({ score_completeness: 'full' }).scoreConfidence).toBe('full')
    expect(mapLeaderboardRow({ score_completeness: 'insufficient' }).scoreConfidence).toBe(
      'insufficient'
    )
    expect(mapLeaderboardRow({ score_completeness: 'corrupt' }).scoreConfidence).toBeNull()
  })

  it('null 字段 → null（不崩、不 NaN）', () => {
    const t = mapLeaderboardRow({})
    expect(t.roi).toBeNull()
    expect(t.pnl).toBeNull()
    expect(t.arenaScore).toBeNull()
    expect(t.isOutlier).toBe(false)
  })

  it('is_outlier 严格 === true', () => {
    expect(mapLeaderboardRow({ is_outlier: true }).isOutlier).toBe(true)
    expect(mapLeaderboardRow({ is_outlier: 'true' }).isOutlier).toBe(false) // 非严格 true
  })
})
