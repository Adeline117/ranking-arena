import { readFileSync } from 'fs'
import { join } from 'path'
import { parseXtLeaderboardPage, parseXtLeaderboardSeries, parseXtProfile } from '../parsers'
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
    // 逐图核对 image63: Lead AUM + copier profit/tenure/growth from the board row
    expect(first.headlineAum).toBeCloseTo(262477.24, 1) // totalFollowerMargin
    const xe = first.headlineExtras as Record<string, number>
    expect(xe.copier_total_profit).toBeCloseTo(2359.04, 1)
    expect(xe.trading_days).toBe(480)
    expect(xe.copier_growth).toBe(51)
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

describe('parseXtLeaderboardSeries', () => {
  const DAY_MS = 86_400_000
  const seriesCtx: ParseCtx = { ...ctx, scrapedAt: '2026-07-16T12:00:00.000Z' }
  const point = (date: string, amount: number) => ({
    time: Date.parse(date),
    amount: String(amount),
  })
  const payload = (chart: Array<{ time: number; amount: string }>) => ({
    result: { items: [{ accountId: 'xt-1', chart }] },
  })
  const points = (chart: Array<{ time: number; amount: string }>, timeframe: 7 | 30 | 90) =>
    parseXtLeaderboardSeries(payload(chart), seriesCtx, timeframe).get('xt-1')?.[0].points ?? []

  it('removes the known detached prefix without truncating the valid 90 UTC days', () => {
    const detachedPrefixStart = Date.parse('2025-10-15T00:00:00.000Z')
    const validWindowStart = Date.parse('2026-04-18T00:00:00.000Z')
    const chart = [
      ...Array.from({ length: 9 }, (_, i) => ({
        time: detachedPrefixStart + i * DAY_MS,
        amount: String(-100 + i),
      })),
      ...Array.from({ length: 90 }, (_, i) => ({
        time: validWindowStart + i * DAY_MS,
        amount: String(i),
      })),
    ]

    const parsed = points(chart, 90)
    expect(parsed).toHaveLength(90)
    expect(parsed[0]).toEqual({ ts: '2026-04-18T00:00:00.000Z', value: 0 })
    expect(parsed.at(-1)).toEqual({ ts: '2026-07-16T00:00:00.000Z', value: 89 })
  })

  it('uses inclusive UTC-day and bounded future-skew boundaries', () => {
    const start = Date.parse('2026-07-10T00:00:00.000Z')
    const scrape = Date.parse(seriesCtx.scrapedAt)
    const parsed = points(
      [
        { time: start - 1, amount: '-1' },
        { time: start, amount: '1' },
        { time: scrape + 5 * 60_000, amount: '2' },
        { time: scrape + 5 * 60_000 + 1, amount: '3' },
      ],
      7
    )

    expect(parsed).toEqual([
      { ts: '2026-07-10T00:00:00.000Z', value: 1 },
      { ts: '2026-07-16T12:05:00.000Z', value: 2 },
    ])
  })

  it('sorts unsorted points and de-duplicates exact timestamps with last value winning', () => {
    const duplicate = Date.parse('2026-07-14T00:00:00.000Z')
    const parsed = points(
      [
        point('2026-07-16T00:00:00.000Z', 4),
        { time: duplicate, amount: '2' },
        point('2026-07-10T00:00:00.000Z', 1),
        { time: duplicate, amount: '3' },
      ],
      7
    )

    expect(parsed).toEqual([
      { ts: '2026-07-10T00:00:00.000Z', value: 1 },
      { ts: '2026-07-14T00:00:00.000Z', value: 3 },
      { ts: '2026-07-16T00:00:00.000Z', value: 4 },
    ])
  })

  it('marks only a valid non-empty chart as a complete replacement snapshot', () => {
    const parsed = parseXtLeaderboardSeries(
      payload([point('2026-07-16T00:00:00.000Z', 4)]),
      seriesCtx,
      7
    )
    expect(parsed.get('xt-1')?.[0]).toMatchObject({
      timeframe: 7,
      metric: 'pnl',
      replaceSeries: true,
    })

    const invalid = parseXtLeaderboardSeries(
      {
        result: {
          items: [
            {
              accountId: 'xt-1',
              chart: [
                { time: Date.parse('2026-07-16T00:00:00.000Z'), amount: true },
                { time: Date.parse('2026-07-15T00:00:00.000Z'), amount: [] },
                { time: Date.parse('2026-07-14T00:00:00.000Z'), amount: '0x10' },
              ],
            },
          ],
        },
      },
      seriesCtx,
      7
    )
    expect(invalid.size).toBe(0)
  })

  it('fails closed when scrapedAt cannot anchor the requested window', () => {
    const invalidCtx = { ...seriesCtx, scrapedAt: 'not-a-date' }
    expect(
      parseXtLeaderboardSeries(payload([point('2026-07-16T00:00:00.000Z', 1)]), invalidCtx, 7).size
    ).toBe(0)
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

  it('uses the leader-stats Performance block when present (live-captured endpoint)', () => {
    const profile = parseXtProfile(
      {
        detail: fixture('detail-fut.json'),
        stats: fixture('leader-stats-30.json'),
        symbolPrefer: fixture('leader-symbol-prefer-30.json'),
        timeframe: 30,
      },
      ctx
    )
    const s = profile.stats[0]
    // The img65 Performance block — previously uncaptured (TIER 2), now via
    // leader-stats?accountId&recentDays.
    expect(s.roi).toBeCloseTo(320.09, 1) // recentRate 3.2009 (decimal) ×100
    expect(s.pnl).toBeCloseTo(95.627, 2) // totalEarnings
    expect(s.mdd).toBeCloseTo(13.01, 1) // maxRetraction 0.130089
    expect(s.winRate).toBe(100) // winRate 1
    expect(s.winPositions).toBe(24) // profitCount
    expect(s.totalPositions).toBe(24) // totalTransactions
    expect(s.copierPnl).toBeCloseTo(-653.36, 1) // followersEarnings
    expect(s.aum).toBe(2570) // followerMargin (Lead AUM)
    expect(s.holdingDurationAvgHours).toBeCloseTo(17.67, 1) // avgHoldTime 63606.62s
    expect(s.extras.avg_profit).toBeCloseTo(4.6326, 3)
    expect(s.extras.trade_frequency).toBe(3.43)
    expect(s.extras.loss_trades).toBe(0)
    // 市场偏好 donut (img64) from leader-symbol-prefer
    const prefs = s.tradingPreferences as { markets: Array<{ symbol: string }> }
    expect(prefs.markets[0].symbol).toBe('AXS_USDT')
    expect(prefs.markets).toHaveLength(4)
  })

  it('survives an empty detail payload', () => {
    const profile = parseXtProfile({ detail: {}, timeframe: 7 }, ctx)
    expect(profile.stats).toHaveLength(0)
  })
})
