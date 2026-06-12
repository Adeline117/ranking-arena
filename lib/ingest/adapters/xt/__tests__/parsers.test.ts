import { readFileSync } from 'fs'
import { join } from 'path'
import { isXtDegeneratePage, parseXtLeaderboardPage, parseXtProfile } from '../parsers'
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

describe('parseXtLeaderboardPage', () => {
  it('parses the futures board (returnCode envelope, decimal rates)', () => {
    const page = parseXtLeaderboardPage(fixture('leaderboard-fut-30.json'), ctx)
    expect(page.reportedTotal).toBeNull()
    expect(page.rows.length).toBe(3)
    const first = page.rows[0]
    expect(first.exchangeTraderId).toBe('8305081452527')
    expect(first.rank).toBe(1)
    expect(first.nickname).toBe('阿阳')
    expect(first.traderKind).toBe('human')
    // incomeRate 11.2471 (decimal) → 1124.71%
    expect(first.headlineRoi).toBeCloseTo(1124.71, 1)
    expect(first.headlinePnl).toBeCloseTo(175.4, 1)
    // winRate 0.6461 → 64.61%
    expect(first.headlineWinRate).toBeCloseTo(64.61, 2)
    // Lvl badge → traderMeta
    expect(first.traderMeta).toMatchObject({ xt_level: 1, xt_level_name: 'Lvl 1' })
    // chart series preserved verbatim in raw
    expect(Array.isArray((first.raw as { chart?: unknown[] }).chart)).toBe(true)
  })

  it('parses the spot board (rc envelope, string accountId)', () => {
    const page = parseXtLeaderboardPage(fixture('leaderboard-spot-30.json'), {
      ...ctx,
      sourceSlug: 'xt_spot',
    })
    expect(page.rows.length).toBe(3)
    expect(page.rows[0].exchangeTraderId).toBe('4612466590349457382')
    expect(page.rows[0].headlineWinRate).toBeCloseTo(0, 5)
  })

  it('re-anchors rank from page position only', () => {
    const page = parseXtLeaderboardPage(fixture('leaderboard-fut-7.json'), ctx)
    expect(page.rows.map((r) => r.rank)).toEqual([1, 2])
  })

  it('returns empty on malformed payloads', () => {
    expect(parseXtLeaderboardPage({}, ctx).rows).toHaveLength(0)
    expect(parseXtLeaderboardPage({ result: { items: 'x' } }, ctx).rows).toHaveLength(0)
  })
})

describe('isXtDegeneratePage (spec §5.6 XT-spot rule)', () => {
  it('flags an all-zero placeholder page', () => {
    const payload = {
      result: {
        items: [
          { accountId: '1', income: '0', incomeRate: '0', winRate: '0' },
          { accountId: '2', income: '0', incomeRate: '0', winRate: '0' },
        ],
      },
    }
    expect(isXtDegeneratePage(payload)).toBe(true)
  })

  it('does not flag a page with any real trader', () => {
    const payload = {
      result: {
        items: [
          { accountId: '1', income: '0', incomeRate: '0', winRate: '0' },
          { accountId: '2', income: '12.3', incomeRate: '0.4', winRate: '0.5' },
        ],
      },
    }
    expect(isXtDegeneratePage(payload)).toBe(false)
  })

  it('does not flag an empty page (handled by the empty-page stop)', () => {
    expect(isXtDegeneratePage({ result: { items: [] } })).toBe(false)
  })

  it('flags the real futures board as non-degenerate', () => {
    expect(isXtDegeneratePage(fixture('leaderboard-fut-30.json'))).toBe(false)
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
    expect(profile.nickname).toBe('阿阳')
    expect(profile.series).toHaveLength(0)
  })

  it('survives an empty detail payload', () => {
    const profile = parseXtProfile({ detail: {}, timeframe: 7 }, ctx)
    expect(profile.stats).toHaveLength(0)
  })
})
