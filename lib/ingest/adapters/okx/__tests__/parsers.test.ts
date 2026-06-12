/**
 * OKX CEX copy-trading parser tests over real RAW fixtures (captured live
 * 2026-06-12 from the SG VPS against the official public API,
 * instType=SWAP). board-page.json = 3 real rank rows; profile-bundle.json
 * = public-stats + public-pnl (7 of 31 points, lastDays=2) + preference;
 * positions / history-page / copy-traders are verbatim responses.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseOkxHistory,
  parseOkxLeaderboardPage,
  parseOkxPositions,
  parseOkxProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'okx_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-12T00:00:00.000Z',
  meta: {},
}

describe('parseOkxLeaderboardPage', () => {
  const payload = fixture('board-page.json')

  it('parses real rank rows: uniqueCode identity, fraction→percent metrics', () => {
    const page = parseOkxLeaderboardPage(payload, ctx)
    expect(page.rows).toHaveLength(3)
    expect(page.reportedTotal).toBeNull() // endpoint reports totalPage, not rows
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '0A3CF5287316F730',
      rank: 1,
      nickname: 'Steady first',
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      traderMeta: null,
    })
    expect(page.rows[0].avatarUrlOrigin).toMatch(/^https:\/\//)
    // pnlRatio 7.1572 (fraction) → 715.72% over the native 90d window
    expect(page.rows[0].headlineRoi).toBeCloseTo(715.72, 2)
    expect(page.rows[0].headlinePnl).toBeCloseTo(157_576.08055, 3)
    expect(page.rows[0].headlineWinRate).toBeCloseTo(57.78, 2)
  })

  it('keeps board-card extras (aum, copier counts, sparkline) verbatim in raw', () => {
    const page = parseOkxLeaderboardPage(payload, ctx)
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(raw.aum).toBe('112471.6077582515123219')
    expect(raw.copyTraderNum).toBe('300')
    expect(Array.isArray(raw.pnlRatios)).toBe(true)
  })

  it('skips rows without a uniqueCode; empty payloads yield no rows', () => {
    const doctored = { board: { ranks: [{ nickName: 'no-code' }, 'junk', null] } }
    expect(parseOkxLeaderboardPage(doctored, ctx).rows).toHaveLength(0)
    expect(parseOkxLeaderboardPage(null, ctx).rows).toHaveLength(0)
    expect(parseOkxLeaderboardPage({}, ctx).rows).toHaveLength(0)
  })
})

describe('parseOkxProfile', () => {
  const payload = fixture('profile-bundle.json')

  it('window totals come from the NEWEST cumulative point', () => {
    const profile = parseOkxProfile(payload, ctx)
    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s.timeframe).toBe(30)
    // newest beginTs 1781193600000: pnl 94276.30…, pnlRatio 4.6204 → 462.04%
    expect(s.pnl).toBeCloseTo(94_276.3037625, 4)
    expect(s.roi).toBeCloseTo(462.04, 2)
    expect(s.winRate).toBeCloseTo(56.67, 2)
    expect(s.copierPnl).toBeCloseTo(727.92336, 4)
    expect(s.winPositions).toBeNull() // profitDays are DAYS → extras only
    expect(s.extras).toMatchObject({ profit_days: 17, loss_days: 13 })
    expect(s.tradingPreferences).toMatchObject({
      coins: expect.arrayContaining([{ ccy: 'BTC', ratio: expect.any(Number) }]),
    })
  })

  it('emits ascending roi + pnl series; window start point is 0', () => {
    const profile = parseOkxProfile(payload, ctx)
    const roi = profile.series.find((s) => s.metric === 'roi')!
    const pnl = profile.series.find((s) => s.metric === 'pnl')!
    expect(roi.points).toHaveLength(7)
    expect(pnl.points[0].value).toBe(0) // oldest = window start
    expect(Date.parse(pnl.points[0].ts)).toBeLessThan(Date.parse(pnl.points[6].ts))
    expect(pnl.points[6].value).toBeCloseTo(94_276.3037625, 4)
  })

  it('yields no stats on an empty bundle', () => {
    const profile = parseOkxProfile({ timeframe: 7 }, ctx)
    expect(profile.stats).toHaveLength(0)
    expect(profile.series).toHaveLength(0)
  })
})

describe('parseOkxPositions', () => {
  it('parses open lead positions with mark price and unrealized PnL', () => {
    const positions = parseOkxPositions(fixture('positions.json'), ctx)
    expect(positions).toHaveLength(3)
    expect(positions[0]).toMatchObject({
      symbol: 'ETH-USDT-SWAP',
      side: 'short',
      leverage: 10,
      size: 74.67,
    })
    expect(positions[0].entryPrice).toBeCloseTo(1679.6292, 4)
    expect(positions[0].markPrice).toBeCloseTo(1673.32, 2)
    expect(positions[0].unrealizedPnl).toBeCloseTo(47.1109, 4)
  })
})

describe('parseOkxHistory', () => {
  it('position_history: subPosId natural key; empty closeTime → null, never 0', () => {
    const rows = parseOkxHistory(fixture('history-page.json'), 'position_history', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'position_history',
      symbol: 'BTC-USDT-SWAP',
      side: 'short',
      leverage: 23,
      closedAt: null, // closeTime "" — partially closed leg
    })
    expect(rows[0].openedAt).toBe(new Date(1778770314697).toISOString())
    if (rows[0].kind === 'position_history') {
      expect(rows[0].exitPrice).toBeCloseTo(73_769.5, 1) // closeAvgPx still present
      expect(rows[0].realizedPnl).toBeCloseTo(5140.49648, 4)
    }
    expect(rows[0].dedupeHash).toBe(
      parseOkxHistory(fixture('history-page.json'), 'position_history', ctx)[0].dedupeHash
    ) // deterministic
  })

  it('copiers: top-10 list with derived copy duration; aggregate rides in raw', () => {
    const rows = parseOkxHistory(fixture('copy-traders.json'), 'copiers', ctx)
    expect(rows).toHaveLength(10)
    const first = rows[0]
    expect(first).toMatchObject({ kind: 'copiers', ts: ctx.scrapedAt })
    if (first.kind === 'copiers') {
      expect(first.copierLabel).toBe('各个班级')
      expect(first.copierPnl).toBeCloseTo(2267.26833, 4)
      // beginCopyTime 2026-04-21 → ~47 days before the 2026-06-12 scrape
      expect(first.copyDurationDays).toBeGreaterThan(40)
      expect(first.copyDurationDays).toBeLessThan(60)
      expect(first.copierInvested).toBeNull()
    }
    expect((first.raw as Record<string, unknown>).copy_total_pnl).toBe('4915.5927501606778108')
  })

  it('orders / transfers throw (not exposed publicly)', () => {
    expect(() => parseOkxHistory({}, 'orders', ctx)).toThrow('orders not supported')
    expect(() => parseOkxHistory({}, 'transfers', ctx)).toThrow('transfers not supported')
  })
})
