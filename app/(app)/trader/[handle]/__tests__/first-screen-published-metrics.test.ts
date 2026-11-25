/**
 * First-screen win rate / max drawdown are the published ranking values.
 *
 * The raw board rows below are the first row of the repo's real adapter
 * fixtures. All three exchanges send these metrics as FRACTIONS; a page that
 * printed them through its percent formatter showed e.g. "-0.3%" for a 29.7%
 * drawdown. After the public overlay they must equal what the ranking
 * publishes, and the summary must print that.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectBoardExtras } from '@/lib/data/serving/board-extras'
import { overlayPublicFirstScreenRanking } from '@/lib/data/serving/first-screen'
import type { TraderFirstScreen } from '@/lib/data/serving/types'
import type { PublicProfileRankingResult } from '@/lib/data/trader/public-profile-ranking'
import { buildTraderSummaryRows } from '../TraderServerSummary'

function firstBoardRow(fixture: string): Record<string, unknown> {
  const find = (value: unknown): Record<string, unknown> | null => {
    if (Array.isArray(value)) {
      return value.length > 0 && typeof value[0] === 'object' && value[0] !== null
        ? (value[0] as Record<string, unknown>)
        : null
    }
    if (typeof value === 'object' && value !== null) {
      for (const child of Object.values(value)) {
        const found = find(child)
        if (found) return found
      }
    }
    return null
  }
  const row = find(
    JSON.parse(readFileSync(join(process.cwd(), 'lib/ingest/adapters', fixture), 'utf8'))
  )
  if (!row) throw new Error(`no board row in ${fixture}`)
  return row
}

function firstScreen(source: string, raw: Record<string, unknown>): TraderFirstScreen {
  return {
    source,
    exchangeTraderId: 'trader-1',
    nickname: 'Trader',
    avatarMirrorUrl: null,
    avatarOriginUrl: null,
    avatarSrc: null,
    walletAddress: null,
    traderKind: 'human',
    botStrategy: null,
    entries: [
      {
        timeframe: 30,
        rank: 1,
        rankingVisibility: 'unknown',
        rankingVisibilityReason: null,
        headlineRoi: 1,
        headlinePnl: null,
        // What a consumer falls back to when the board parser left it empty.
        headlineWinRate: null,
        extras: projectBoardExtras(source, raw),
        provenance: { source, asOf: '2026-11-25T00:00:00.000Z' },
      },
    ],
  } as TraderFirstScreen
}

function published(
  source: string,
  metrics: { win_rate: number | null; max_drawdown: number | null }
): PublicProfileRankingResult {
  return {
    rows: [
      { source, source_trader_id: 'trader-1', season_id: '30D', rank: 7, roi: 12.5, ...metrics },
    ],
    rankingVisibility: 'partial',
    rankingVisibilityReason: 'public_period_not_published',
  }
}

const t = (key: string) => key

describe.each([
  [
    'htx_futures',
    'htx/__tests__/fixtures/rank-futures-p1.json',
    { win_rate: 100, max_drawdown: 12.53 },
  ],
  [
    'gate_futures',
    'gate/__tests__/fixtures/leaderboard-fut-p1.json',
    { win_rate: 50, max_drawdown: 29.7 },
  ],
  [
    'blofin_futures',
    'blofin/__tests__/fixtures/board-fut-7.json',
    { win_rate: 61, max_drawdown: 71.15 },
  ],
])('%s board row (%s)', (source, fixture, metrics) => {
  const raw = firstBoardRow(fixture)
  const rawExtras = projectBoardExtras(source, raw)

  it('really is a fractional raw value — the thing that must not be rendered', () => {
    expect(typeof rawExtras.mdd).toBe('number')
    expect(rawExtras.mdd as number).toBeLessThan(2)
  })

  it('shows the published win rate and drawdown, not the raw fractions', () => {
    const entry = overlayPublicFirstScreenRanking(
      firstScreen(source, raw),
      published(source, metrics)
    ).entries[0]

    expect(entry.extras.mdd).toBe(metrics.max_drawdown)
    expect(entry.extras.win_rate).toBe(metrics.win_rate)
    expect(entry.headlineWinRate).toBe(metrics.win_rate)

    // What the server summary prints from those values.
    const rows = buildTraderSummaryRows(
      { winRate: entry.headlineWinRate, maxDrawdown: entry.extras.mdd as number },
      t
    )
    expect(rows.find((row) => row.key === 'mdd')?.value).toBe(
      `-${metrics.max_drawdown.toFixed(1)}%`
    )
    expect(rows.find((row) => row.key === 'win')?.value).toBe(`${metrics.win_rate.toFixed(1)}%`)
  })

  it('shows neither when the ranking publishes neither, instead of falling back to raw', () => {
    const entry = overlayPublicFirstScreenRanking(
      firstScreen(source, raw),
      published(source, { win_rate: null, max_drawdown: null })
    ).entries[0]

    expect('mdd' in entry.extras).toBe(false)
    expect('win_rate' in entry.extras).toBe(false)
    expect(entry.headlineWinRate).toBeNull()
    expect(
      buildTraderSummaryRows({ winRate: entry.headlineWinRate, maxDrawdown: undefined }, t).map(
        (row) => row.key
      )
    ).toEqual([])
  })

  it('shows neither when the trader is not on the board at all', () => {
    const entry = overlayPublicFirstScreenRanking(firstScreen(source, raw), {
      rows: [],
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_rank_unavailable',
    }).entries[0]

    expect('mdd' in entry.extras).toBe(false)
    expect('win_rate' in entry.extras).toBe(false)
    expect(entry.headlineWinRate).toBeNull()
    expect(entry.rank).toBeNull()
  })
})

it('keeps the copier count, which is not a percentage and is not replaced', () => {
  const entry = overlayPublicFirstScreenRanking(
    firstScreen('some_exchange', { copiers: 14, winRate: 0.5 }),
    published('some_exchange', { win_rate: 50, max_drawdown: null })
  ).entries[0]
  expect(entry.extras).toEqual({ copier_count: 14, win_rate: 50 })
})
