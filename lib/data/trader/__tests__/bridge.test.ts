/**
 * bridge — TraderDetail → 遗留 TraderPageData 映射。
 * 70/25/5 综合分、持仓数交叉校验(enrichment 终身数据 vs 周期数据)、
 * 持仓时长 m/h/d/w 格式化、bio 'null' 字符串守卫。喂 trader 详情三页。
 */
import { toTraderPageData } from '../bridge'
import type { TraderDetail } from '@/lib/types/unified-trader'

type DeepPartial<T> = { [K in keyof T]?: unknown }

function detail(overrides: DeepPartial<TraderDetail> = {}): TraderDetail {
  return {
    trader: {
      platform: 'bybit',
      traderKey: 'tk-1',
      handle: 'whale',
      avatarUrl: null,
      roi: 50,
      pnl: 10000,
      winRate: 60,
      maxDrawdown: 20,
      tradesCount: 100,
      arenaScore: 80,
      followers: null,
      copiers: null,
      ...(overrides.trader as object),
    },
    periods: { '90D': null, '30D': null, '7D': null, ...(overrides.periods as object) },
    equityCurve: { '90D': [], '30D': [], '7D': [], ...(overrides.equityCurve as object) },
    assetBreakdown: { '90D': [], '30D': [], '7D': [], ...(overrides.assetBreakdown as object) },
    stats: (overrides.stats as TraderDetail['stats']) ?? null,
    portfolio: (overrides.portfolio as TraderDetail['portfolio']) ?? [],
    positionHistory: (overrides.positionHistory as TraderDetail['positionHistory']) ?? [],
    similarTraders: (overrides.similarTraders as TraderDetail['similarTraders']) ?? [],
    trackedSince: (overrides.trackedSince as string) ?? null,
    bio: (overrides.bio as string) ?? null,
  } as TraderDetail
}

function stats(overrides: Record<string, unknown> = {}): NonNullable<TraderDetail['stats']> {
  return {
    sharpeRatio: null,
    copiersPnl: null,
    copiersCount: null,
    winningPositions: null,
    totalPositions: null,
    avgHoldingHours: null,
    avgProfit: null,
    avgLoss: null,
    largestWin: null,
    largestLoss: null,
    aum: null,
    ...overrides,
  } as NonNullable<TraderDetail['stats']>
}

const perf = (d: TraderDetail) => toTraderPageData(d).performance as Record<string, unknown>

describe('overall_score 70/25/5 综合', () => {
  it('三期齐全 → 精确加权', () => {
    const d = detail({
      periods: {
        '90D': { arenaScore: 80 },
        '30D': { arenaScore: 60 },
        '7D': { arenaScore: 40 },
      },
    })
    // 80*0.7 + 60*0.25 + 40*0.05 = 56+15+2 = 73
    expect(perf(d).overall_score).toBe(73)
  })

  it('缺 30D/7D → 回退用 90D 值(不惩罚数据缺失)', () => {
    const d = detail({ periods: { '90D': { arenaScore: 80 }, '30D': null, '7D': null } })
    expect(perf(d).overall_score).toBe(80) // 80*(0.7+0.25+0.05)
  })

  it('无 90D 分且 trader.arenaScore null → null', () => {
    const d = detail({ trader: { arenaScore: null } })
    expect(perf(d).overall_score).toBeNull()
  })
})

describe('持仓数交叉校验', () => {
  it('enrichment winning > 周期 trades(终身数据混入)→ 用 winRate×trades 重算', () => {
    const d = detail({
      trader: { winRate: 60, tradesCount: 100 },
      stats: stats({ winningPositions: 500 }), // 500 > 100 → 是终身数据
    })
    expect(perf(d).winning_positions).toBe(60) // 60%×100
  })

  it('enrichment 合理 → 直接用', () => {
    const d = detail({
      trader: { winRate: 60, tradesCount: 100 },
      stats: stats({ winningPositions: 55 }),
    })
    expect(perf(d).winning_positions).toBe(55)
  })

  it('enrichment total >> 周期 trades(2 倍以上)→ 用周期 trades', () => {
    const d = detail({
      trader: { tradesCount: 100 },
      stats: stats({ totalPositions: 500 }), // 500 > 200
    })
    expect(perf(d).total_positions).toBe(100)
  })

  it('total < winning(自相矛盾)→ 用周期 trades 保一致', () => {
    const d = detail({
      trader: { winRate: 60, tradesCount: 100 },
      stats: stats({ winningPositions: 90, totalPositions: 50 }), // 50 < 90 矛盾
    })
    expect(perf(d).total_positions).toBe(100)
  })
})

