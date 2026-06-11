import { parseBitgetLeaderboardPage, parseBitgetProfile } from '../parsers'
import type { ParseCtx } from '../../../core/types'

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

  it('skips rows without an id and returns empty for junk payloads', () => {
    expect(parseBitgetLeaderboardPage({ data: { list: [{ roi: 5 }] } }, ctx).rows).toHaveLength(0)
    expect(parseBitgetLeaderboardPage(null, ctx).rows).toHaveLength(0)
    expect(parseBitgetLeaderboardPage({ code: '500' }, ctx).rows).toHaveLength(0)
  })
})

describe('parseBitgetProfile', () => {
  it('parses detail + profitList bundle into stats and series', () => {
    const raw = {
      timeframe: 30,
      detail: {
        data: {
          traderName: 'Alpha',
          headUrl: 'https://img.bitgetimg.com/a.png',
          roi: 22.1,
          profit: 5000,
          winRate: 58,
          drawDown: 12.3,
          totalOrder: 200,
          winOrder: 116,
          followerNum: 150,
          copyTraderNum: 28,
          totalFollowAssets: 80000,
        },
      },
      profitList: {
        data: [
          { date: 1765411200000, profit: 120.5 },
          { date: 1765497600000, profit: -30.2 },
        ],
      },
    }
    const profile = parseBitgetProfile(raw, ctx)
    expect(profile.nickname).toBe('Alpha')
    expect(profile.stats).toHaveLength(1)
    expect(profile.stats[0]).toMatchObject({
      timeframe: 30,
      roi: 22.1,
      pnl: 5000,
      mdd: 12.3,
      winRate: 58,
      winPositions: 116,
      totalPositions: 200,
      copierCount: 28,
      aum: 80000,
      sharpe: null, // Bitget doesn't expose it — NULL-collapse downstream
    })
    expect(profile.series).toHaveLength(1)
    expect(profile.series[0].metric).toBe('pnl')
    expect(profile.series[0].points).toHaveLength(2)
    expect(profile.series[0].points[0].ts).toBe('2025-12-11T00:00:00.000Z')
  })

  it('handles a missing detail payload without throwing', () => {
    const profile = parseBitgetProfile({ timeframe: 7, detail: { data: null } }, ctx)
    expect(profile.stats).toHaveLength(0)
    expect(profile.series).toHaveLength(0)
  })
})
