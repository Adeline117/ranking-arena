/**
 * LBank parser tests over real RAW fixtures (captured live 2026-06-11 from
 * www.lbank.com/copy-trading?tab=all + lead trader LBA4E71122). Leaderboard
 * fixtures truncated to 2-3 rows; both TF crawl variants covered.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseLbankHistory,
  parseLbankLeaderboardPage,
  parseLbankPositions,
  parseLbankProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'lbank_futures',
  currency: 'USDT',
  tfLabelMap: { '7D': 7, '30D': 30 },
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

describe('parseLbankLeaderboardPage', () => {
  it('parses the 30d board (s* selected fields, values already percent)', () => {
    const page = parseLbankLeaderboardPage(fixture('getall-30d-p1.json'), ctx)
    expect(page.reportedTotal).toBe(134)
    expect(page.rows).toHaveLength(3)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: 'LBA4E71122',
      rank: 1,
      nickname: 'FMN INVESTMENTS',
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: 5.71, // sprofitRate "5.71" — ALREADY percent
      headlinePnl: 1290.3856,
      headlineWinRate: 93.44,
    })
    expect(page.rows[0].avatarUrlOrigin).toMatch(
      /^https:\/\/www\.lbank\.com\/static-old-backend\/imageRepository\//
    )
    // drawDown, AUM (followerBalance), copier slots, sparkline... verbatim
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(raw.drawDown).toBe('14.21')
    expect(raw.followerBalance).toBe('56318.32')
    expect(Array.isArray(raw.profitRates)).toBe(true)
  })

  it('parses the 7d crawl (owRankingValue) — same trader, 7d s* values', () => {
    const page = parseLbankLeaderboardPage(fixture('getall-7d-p1.json'), ctx)
    expect(page.reportedTotal).toBe(134)
    const fmn = page.rows.find((r) => r.exchangeTraderId === 'LBA4E71122')!
    expect(fmn.headlineRoi).toBe(6.28) // 7d sprofitRate ≠ 30d 5.71
    expect((fmn.raw as Record<string, unknown>).drawDown).toBe('6.54')
  })

  it('returns empty rows for an error payload', () => {
    const page = parseLbankLeaderboardPage({ error_code: 10006, success: false }, ctx)
    expect(page.rows).toHaveLength(0)
    expect(page.reportedTotal).toBeNull()
  })
})

describe('parseLbankProfile', () => {
  const bundle = {
    headInfo: fixture('head-info.json'),
    stat: fixture('stat-1m.json'),
    profitRateChart: fixture('profit-rate-30.json'),
    profitChart: fixture('profit-30.json'),
    volumeChart: fixture('trade-volume-30.json'),
    tradePreference: fixture('trade-preference-30.json'),
    timeframe: 30,
  }

  it('parses the 30d window-scoped Performance block + 3 chart series', () => {
    const profile = parseLbankProfile(bundle, ctx)
    expect(profile.nickname).toBe('FMN INVESTMENTS')
    expect(profile.avatarUrlOrigin).toMatch(/^https:\/\/www\.lbank\.com\/static-old-backend\//)

    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s).toMatchObject({
      timeframe: 30,
      roi: 5.71, // already percent
      pnl: 1290.38,
      mdd: 14.21,
      winRate: 93.44,
      totalPositions: 263,
      copierPnl: 595.87,
      copierCount: 29,
      aum: 0, // stat followerBalance "0" (board card carries the real AUM)
      profitShareRate: null,
      sharpe: null,
      winPositions: null,
    })
    expect(s.tradingPreferences).toMatchObject({
      instruments: expect.arrayContaining([
        expect.objectContaining({ instrumentId: 'SPXUSDT', rate: '94.77' }),
      ]),
    })
    expect(s.extras).toMatchObject({
      trader_level: 5,
      max_copier_slots: 5000,
      current_followers: 46,
      open_positions: 6,
      closed_positions: 122,
    })

    const metrics = profile.series.map((x) => x.metric).sort()
    expect(metrics).toEqual(['pnl', 'roi', 'volume_daily'])
    const roi = profile.series.find((x) => x.metric === 'roi')!
    expect(roi.points).toHaveLength(30)
    expect(roi.points[0]).toEqual({ ts: '2026-05-13T00:00:00.000Z', value: -1.24 })
    expect(roi.points[29]).toEqual({ ts: '2026-06-11T00:00:00.000Z', value: 5.71 })
    const vol = profile.series.find((x) => x.metric === 'volume_daily')!
    expect(vol.points[0].value).toBe(3898.46)
  })
})

describe('parseLbankPositions', () => {
  it('parses current lead positions (side null — enum unverified)', () => {
    const positions = parseLbankPositions(fixture('positions.json'), ctx)
    expect(positions.length).toBeGreaterThanOrEqual(1)
    expect(positions[0]).toMatchObject({
      symbol: 'SPXUSDT',
      side: null,
      leverage: 1,
      size: 7685.96, // position
      markPrice: null,
      unrealizedPnl: null,
    })
    expect(positions[0].entryPrice).toBeCloseTo(0.3595415, 5)
  })
})

describe('parseLbankHistory', () => {
  it('parses Order History closed positions (SECONDS epochs, positionID hash)', () => {
    const rows = parseLbankHistory(fixture('position-history-p1.json'), 'position_history', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'position_history',
      symbol: 'SPXUSDT',
      side: null,
      leverage: 1,
      size: 6830.52,
      entryPrice: 0.332,
      exitPrice: 0.3371,
      realizedPnl: 35.2637,
      openedAt: '2026-06-04T00:33:04.000Z', // insertTime 1780533184 s
      closedAt: '2026-06-11T23:33:00.000Z', // closeTime "1781220780" s
    })
    expect(rows[0].dedupeHash).toMatch(/^[0-9a-f]{40}$/)
    const again = parseLbankHistory(fixture('position-history-p1.json'), 'position_history', ctx)
    expect(again[0].dedupeHash).toBe(rows[0].dedupeHash)
  })

  it('parses copiers (masked name stored, never rendered)', () => {
    const rows = parseLbankHistory(fixture('followers-p1.json'), 'copiers', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: 'LBA****035',
      copierPnl: 2281.7355,
      copierInvested: null,
      copyDurationDays: 130,
    })
  })

  it('throws on unsupported surfaces', () => {
    expect(() => parseLbankHistory({}, 'orders', ctx)).toThrow('not supported')
    expect(() => parseLbankHistory({}, 'transfers', ctx)).toThrow('not supported')
  })
})
