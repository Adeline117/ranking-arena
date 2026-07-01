import { readFileSync } from 'fs'
import { join } from 'path'
import { parseXtLeaderboardPage, parseXtProfile } from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'xt_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

const spotCtx: ParseCtx = { ...ctx, sourceSlug: 'xt_spot', meta: { boardKey: 'spot' } }

describe('parseXtLeaderboardPage', () => {
  it('parses the futures v3 board (result.total + decimal rates)', () => {
    const page = parseXtLeaderboardPage(fixture('leaderboard-fut-30.json'), ctx)
    expect(page.reportedTotal).toBe(1873)
    expect(page.rows.length).toBe(3)
    const first = page.rows[0]
    expect(first.exchangeTraderId).toBe('4612442474598781734')
    expect(first.rank).toBe(1)
    expect(first.nickname).toBeTruthy()
    expect(first.traderKind).toBe('human')
    // incomeRate 1.7253 (decimal) → 172.53%
    expect(first.headlineRoi).toBeCloseTo(172.53, 1)
    expect(first.headlinePnl).toBeCloseTo(119279.25, 1)
    // winRate 1 → 100%
    expect(first.headlineWinRate).toBeCloseTo(100, 5)
    // maxRetraction 0.4257 (already percent) → headlineMdd, so XT captures MDD
    // (was previously dropped → 0% MDD capture in prod).
    expect(first.headlineMdd).toBeCloseTo(0.4257, 4)
    // 跟单人数 (followerCount) → headlineCopierCount → trader_stats.copier_count
    expect(first.headlineCopierCount).toBe(43)
    // Lvl badge → traderMeta
    expect(first.traderMeta).toMatchObject({ xt_level: 2, xt_level_name: 'Lvl 2' })
    // chart series preserved verbatim in raw
    expect(Array.isArray((first.raw as { chart?: unknown[] }).chart)).toBe(true)
  })

  it('parses the spot board and re-anchors rank densely', () => {
    const page = parseXtLeaderboardPage(fixture('leaderboard-spot-30.json'), spotCtx)
    expect(page.rows.length).toBeGreaterThan(0)
    expect(page.rows[0].exchangeTraderId).toBe('4612486463456677958')
    expect(page.rows.map((r) => r.rank)).toEqual(page.rows.map((_, i) => i + 1))
  })

  it('drops all-zero placeholder rows for the spot board (spec §5.6)', () => {
    const payload = {
      result: {
        items: [
          { accountId: 'a', income: '12.3', incomeRate: '0.4', winRate: '0.5' },
          { accountId: 'z1', income: '0', incomeRate: '0', winRate: '0' },
          { accountId: 'z2', income: '0', incomeRate: '0', winRate: '0' },
        ],
      },
    }
    const spot = parseXtLeaderboardPage(payload, spotCtx)
    expect(spot.rows.map((r) => r.exchangeTraderId)).toEqual(['a'])
    // futures keeps every row (no placeholder drop)
    const fut = parseXtLeaderboardPage(payload, ctx)
    expect(fut.rows.length).toBe(3)
  })

  it('returns empty on malformed payloads', () => {
    expect(parseXtLeaderboardPage({}, ctx).rows).toHaveLength(0)
    expect(parseXtLeaderboardPage({ result: { items: 'x' } }, ctx).rows).toHaveLength(0)
  })
})

describe('parseXtProfile', () => {
  it('maps leader-detail-v2 to an overview stats block', () => {
    const profile = parseXtProfile({ detail: fixture('detail-fut.json'), timeframe: 30 }, ctx)
    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s.timeframe).toBe(30)
    expect(s.roi).toBeCloseTo(12, 5) // profitRate 0.12 → 12%
    expect(s.extras.leading_days).toBe(234)
    expect(s.extras.style_labels).toEqual(['Short term', 'conservative'])
    expect(s.extras.intro).toBeTruthy()
    expect(s.extras.copier_count_history).toBe(9) // followNumber
    expect(s.extras.max_copier_slots).toBe(100) // maxFollowerSize
    expect(profile.nickname).toBe('阿阳')
    expect(profile.series).toHaveLength(0)
  })

  it('survives an empty detail payload', () => {
    const profile = parseXtProfile({ detail: {}, timeframe: 7 }, ctx)
    expect(profile.stats).toHaveLength(0)
  })
})
