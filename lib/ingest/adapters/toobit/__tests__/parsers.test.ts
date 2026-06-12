/**
 * Toobit parser tests over real RAW fixtures (captured live 2026-06-12
 * from the SG VPS against bapi.toobit.com). board-page.json = 3 real
 * leaders-new rows (sparkline trimmed); profile-bundle.json = detail +
 * radar(type=7) + accumulate-profit; positions.json includes a row the
 * leader MASKED ("****") — exercising the privacy-mask path.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseToobitHistory,
  parseToobitLeaderboardPage,
  parseToobitPositions,
  parseToobitProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'toobit_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-12T00:00:00.000Z',
  meta: {},
}

describe('parseToobitLeaderboardPage', () => {
  const payload = fixture('board-page.json')

  it('parses real rows: leaderUserId identity, fraction→percent metrics', () => {
    const page = parseToobitLeaderboardPage(payload, ctx)
    expect(page.rows).toHaveLength(3)
    expect(page.reportedTotal).toBe(1587) // string "1587" → number
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '668939882',
      rank: 1,
      nickname: 'Top trade(usdt)',
      traderKind: 'human',
      botStrategy: null,
      walletAddress: null,
    })
    expect(page.rows[0].avatarUrlOrigin).toMatch(/^https:\/\//)
    // leaderAvgProfitRatio 0.7729 (fraction) → 77.29%
    expect(page.rows[0].headlineRoi).toBeCloseTo(77.29, 2)
    expect(page.rows[0].headlinePnl).toBeCloseTo(29.7921, 4)
    expect(page.rows[0].headlineWinRate).toBeCloseTo(100, 6) // ratio "1"
  })

  it('keeps Sharpe + AUM + the cumulative-ROI sparkline verbatim in raw', () => {
    const page = parseToobitLeaderboardPage(payload, ctx)
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(raw.sharpeRatio).toBe('1.73')
    expect(raw.totalLeadAmount).toBe('190.83')
    expect(Array.isArray(raw.leaderTradeProfit)).toBe(true)
  })

  it('skips rows without a leaderUserId; empty payloads yield no rows', () => {
    const doctored = { board: { list: [{ nickname: 'anon' }, 'junk', null], total: '3' } }
    expect(parseToobitLeaderboardPage(doctored, ctx).rows).toHaveLength(0)
    expect(parseToobitLeaderboardPage(null, ctx).rows).toHaveLength(0)
    expect(parseToobitLeaderboardPage({}, ctx).rows).toHaveLength(0)
  })
})

describe('parseToobitProfile', () => {
  const payload = fixture('profile-bundle.json')

  it('stats: radar ROI/MDD/win-rate (fraction→pct) + detail counts + window PnL', () => {
    const profile = parseToobitProfile(payload, ctx)
    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s.timeframe).toBe(7)
    expect(s.roi).toBeCloseTo(77.29, 2) // radar.leaderProfitRatio == board ROI
    expect(s.mdd).toBeCloseTo(41.34, 2)
    expect(s.winRate).toBeCloseTo(100, 6)
    expect(s.pnl).toBeCloseTo(29.82, 2) // last accumulate point
    expect(s.copierCount).toBe(6)
    expect(s.aum).toBeCloseTo(190.83, 2)
    expect(s.profitShareRate).toBeCloseTo(10, 6) // 0.1 fraction
    expect(s.extras).toMatchObject({
      lead_days: 399,
      trade_count_lifetime: 161,
      last_week_win_rate: 100,
    })
    // radar "--" ratios must not leak NaN anywhere
    expect(JSON.stringify(s)).not.toContain('NaN')
  })

  it('emits an ascending cumulative-PnL series from yyyymmdd dates', () => {
    const profile = parseToobitProfile(payload, ctx)
    const pnl = profile.series.find((s) => s.metric === 'pnl')!
    expect(pnl.points.length).toBeGreaterThan(3)
    expect(pnl.points[0].ts).toBe('2026-06-06T00:00:00.000Z')
    expect(pnl.points[pnl.points.length - 1].value).toBeCloseTo(29.82, 2)
    expect(Date.parse(pnl.points[0].ts)).toBeLessThan(
      Date.parse(pnl.points[pnl.points.length - 1].ts)
    )
  })

  it('identity refresh comes from leader-detail', () => {
    const profile = parseToobitProfile(payload, ctx)
    expect(profile.nickname).toBe('Top trade(usdt)')
    expect(profile.avatarUrlOrigin).toMatch(/^https:\/\//)
  })

  it('yields no stats on an empty bundle', () => {
    const profile = parseToobitProfile({ timeframe: 30 }, ctx)
    expect(profile.stats).toHaveLength(0)
    expect(profile.series).toHaveLength(0)
  })
})

describe('parseToobitPositions', () => {
  it('parses open positions; MASKED rows ("****" symbol) are skipped', () => {
    const positions = parseToobitPositions(fixture('positions.json'), ctx)
    const fixtureRows = (fixture('positions.json') as { data: unknown[] }).data
    // the captured leader masks position details — at least one row drops
    expect(positions.length).toBeLessThan(fixtureRows.length)
    for (const p of positions) {
      expect(p.symbol).not.toBe('****')
      expect(['long', 'short', null]).toContain(p.side)
    }
  })

  it('masked scalars decode to null, never NaN', () => {
    const doctored = {
      data: [
        {
          symbolId: 'BTC-SWAP-USDT',
          isLong: 0,
          leverage: '50',
          positionQuantity: '7',
          quantity: '****',
          openPrice: '****',
          markPrice: '****',
          profit: '-22.57',
        },
      ],
    }
    const [p] = parseToobitPositions(doctored, ctx)
    expect(p).toMatchObject({
      symbol: 'BTC-SWAP-USDT',
      side: 'short',
      leverage: 50,
      size: 7,
      entryPrice: null,
      markPrice: null,
    })
    expect(p.unrealizedPnl).toBeCloseTo(-22.57, 2)
  })
})

describe('parseToobitHistory', () => {
  it('position_history: tuple dedupe when id is "0"; ms times → ISO', () => {
    const rows = parseToobitHistory(fixture('history-page.json'), 'position_history', ctx)
    expect(rows.length).toBeGreaterThan(0)
    const first = rows[0]
    expect(first).toMatchObject({ kind: 'position_history', symbol: 'OPN-SWAP-USDT', side: 'long' })
    if (first.kind === 'position_history') {
      expect(first.openedAt).toBe(new Date(1780988405541).toISOString())
      expect(first.closedAt).toBe(new Date(1781107799306).toISOString())
      expect(first.realizedPnl).toBeCloseTo(12.381, 3)
      expect(first.size).toBe(544) // openQty
    }
    // id "0" → deterministic field-tuple hash
    expect(first.dedupeHash).toBe(
      parseToobitHistory(fixture('history-page.json'), 'position_history', ctx)[0].dedupeHash
    )
  })

  it('copiers: invested + pnl + duration from followRunningMills', () => {
    const rows = parseToobitHistory(fixture('followers.json'), 'copiers', ctx)
    expect(rows.length).toBeGreaterThan(0)
    const first = rows[0]
    if (first.kind === 'copiers') {
      expect(first.copierLabel).toBe('Amir Locifer')
      expect(first.copierInvested).toBeCloseTo(13.4781, 4)
      expect(first.copierPnl).toBeCloseTo(-6.9218, 4)
      expect(first.copyDurationDays).toBe(Math.floor(28284751559 / 86_400_000)) // 327
    }
  })

  it('orders / transfers throw (not exposed publicly)', () => {
    expect(() => parseToobitHistory({}, 'orders', ctx)).toThrow('orders not supported')
    expect(() => parseToobitHistory({}, 'transfers', ctx)).toThrow('transfers not supported')
  })
})
