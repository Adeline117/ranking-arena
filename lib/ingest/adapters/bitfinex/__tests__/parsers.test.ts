/**
 * Bitfinex parser tests over a real RAW fixture (captured live 2026-06-12
 * from api-pub.bitfinex.com/v2/rankings {key}:1w:tGLOBAL:USD/hist).
 * board-page.json is the composite payload the adapter stores: the
 * plu_diff board's latest snapshot (top 4 rows) plus the plu/plr/vol
 * latest snapshots filtered to those usernames — plu joins 4/4, plr and
 * vol only 1/4 ("Heika"), exercising both extras hit and miss paths.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseBitfinexHistory,
  parseBitfinexLeaderboardPage,
  parseBitfinexPositions,
  parseBitfinexProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'bitfinex',
  currency: 'USD',
  tfLabelMap: {},
  scrapedAt: '2026-06-12T00:00:00.000Z',
  meta: {},
}

describe('parseBitfinexLeaderboardPage', () => {
  const payload = fixture('board-page.json')

  it('parses real rows: username identity, rank and USD window delta', () => {
    const page = parseBitfinexLeaderboardPage(payload, ctx)
    expect(page.rows).toHaveLength(4)
    expect(page.reportedTotal).toBe(4)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: 'ubris',
      nickname: 'ubris',
      rank: 1,
      avatarUrlOrigin: null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: null, // absolute USD values only — no ROI on this API
      headlineWinRate: null,
      traderMeta: null,
    })
    expect(page.rows[0].headlinePnl).toBeCloseTo(2_915_845.7, 2)
    expect(page.rows[3]).toMatchObject({ exchangeTraderId: 'gazouuu', rank: 4 })
  })

  it('joins plu/plr/vol extras by username; misses stay absent', () => {
    const page = parseBitfinexLeaderboardPage(payload, ctx)
    const heika = page.rows.find((r) => r.exchangeTraderId === 'Heika')!
    expect(heika.raw.extras).toMatchObject({
      plu: -465_227.77,
      plr: -124_139.27,
      vol: 27_003_442.59,
    })
    // ubris appears on plu only — no plr/vol keys at all (NULL-collapse)
    const ubris = page.rows[0].raw.extras as Record<string, number>
    expect(ubris.plu).toBeCloseTo(-144_636_104.57, 2)
    expect('plr' in ubris).toBe(false)
    expect('vol' in ubris).toBe(false)
  })

  it('keeps the verbatim API array + snapshot provenance in raw', () => {
    const page = parseBitfinexLeaderboardPage(payload, ctx)
    const raw = page.rows[0].raw as { row: unknown[]; board_key: string; snapshot_ts: number }
    expect(raw.board_key).toBe('plu_diff')
    expect(raw.snapshot_ts).toBe(1780876800000)
    expect(raw.row[0]).toBe(1780876800000) // mts
    expect(raw.row[2]).toBe('ubris') // username
    expect(raw.row[8]).toBe(0) // unmapped badge-ish int, preserved
  })

  it('prefers the embedded pre-truncation reportedTotal (smoke runs)', () => {
    const page = parseBitfinexLeaderboardPage({ ...payload, reportedTotal: 212 }, ctx)
    expect(page.rows).toHaveLength(4)
    expect(page.reportedTotal).toBe(212)
  })

  it('skips rows without a username; empty/garbage payloads yield no rows', () => {
    const doctored = {
      boardKey: 'plu_diff',
      boards: {
        plu_diff: { ts: 1, rows: [[1, null, '', 1, null, null, 5], [1, null, null, 2], 'junk'] },
      },
    }
    expect(parseBitfinexLeaderboardPage(doctored, ctx).rows).toHaveLength(0)
    expect(parseBitfinexLeaderboardPage(null, ctx).rows).toHaveLength(0)
    expect(parseBitfinexLeaderboardPage({}, ctx).rows).toHaveLength(0)
  })

  it('falls back to positional rank when the rank index is malformed', () => {
    const doctored = {
      boardKey: 'plu_diff',
      boards: { plu_diff: { ts: 1, rows: [[1, null, 'solo', 'NaN-rank', null, null, 7.5]] } },
    }
    const page = parseBitfinexLeaderboardPage(doctored, ctx)
    expect(page.rows[0]).toMatchObject({ exchangeTraderId: 'solo', rank: 1 })
    expect(page.rows[0].headlinePnl).toBe(7.5)
  })
})

describe('unsupported surfaces (Tier-A-only source)', () => {
  it('profile / positions / history parsers throw', () => {
    expect(() => parseBitfinexProfile({}, ctx)).toThrow('not supported')
    expect(() => parseBitfinexPositions({}, ctx)).toThrow('not supported')
    expect(() => parseBitfinexHistory({}, 'orders', ctx)).toThrow('orders not supported')
  })
})
