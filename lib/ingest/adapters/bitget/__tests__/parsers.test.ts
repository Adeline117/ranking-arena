import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseBitgetHistory,
  parseBitgetLeaderboardPage,
  parseBitgetPositions,
  parseBitgetProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'bitget_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

describe('parseBitgetLeaderboardPage', () => {
  it('parses the currentTrader/list shape (percent values)', () => {
    const payload = {
      data: {
        total: 1860,
        list: [
          {
            traderId: '123',
            traderName: 'Alpha',
            headUrl: 'https://img.bitgetimg.com/a.png',
            roi: 15.5,
            profit: 1234.56,
            winRate: 62.5,
            drawDown: 8.2,
            followerNum: 100,
            copyTraderNum: 28,
          },
          { traderId: '456', traderName: 'Beta', roi: -3.2, profit: -50, winRate: 40 },
        ],
      },
    }
    const page = parseBitgetLeaderboardPage(payload, ctx)
    expect(page.reportedTotal).toBe(1860)
    expect(page.rows).toHaveLength(2)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '123',
      rank: 1,
      nickname: 'Alpha',
      headlineRoi: 15.5,
      headlinePnl: 1234.56,
      headlineWinRate: 62.5,
      traderKind: 'human',
    })
    expect(page.rows[1].rank).toBe(2)
    expect(page.rows[0].raw).toMatchObject({ drawDown: 8.2 })
  })

  it('parses the legacy traderList shape (decimal ratios → percent)', () => {
    const payload = {
      data: {
        traderList: [
          {
            traderUid: '789',
            traderNickName: 'Gamma',
            headPic: 'https://img.bitgetimg.com/g.png',
            profitRate: 0.155,
            totalProfit: 999,
            winningRate: 0.625,
          },
        ],
      },
    }
    const page = parseBitgetLeaderboardPage(payload, ctx)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '789',
      nickname: 'Gamma',
      headlineRoi: 15.5,
      headlinePnl: 999,
      headlineWinRate: 62.5,
    })
  })

  it('parses the UTA traderView shape (rows + itemVoList, verified live 2026-06)', () => {
    const payload = {
      code: '200',
      data: {
        containActModel: false,
        maxShowSizes: 30,
        nextFlag: true,
        totals: 30, // page row count, NOT a global total
        rows: [
          {
            traderUid: 'beb24d718eb23b54ac91',
            portfolioId: '1446487090121363456',
            userName: 'BGUSER-FFAEKKR0',
            displayName: 'AI-HUB',
            headPic: 'https://qrc.bgstatic.com/otc/images/a.png',
            followCount: 72,
            itemVoList: [
              { showColumnCode: 'profit_rate', comparedValue: '305513.07', percentColumn: true },
              { showColumnCode: 'total_income', comparedValue: '7350.77' },
              { showColumnCode: 'total_follow_profit', comparedValue: '1209.79' },
              { showColumnCode: 'max_retracement', comparedValue: '4.83' },
              { showColumnCode: 'winning_rate', comparedValue: '58.33' },
            ],
          },
        ],
      },
    }
    const page = parseBitgetLeaderboardPage(payload, ctx)
    expect(page.reportedTotal).toBeNull() // UTA has nextFlag, no global total
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: 'beb24d718eb23b54ac91', // traderUid = identity
      nickname: 'AI-HUB',
      avatarUrlOrigin: 'https://qrc.bgstatic.com/otc/images/a.png',
      headlineRoi: 305513.07,
      headlinePnl: 7350.77,
      headlineWinRate: 58.33,
    })
    expect(page.rows[0].raw).toMatchObject({ portfolioId: '1446487090121363456' })
  })

  it('skips rows without an id and returns empty for junk payloads', () => {
    expect(parseBitgetLeaderboardPage({ data: { list: [{ roi: 5 }] } }, ctx).rows).toHaveLength(0)
    expect(parseBitgetLeaderboardPage(null, ctx).rows).toHaveLength(0)
    expect(parseBitgetLeaderboardPage({ code: '500' }, ctx).rows).toHaveLength(0)
  })
})

