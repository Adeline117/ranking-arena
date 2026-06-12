import { readFileSync } from 'fs'
import { join } from 'path'
import { bingxPerTfExtras, parseBingxLeaderboardPage } from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctxTf = (tf: number): ParseCtx => ({
  sourceSlug: 'bingx_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: { timeframe: tf },
})

describe('parseBingxLeaderboardPage', () => {
  it('parses trader/search rows for the 30d timeframe', () => {
    const page = parseBingxLeaderboardPage(fixture('search.json'), ctxTf(30))
    expect(page.reportedTotal).toBe(2008)
    expect(page.rows.length).toBe(3)
    const first = page.rows[0]
    expect(first.exchangeTraderId).toBe('1998800000134045')
    expect(first.rank).toBe(1)
    expect(first.nickname).toBeTruthy()
    expect(first.traderKind).toBe('human')
    // strRecent30DaysRate "+1,052.28%" → 1052.28
    expect(first.headlineRoi).toBeCloseTo(1052.28, 2)
    // cumulativeProfitLoss30d
    expect(first.headlinePnl).toBeCloseTo(126.27, 2)
    // winRate30d 1 → 100%
    expect(first.headlineWinRate).toBeCloseTo(100, 5)
    // apiIdentity + risk rating on traderMeta (spec §11.12)
    expect(first.traderMeta).toMatchObject({
      bingx_api_identity: '1579905006518878200',
      risk_rating: 7,
    })
  })

  it('selects the correct TF fields for 7d vs 90d', () => {
    const p7 = parseBingxLeaderboardPage(fixture('search.json'), ctxTf(7))
    const p90 = parseBingxLeaderboardPage(fixture('search.json'), ctxTf(90))
    // strRecent7DaysRate "+31.08%" vs strRecent90DaysRate "+1,052.28%"
    expect(p7.rows[0].headlineRoi).toBeCloseTo(31.08, 2)
    expect(p90.rows[0].headlineRoi).toBeCloseTo(1052.28, 2)
    // 7d risk rating differs from 30d
    expect(p7.rows[0].traderMeta).toMatchObject({ risk_rating: 5 })
  })

  it('returns empty on malformed payloads', () => {
    expect(parseBingxLeaderboardPage({}, ctxTf(30)).rows).toHaveLength(0)
    expect(parseBingxLeaderboardPage({ data: { result: 'x' } }, ctxTf(30)).rows).toHaveLength(0)
  })
})

describe('bingxPerTfExtras', () => {
  it('extracts per-TF sharpe/mdd/risk', () => {
    const row = (
      fixture('search.json') as { data: { result: Array<{ rankStat: Record<string, unknown> }> } }
    ).data.result[0].rankStat
    const e30 = bingxPerTfExtras(row, 30)
    expect(e30.sharpe).toBeCloseTo(-0.94, 2)
    expect(e30.mdd).toBeCloseTo(52.63, 1)
    expect(e30.risk_rating).toBe(7)
  })
})
