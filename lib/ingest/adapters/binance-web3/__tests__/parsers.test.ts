/**
 * Binance Wallet web3 parser tests over a real RAW fixture (captured live
 * 2026-06-12 from the public bapi leaderboard/query endpoint, chainId=56
 * period=7d tag=ALL). board-page.json holds 4 real rows plus a KOL
 * membership set that includes row[1]'s address — exercising the
 * traderMeta.binance_web3_kol flag path.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseBinanceWeb3History,
  parseBinanceWeb3LeaderboardPage,
  parseBinanceWeb3Positions,
  parseBinanceWeb3Profile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'binance_web3_bsc',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-12T00:00:00.000Z',
  meta: {},
}

describe('parseBinanceWeb3LeaderboardPage', () => {
  const payload = fixture('board-page.json')

  it('parses real rows: wallet identity, fraction→percent ROI/win rate', () => {
    const page = parseBinanceWeb3LeaderboardPage(payload, ctx)
    expect(page.rows).toHaveLength(4)
    expect(page.reportedTotal).toBeNull() // endpoint reports pages, not rows
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '0xffae19561c038747c5c9f79f7777c29f28c4b4ad',
      walletAddress: '0xffae19561c038747c5c9f79f7777c29f28c4b4ad',
      rank: 1,
      nickname: null,
      avatarUrlOrigin: null,
      traderKind: 'human',
      botStrategy: null,
      traderMeta: null, // not a KOL, no twitter
    })
    // realizedPnlPercent 0.5179739614962856 (fraction) → 51.797…%
    expect(page.rows[0].headlineRoi).toBeCloseTo(51.79739614962856, 6)
    expect(page.rows[0].headlinePnl).toBeCloseTo(59312.259257, 4)
    expect(page.rows[0].headlineWinRate).toBeCloseTo(47.37, 6)
    // Board-backfill: AUM (balance) + volume + on-chain extras → trader_stats
    expect(typeof page.rows[0].headlineAum).toBe('number')
    expect(typeof page.rows[0].headlineVolume).toBe('number')
    expect(page.rows[0].headlineExtras).toBeTruthy()
    expect(typeof page.rows[0].headlineExtras?.total_traded_tokens).toBe('number')
  })

  it('flags KOL membership from the embedded session set', () => {
    const page = parseBinanceWeb3LeaderboardPage(payload, ctx)
    expect(page.rows[1].exchangeTraderId).toBe('0x2b98a23bd28e0ea02f4402b4e553c63403d43115')
    expect(page.rows[1].traderMeta).toMatchObject({ binance_web3_kol: true })
    // non-KOL rows carry no flag at all (null collapses)
    expect(page.rows[2].traderMeta).toBeNull()
  })

  it('keeps the §11.7 PnL-bucket distribution + daily sparkline in raw', () => {
    const page = parseBinanceWeb3LeaderboardPage(payload, ctx)
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(raw.tokenDistribution).toMatchObject({
      gt500Cnt: 0,
      between0And500Cnt: 9,
      between0AndNegative50Cnt: 10,
      ltNegative50Cnt: 0,
    })
    expect(Array.isArray(raw.dailyPNL)).toBe(true)
    expect((raw.dailyPNL as unknown[]).length).toBe(7)
    // BNB balance stays raw-only (it is NOT a USD AUM)
    expect(raw.balance).toBe('0.011937466524736082')
  })

  it('promotes §2.5d structured blocks into headlineExtras', () => {
    const page = parseBinanceWeb3LeaderboardPage(payload, ctx)
    const ext = page.rows[0].headlineExtras as Record<string, unknown>
    // token distribution → clean keys, counts preserved
    expect(ext.token_distribution).toMatchObject({ gt_500: 0, p0_500: 9, n50_0: 10, lt_n50: 0 })
    // PnL calendar → [{date, pnl}] sorted, length matches dailyPNL
    const cal = ext.pnl_calendar as Array<{ date: string; pnl: number }>
    expect(Array.isArray(cal)).toBe(true)
    expect(cal.length).toBe(7)
    expect(typeof cal[0].date).toBe('string')
    expect(typeof cal[0].pnl).toBe('number')
    expect([...cal].sort((a, b) => a.date.localeCompare(b.date))).toEqual(cal) // sorted
    // top earning tokens → normalized, profitRate fraction → percent
    const top = ext.top_earning_tokens as Array<Record<string, unknown>>
    expect(Array.isArray(top)).toBe(true)
    expect(top.length).toBe(3)
    expect(typeof top[0].symbol).toBe('string')
    expect(typeof top[0].profit_pct).toBe('number')
    // buy/sell granularity surfaced
    expect(typeof ext.buy_txns).toBe('number')
    expect(typeof ext.sell_txns).toBe('number')
  })

  it('skips rows without a 0x identity; empty payload yields no rows', () => {
    const board = (payload.board ?? {}) as { data?: { data?: unknown[] } }
    const doctored = {
      board: { ...board, data: { ...board.data, data: [{ address: null }, { address: 'abc' }] } },
      kolAddresses: [],
      timeframe: 7,
    }
    expect(parseBinanceWeb3LeaderboardPage(doctored, ctx).rows).toHaveLength(0)
    expect(parseBinanceWeb3LeaderboardPage({}, ctx).rows).toHaveLength(0)
  })
})

describe('unsupported surfaces (Tier-A-only source)', () => {
  it('profile/positions/history all throw', () => {
    expect(() => parseBinanceWeb3Profile({}, ctx)).toThrow('not supported')
    expect(() => parseBinanceWeb3Positions({}, ctx)).toThrow('not supported')
    expect(() => parseBinanceWeb3History({}, 'orders', ctx)).toThrow('not supported')
  })
})
