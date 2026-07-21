import { validateLeaderboardRows, validateStats, roiCrossCheckOk } from '../validate'
import type { ParsedLeaderboardRow, ParsedStats } from '../../core/types'

function row(overrides: Partial<ParsedLeaderboardRow> = {}): ParsedLeaderboardRow {
  return {
    exchangeTraderId: 'uid-1',
    rank: 1,
    nickname: 'trader',
    avatarUrlOrigin: null,
    walletAddress: null,
    traderKind: 'human',
    botStrategy: null,
    headlineRoi: 50,
    headlinePnl: 1000,
    headlineWinRate: 60,
    raw: {},
    ...overrides,
  }
}

function stats(overrides: Partial<ParsedStats> = {}): ParsedStats {
  return {
    timeframe: 30,
    asOf: '2026-07-03T00:00:00Z',
    roi: 50,
    pnl: 1000,
    sharpe: 1.5,
    mdd: 20,
    winRate: 60,
    winPositions: 6,
    totalPositions: 10,
    copierPnl: null,
    copierCount: null,
    aum: null,
    volume: null,
    profitShareRate: null,
    holdingDurationAvgHours: null,
    tradingPreferences: null,
    extras: {},
    ...overrides,
  }
}

describe('validateLeaderboardRows — 指标消毒边界', () => {
  it('合法行通过，正常值不变', () => {
    const { valid, rejects } = validateLeaderboardRows([row()])
    expect(rejects).toHaveLength(0)
    expect(valid).toHaveLength(1)
    expect(valid[0].headlineRoi).toBe(50)
  })

  it('roi 爆表（kucoin 2.19e9%）→ clamp 到 10000', () => {
    const { valid } = validateLeaderboardRows([row({ headlineRoi: 2.19e9 })])
    expect(valid[0].headlineRoi).toBe(10000)
  })

  it('roi 极端负 → clamp 到 -10000', () => {
    const { valid } = validateLeaderboardRows([row({ headlineRoi: -999999 })])
    expect(valid[0].headlineRoi).toBe(-10000)
  })

  it('winRate 越界 [0,100] → NULL（不是 clamp）', () => {
    const { valid } = validateLeaderboardRows([row({ headlineWinRate: 140 })])
    expect(valid[0].headlineWinRate).toBeNull()
    const neg = validateLeaderboardRows([row({ headlineWinRate: -5 })])
    expect(neg.valid[0].headlineWinRate).toBeNull()
  })

  it('mdd 越界（exchange 报 140665%）→ NULL', () => {
    const { valid } = validateLeaderboardRows([row({ headlineMdd: 140665 })])
    expect(valid[0].headlineMdd).toBeNull()
  })

  it('合法边界值保留（roi=10000/winRate=100/mdd=0）', () => {
    const { valid } = validateLeaderboardRows([
      row({ headlineRoi: 10000, headlineWinRate: 100, headlineMdd: 0 }),
    ])
    expect(valid[0].headlineRoi).toBe(10000)
    expect(valid[0].headlineWinRate).toBe(100)
    expect(valid[0].headlineMdd).toBe(0)
  })
})

