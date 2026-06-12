/**
 * OKX Wallet web3 parser tests over real RAW fixtures (captured live
 * 2026-06-12 from web3.okx.com priapi, chainId=501 periodType=3).
 * board-page.json holds 4 real rows — a label-less-alias dev wallet and
 * three named KOLs; profile-summary.json is the dev wallet's 7D summary
 * whose totalPnl/totalPnlRoi reconcile exactly with its board row.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseOkxWeb3History,
  parseOkxWeb3LeaderboardPage,
  parseOkxWeb3Positions,
  parseOkxWeb3Profile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'okx_web3_solana',
  currency: 'USDC',
  tfLabelMap: { '1D': 1, '7D': 7, '1M': 30, '3M': 90 },
  scrapedAt: '2026-06-12T00:00:00.000Z',
  meta: {},
}

describe('parseOkxWeb3LeaderboardPage', () => {
  const fx = fixture('board-page.json') as { response: { data: unknown }; timeframe: number }
  const payload = { data: fx.response.data, timeframe: 7 }

  it('parses real rows: case-sensitive base58 identity, percent ROI/win rate', () => {
    const page = parseOkxWeb3LeaderboardPage(payload, ctx)
    expect(page.reportedTotal).toBe(3814)
    expect(page.rows).toHaveLength(4)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: '3CkgBB2ryzxQuSmzPSQ53jtVffPf1Wb1t1HBVs8GmGfw', // case kept!
      walletAddress: '3CkgBB2ryzxQuSmzPSQ53jtVffPf1Wb1t1HBVs8GmGfw',
      rank: 1,
      nickname: null, // empty alias + empty walletName → null
      avatarUrlOrigin: null,
      traderKind: 'human',
      traderMeta: { okx_web3_labels: ['dev'] }, // category chip (spec §11.18)
    })
    expect(page.rows[0].headlineRoi).toBeCloseTo(213.700576, 5) // already %
    expect(page.rows[0].headlinePnl).toBeCloseTo(64544.012921, 4)
    expect(page.rows[0].headlineWinRate).toBeCloseTo(22.5, 6)
  })

  it('named KOL rows keep walletName + icon + kol label', () => {
    const page = parseOkxWeb3LeaderboardPage(payload, ctx)
    expect(page.rows[1].nickname).toBe('Domy')
    expect(page.rows[1].traderMeta).toMatchObject({ okx_web3_labels: ['kol'] })
    expect(page.rows[1].avatarUrlOrigin).toMatch(/^https:\/\/static\.coinall\.ltd\//)
    // raw keeps the sparkline + topTokens verbatim (spec §3)
    expect(Array.isArray((page.rows[0].raw as Record<string, unknown>).pnlHistory)).toBe(true)
  })

  it('skips rows without a plausible base58 identity', () => {
    const page = parseOkxWeb3LeaderboardPage(
      { data: { rankingInfos: [{ walletAddress: 'short' }], totalCount: 1 }, timeframe: 7 },
      ctx
    )
    expect(page.rows).toHaveLength(0)
  })
})

describe('parseOkxWeb3Profile', () => {
  const fx = fixture('profile-summary.json') as { response: unknown; timeframe: number }

  it('summary → superset stats; reconciles exactly with the board row', () => {
    const profile = parseOkxWeb3Profile({ summary: fx.response, timeframe: 7 }, ctx)
    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s.timeframe).toBe(7)
    expect(s.pnl).toBeCloseTo(64544.012921, 4) // = board pnl
    expect(s.roi).toBeCloseTo(213.7, 2) // = board roi (already %)
    expect(s.winRate).toBeCloseTo(22.5, 6)
    expect(s.volume).toBeCloseTo(45193.604508 + 94747.02595, 3) // buy+sell
    expect(s.aum).toBeNull() // SOL balance is NOT an AUM → extras
    expect(s.extras.native_balance_usd as number).toBeGreaterThan(0)
    expect(s.extras.unrealized_pnl as number).toBeCloseTo(32820.132274, 4)
    expect(s.extras.txs_buy).toBe(272)
    // §11.18 preferred-market-cap + win-rate distribution survive
    expect(s.extras.mcap_txs_buy).toEqual([128, 144, 0, 0, 0])
    expect(s.extras.win_rate_distribution).toEqual([1, 8, 20, 4])
  })

  it('series: pnl_daily calendar points, ascending', () => {
    const profile = parseOkxWeb3Profile({ summary: fx.response, timeframe: 7 }, ctx)
    expect(profile.series).toHaveLength(1)
    const series = profile.series[0]
    expect(series.metric).toBe('pnl_daily')
    expect(series.points).toHaveLength(7)
    const ts = series.points.map((p) => p.ts)
    expect([...ts].sort()).toEqual(ts)
  })

  it('missing data → no stats, never throws', () => {
    const profile = parseOkxWeb3Profile({ summary: { code: 0, data: null }, timeframe: 30 }, ctx)
    expect(profile.stats).toHaveLength(0)
    expect(profile.series).toHaveLength(0)
  })
})

describe('unsupported surfaces', () => {
  it('positions/history throw', () => {
    expect(() => parseOkxWeb3Positions({}, ctx)).toThrow('not supported')
    expect(() => parseOkxWeb3History({}, 'orders', ctx)).toThrow('not supported')
  })
})