describe('profile 映射', () => {
  it('handle 缺失回退 traderKey;followers null → 0', () => {
    const d = detail({ trader: { handle: null, followers: null } })
    const profile = toTraderPageData(d).profile as Record<string, unknown>
    expect(profile.handle).toBe('tk-1')
    expect(profile.followers).toBe(0)
  })

  it("bio 字符串 'null'/'undefined'(脏数据)→ null", () => {
    expect((toTraderPageData(detail({ bio: 'null' })).profile as { bio: unknown }).bio).toBeNull()
    expect(
      (toTraderPageData(detail({ bio: 'undefined' })).profile as { bio: unknown }).bio
    ).toBeNull()
    expect((toTraderPageData(detail({ bio: 'real bio' })).profile as { bio: unknown }).bio).toBe(
      'real bio'
    )
  })
})

describe('avgHoldingTime 格式化(m/h/d/w)', () => {
  const holdingOf = (hours: number) => {
    const d = detail({ trader: { avgHoldingHours: hours }, stats: stats() })
    const s = toTraderPageData(d).stats as { additionalStats: { avgHoldingTime: string } }
    return s.additionalStats.avgHoldingTime
  }

  it('<1h → 分钟;<24h → 小时;<168h → 天;>=168h → 周', () => {
    expect(holdingOf(0.5)).toBe('30m')
    expect(holdingOf(5.25)).toBe('5.3h')
    expect(holdingOf(48)).toBe('2.0d')
    expect(holdingOf(336)).toBe('2.0w')
  })
})

describe('集合映射', () => {
  it('equityCurve 缺 roi/pnl → 0 兜底', () => {
    const d = detail({
      equityCurve: {
        '90D': [{ date: '2026-07-01', roi: null, pnl: null }],
        '30D': [],
        '7D': [],
      },
    })
    const ec = toTraderPageData(d).equityCurve as { '90D': Array<{ roi: number; pnl: number }> }
    expect(ec['90D'][0]).toEqual({ date: '2026-07-01', roi: 0, pnl: 0 })
  })

  it('portfolio/positionHistory 方向缺失 → long 兜底', () => {
    const d = detail({
      portfolio: [{ symbol: 'BTCUSDT', direction: null, pnlUsd: 100, entryPrice: null }],
      positionHistory: [{ symbol: 'ETHUSDT', direction: null, pnlUsd: null, pnlPct: null }],
    })
    const out = toTraderPageData(d)
    expect((out.portfolio as Array<{ direction: string }>)[0].direction).toBe('long')
    expect((out.positionHistory as Array<{ direction: string; status: string }>)[0]).toMatchObject({
      direction: 'long',
      status: 'closed',
    })
  })

  it('stats 为 null → 输出 stats null(不伪造)', () => {
    expect(toTraderPageData(detail()).stats).toBeNull()
  })

  it('similarTraders 映射 handle 回退 + followers 0 兜底', () => {
    const d = detail({
      similarTraders: [
        {
          platform: 'okx',
          traderKey: 'sk1',
          handle: null,
          avatarUrl: null,
          followers: null,
          roi: 5,
          arenaScore: 70,
        },
      ],
    })
    const st = toTraderPageData(d).similarTraders as Array<Record<string, unknown>>
    expect(st[0]).toMatchObject({ handle: 'sk1', id: 'sk1', followers: 0, source: 'okx' })
  })
})