describe('validateLeaderboardRows — zod + 必填 + 去重', () => {
  it('rank 非正 → zod reject（不进 valid）', () => {
    const { valid, rejects } = validateLeaderboardRows([row({ rank: 0 })])
    expect(valid).toHaveLength(0)
    expect(rejects[0].reason).toMatch(/^zod:/)
  })

  it('exchangeTraderId 空串 → zod reject', () => {
    const { rejects } = validateLeaderboardRows([row({ exchangeTraderId: '' })])
    expect(rejects[0].reason).toMatch(/^zod:/)
  })

  it('headlineRoi=Infinity → zod reject（finite 守卫）', () => {
    const { rejects } = validateLeaderboardRows([row({ headlineRoi: Infinity })])
    expect(rejects[0].reason).toMatch(/^zod:/)
  })

  it('rejects self-asserted trust, unknown metrics, and empty field paths', () => {
    const invalidSources = [
      {
        roi: {
          fieldPath: 'data.list[].roi',
          provenance: 'source_reported',
          verified: true,
        },
      },
      { volatility: { fieldPath: 'data.list[].volatility' } },
      { roi: { fieldPath: ' ' } },
    ]
    for (const headlineMetricSources of invalidSources) {
      const { valid, rejects } = validateLeaderboardRows([
        row({
          headlineMetricSources: headlineMetricSources as never,
        }),
      ])
      expect(valid).toHaveLength(0)
      expect(rejects[0].reason).toMatch(/^zod:/)
    }
  })

  it('rejects a field source attached to a missing metric', () => {
    const { valid, rejects } = validateLeaderboardRows([
      row({
        headlineRoi: null,
        headlineMetricSources: { roi: { fieldPath: 'data.list[].roi' } },
      }),
    ])
    expect(valid).toHaveLength(0)
    expect(rejects[0].reason).toMatch(/^zod:/)
  })

  it('drops field lineage when staging changes the upstream metric value', () => {
    const { valid } = validateLeaderboardRows([
      row({
        headlineRoi: 2.19e9,
        headlineWinRate: 140,
        headlineMdd: 140665,
        headlineMetricSources: {
          roi: { fieldPath: 'data.list[].roi' },
          pnl: { fieldPath: 'data.list[].pnl' },
          win_rate: { fieldPath: 'data.list[].winRate' },
          mdd: { fieldPath: 'data.list[].mdd' },
        },
      }),
    ])
    expect(valid[0].headlineMetricSources).toEqual({
      pnl: { fieldPath: 'data.list[].pnl' },
    })
  })

  it('必填字段缺失 → missing_required_field reject', () => {
    const { valid, rejects } = validateLeaderboardRows(
      [row({ headlinePnl: null })],
      ['headlinePnl']
    )
    expect(valid).toHaveLength(0)
    expect(rejects[0].reason).toBe('missing_required_field:headlinePnl')
  })

  it('同 exchangeTraderId 去重，保留更优（更低）rank', () => {
    const { valid } = validateLeaderboardRows([
      row({ exchangeTraderId: 'dup', rank: 5 }),
      row({ exchangeTraderId: 'dup', rank: 2 }),
    ])
    expect(valid).toHaveLength(1)
    expect(valid[0].rank).toBe(2)
  })

  it('输出按 rank 升序排序', () => {
    const { valid } = validateLeaderboardRows([
      row({ exchangeTraderId: 'a', rank: 3 }),
      row({ exchangeTraderId: 'b', rank: 1 }),
      row({ exchangeTraderId: 'c', rank: 2 }),
    ])
    expect(valid.map((r) => r.rank)).toEqual([1, 2, 3])
  })
})

describe('validateStats', () => {
  it('roi clamp + mdd/winRate bound', () => {
    const { valid } = validateStats([stats({ roi: 5e9, mdd: 200, winRate: 150 })])
    expect(valid[0].roi).toBe(10000)
    expect(valid[0].mdd).toBeNull()
    expect(valid[0].winRate).toBeNull()
  })

  it('非法 timeframe → zod reject', () => {
    const { valid, rejects } = validateStats([stats({ timeframe: 45 as unknown as 30 })])
    expect(valid).toHaveLength(0)
    expect(rejects[0].reason).toMatch(/^zod:/)
  })

  it('必填缺失 → reject', () => {
    const { rejects } = validateStats([stats({ pnl: null })], ['pnl'])
    expect(rejects[0].reason).toBe('missing_required_field:pnl')
  })

  it('winPositions > totalPositions（不可能）→ null winPositions，保留 total', () => {
    const { valid } = validateStats([stats({ winPositions: 20, totalPositions: 10 })])
    expect(valid[0].winPositions).toBeNull()
    expect(valid[0].totalPositions).toBe(10)
  })

  it('winPositions ≤ totalPositions → 原样保留', () => {
    const { valid } = validateStats([stats({ winPositions: 6, totalPositions: 10 })])
    expect(valid[0].winPositions).toBe(6)
  })
})

describe('roiCrossCheckOk', () => {
  it('任一为 null → null（无法判定）', () => {
    expect(roiCrossCheckOk(null, 50)).toBeNull()
    expect(roiCrossCheckOk(50, null)).toBeNull()
  })

  it('容差内 → true', () => {
    expect(roiCrossCheckOk(100, 103, 5)).toBe(true) // 3% 差 < 5%
  })

  it('容差外 → false', () => {
    expect(roiCrossCheckOk(100, 120, 5)).toBe(false) // 20% 差 > 5%
  })

  it('完全相等 → true', () => {
    expect(roiCrossCheckOk(42, 42)).toBe(true)
  })

  it('小数值用 scale=1 避免放大微小绝对差', () => {
    // headline=0.1, profile=0.2 → 绝对差 0.1，scale=max(0.1,0.2,1)=1 → 10% 差
    expect(roiCrossCheckOk(0.1, 0.2, 5)).toBe(false)
    expect(roiCrossCheckOk(0.1, 0.14, 5)).toBe(true) // 4% 差
  })
})