describe('parseBitgetProfile (live-captured fixtures, 2026-06-11)', () => {
  const detailV2 = fixture('profile-detail-v2.json')

  it('parses detailV2 + cycleData 30d into a full stats block', () => {
    const raw = { detailV2, cycleData: fixture('profile-cycle-30.json'), timeframe: 30 }
    const profile = parseBitgetProfile(raw, ctx)

    expect(profile.nickname).toBe('杰辰资本')
    expect(profile.avatarUrlOrigin).toContain('bgstatic.com')
    expect(profile.stats).toHaveLength(1)
    expect(profile.stats[0]).toMatchObject({
      timeframe: 30,
      roi: -57.48, // statisticsDTO.profitRate, already percent
      pnl: -284.97, // statisticsDTO.profit
      mdd: 63.76,
      winRate: 59.73,
      winPositions: 267,
      totalPositions: 447,
      copierPnl: -81591.52,
      copierCount: 4,
      aum: 75085.31,
      profitShareRate: 10,
      sharpe: null, // Bitget doesn't expose it — NULL-collapse downstream
    })
    expect(profile.stats[0].holdingDurationAvgHours).toBeCloseTo(225888 / 3600, 3)
    expect(profile.stats[0].tradingPreferences).toMatchObject({ totalAmount: 447 })
    expect(profile.stats[0].extras).toMatchObject({
      settled_in_days: 891,
      copier_count_current: 91,
      copier_count_max: 100,
    })
    expect(profile.stats[0].extras.style_labels).toContain('高频')
  })

  it('parses roi + pnl cumulative chart series consistent with the stats block', () => {
    const raw = { detailV2, cycleData: fixture('profile-cycle-30.json'), timeframe: 30 }
    const profile = parseBitgetProfile(raw, ctx)

    const roi = profile.series.find((s) => s.metric === 'roi')
    const pnl = profile.series.find((s) => s.metric === 'pnl')
    expect(roi?.points).toHaveLength(30)
    expect(pnl?.points).toHaveLength(30)
    // Verified invariant: chart endpoints equal the stats block values.
    expect(roi?.points.at(-1)?.value).toBe(-57.48)
    expect(pnl?.points.at(-1)?.value).toBe(-284.97)
    // dataTime ms → UTC ISO (Bitget daily buckets close at midnight UTC+8 = 16:00Z)
    expect(roi?.points[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/)
  })

  it('parses 7d and 90d cycles with the requested timeframe tag', () => {
    for (const tf of [7, 90] as const) {
      const raw = { detailV2, cycleData: fixture(`profile-cycle-${tf}.json`), timeframe: tf }
      const profile = parseBitgetProfile(raw, ctx)
      expect(profile.stats[0]?.timeframe).toBe(tf)
      expect(profile.series.find((s) => s.metric === 'roi')?.points.length).toBeGreaterThan(0)
    }
  })

  it('handles missing payloads without throwing', () => {
    expect(parseBitgetProfile({ timeframe: 7 }, ctx).stats).toHaveLength(0)
    expect(
      parseBitgetProfile({ timeframe: 7, cycleData: { data: null } }, ctx).series
    ).toHaveLength(0)
    expect(parseBitgetProfile(null, ctx)).toBeTruthy()
  })
})

describe('parseBitgetPositions (live-captured fixture, 2026-06-11)', () => {
  it('parses public/traderPosition rows', () => {
    const positions = parseBitgetPositions(fixture('positions.json'), ctx)
    expect(positions).toHaveLength(2)
    expect(positions[0]).toMatchObject({
      symbol: 'SOLUSDT',
      side: 'short', // holdSide 2
      leverage: 25,
      markPrice: null, // not exposed on this endpoint — NULL-collapse
      unrealizedPnl: null,
    })
    // size = openMarginCount (quote-unit margin), entryPrice = avgPrice
    expect(positions[0].size).toBe(Number(positions[0].raw.openMarginCount))
    expect(positions[0].entryPrice).toBe(Number(positions[0].raw.avgPrice))
    expect(positions[0].size).toBeGreaterThan(0)
    expect(positions[0].raw).toMatchObject({ symbolId: 'SOLUSDT_UMCBL' })
  })

  it('returns empty for junk/blocked payloads', () => {
    expect(parseBitgetPositions(null, ctx)).toHaveLength(0)
    expect(parseBitgetPositions({ code: '30066', msg: '仓位保护' }, ctx)).toHaveLength(0)
    expect(parseBitgetPositions({ data: null }, ctx)).toHaveLength(0)
  })
})

describe('parseBitgetHistory (live-captured fixtures, 2026-06-11)', () => {
  it('parses position_history rows from order/historyList', () => {
    const rows = parseBitgetHistory(fixture('position-history-p1.json'), 'position_history', ctx)
    expect(rows).toHaveLength(20)
    const first = rows[0]
    if (first.kind !== 'position_history') throw new Error('wrong kind')
    expect(first.symbol).toBe('SOLUSDT')
    expect(first.side).toBe('long') // position: 1 ↔ positionDesc 多仓
    expect(first.leverage).toBe(25)
    expect(first.openedAt).toMatch(/Z$/)
    expect(first.closedAt).toMatch(/Z$/)
    expect(first.entryPrice).toBe(Number(first.raw.openAvgPrice))
    expect(first.exitPrice).toBe(Number(first.raw.closeAvgPrice))
    expect(first.realizedPnl).toBe(Number(first.raw.netProfit))
    // orderNo-keyed dedupe is deterministic and unique per row
    expect(new Set(rows.map((r) => r.dedupeHash)).size).toBe(20)
    const again = parseBitgetHistory(fixture('position-history-p1.json'), 'position_history', ctx)
    expect(again[0].dedupeHash).toBe(first.dedupeHash)
  })

  it('parses copiers rows from trader/followerList with scrape-time ts', () => {
    const rows = parseBitgetHistory(fixture('copiers-p1.json'), 'copiers', ctx)
    expect(rows.length).toBeGreaterThan(0)
    const first = rows[0]
    if (first.kind !== 'copiers') throw new Error('wrong kind')
    expect(first.ts).toBe(ctx.scrapedAt)
    expect(first.copierLabel).toMatch(/^BGUSER/)
    expect(first.copierInvested).toBe(Number(first.raw.totalMargin))
    expect(first.copierPnl).toBe(Number(first.raw.totalProfit))
    expect(first.copyDurationDays).toBeNull()
  })

  it('throws for unsupported kinds and tolerates junk payloads', () => {
    expect(() => parseBitgetHistory({}, 'transfers', ctx)).toThrow(/not supported/)
    expect(() => parseBitgetHistory({}, 'orders', ctx)).toThrow(/not supported/)
    expect(parseBitgetHistory(null, 'position_history', ctx)).toHaveLength(0)
    expect(parseBitgetHistory({ data: {} }, 'copiers', ctx)).toHaveLength(0)
  })
})
