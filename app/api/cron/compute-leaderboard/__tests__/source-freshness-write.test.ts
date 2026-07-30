/**
 * @jest-environment node
 */

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import {
  buildSourceFreshnessWriteRows,
  upsertSourceFreshness,
  zeroOutExcluded,
} from '../write-leaderboard'
import type { ScoredTrader } from '../score-traders'
import type { TraderRow } from '../trader-row'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function trader(source: string, sourceAsOf: string, id = 'trader-1'): ScoredTrader {
  return {
    source,
    source_trader_id: id,
    source_as_of: sourceAsOf,
    arena_score: 80,
    arena_score_v3: 75,
    arena_score_v4: 80,
    score_factors: null,
    roi: 25,
    pnl: 1_000,
    win_rate: 60,
    max_drawdown: 10,
    followers: 0,
    copiers: null,
    trades_count: 20,
    handle: null,
    avatar_url: '/logo-symbol.png',
    profitability_score: 70,
    risk_control_score: 70,
    execution_score: null,
    score_completeness: 'partial',
    trading_style: null,
    avg_holding_hours: null,
    style_confidence: null,
    sharpe_ratio: null,
    sortino_ratio: null,
    profit_factor: null,
    calmar_ratio: null,
    trader_type: 'human',
    metrics_estimated: false,
  }
}

describe('compute leaderboard source freshness writes', () => {
  it.each(['7D', '30D', '90D'] as const)('keeps the %s watermark isolated', (season) => {
    expect(
      buildSourceFreshnessWriteRows(
        season,
        [trader('source', '2026-07-18T11:00:00.000Z')],
        '2026-07-18T12:00:00.000Z'
      )[0]
    ).toEqual({
      season_id: season,
      source: 'source',
      source_as_of: '2026-07-18T11:00:00.000Z',
      recorded_at: '2026-07-18T12:00:00.000Z',
    })
  })

  it('keeps independent sources/windows and uses the oldest watermark in a mixed source board', () => {
    const rows = buildSourceFreshnessWriteRows(
      '30D',
      [
        trader('binance_futures', '2026-07-18T11:00:00.000Z', 'one'),
        trader('binance_futures', '2026-07-18T10:45:00.000Z', 'two'),
        trader('hyperliquid', '2026-07-18T11:30:00.000Z'),
      ],
      '2026-07-18T12:00:00.000Z'
    )

    expect(rows).toEqual([
      {
        season_id: '30D',
        source: 'binance_futures',
        source_as_of: '2026-07-18T10:45:00.000Z',
        recorded_at: '2026-07-18T12:00:00.000Z',
      },
      {
        season_id: '30D',
        source: 'hyperliquid',
        source_as_of: '2026-07-18T11:30:00.000Z',
        recorded_at: '2026-07-18T12:00:00.000Z',
      },
    ])
  })

  it('omits an absent source so its last-good database watermark is preserved', async () => {
    const upsert = jest.fn().mockResolvedValue({ error: null })
    const from = jest.fn(() => ({ upsert }))
    const sourceAsOf = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    await expect(
      upsertSourceFreshness({
        supabase: { from } as never,
        season: '90D',
        expectedSources: ['fresh_source'],
        sourceEvidence: [trader('fresh_source', sourceAsOf)],
      })
    ).resolves.toBe(1)

    expect(from).toHaveBeenCalledWith('leaderboard_source_freshness')
    expect(upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          season_id: '90D',
          source: 'fresh_source',
          source_as_of: sourceAsOf,
        }),
      ],
      { onConflict: 'season_id,source' }
    )
    expect(JSON.stringify(upsert.mock.calls)).not.toContain('absent_source')
  })

  it('seals a fresh zero-rank source from board evidence rather than scored rows', async () => {
    const upsert = jest.fn().mockResolvedValue({ error: null })
    const from = jest.fn(() => ({ upsert }))
    const sourceAsOf = new Date(Date.now() - 30 * 60 * 1000).toISOString()

    await expect(
      upsertSourceFreshness({
        supabase: { from } as never,
        season: '7D',
        expectedSources: ['fresh_but_no_eligible_rows'],
        sourceEvidence: [{ source: 'fresh_but_no_eligible_rows', source_as_of: sourceAsOf }],
      })
    ).resolves.toBe(1)
    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ source: 'fresh_but_no_eligible_rows', source_as_of: sourceAsOf })],
      { onConflict: 'season_id,source' }
    )
  })

  it('fails closed by skipping a source when any board watermark is invalid', () => {
    const rows = buildSourceFreshnessWriteRows(
      '7D',
      [
        trader('mixed_source', '2026-07-18T11:00:00.000Z', 'one'),
        trader('mixed_source', 'invalid', 'two'),
        trader('valid_source', '2026-07-18T10:00:00.000Z'),
      ],
      '2026-07-18T12:00:00.000Z'
    )

    expect(rows.map((row) => row.source)).toEqual(['valid_source'])
  })

  it('does not replace last-good state with a source timestamp from the future', () => {
    const rows = buildSourceFreshnessWriteRows(
      '7D',
      [
        trader('future_source', '2026-07-18T12:10:00.000Z'),
        trader('valid_source', '2026-07-18T12:04:00.000Z'),
      ],
      '2026-07-18T12:00:00.000Z'
    )

    expect(rows.map((row) => row.source)).toEqual(['valid_source'])
  })

  it('fails the whole freshness gate before writing when any finalized source is invalid', async () => {
    const from = jest.fn()

    await expect(
      upsertSourceFreshness({
        supabase: { from } as never,
        season: '30D',
        expectedSources: ['valid_source', 'invalid_source'],
        sourceEvidence: [
          trader('valid_source', '2026-07-18T11:00:00.000Z'),
          trader('invalid_source', 'not-a-timestamp'),
        ],
      })
    ).rejects.toThrow(
      '[30D] source freshness gate incomplete: 1/2 fresh sources have valid board watermarks'
    )
    expect(from).not.toHaveBeenCalled()
  })

  it('never reports an empty finalized cohort as a successful freshness gate', async () => {
    const from = jest.fn()

    await expect(
      upsertSourceFreshness({
        supabase: { from } as never,
        season: '7D',
        expectedSources: [],
        sourceEvidence: [],
      })
    ).rejects.toThrow('[7D] source freshness gate requires at least one fresh source')
    expect(from).not.toHaveBeenCalled()
  })

  it('surfaces a watermark write failure so the caller can retain the previous state', async () => {
    const upsert = jest.fn().mockResolvedValue({ error: { message: 'write failed' } })
    const from = jest.fn(() => ({ upsert }))
    const sourceAsOf = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    await expect(
      upsertSourceFreshness({
        supabase: { from } as never,
        season: '90D',
        expectedSources: ['source'],
        sourceEvidence: [trader('source', sourceAsOf)],
      })
    ).rejects.toThrow('source freshness upsert failed: write failed')
  })

  it('publishes the required watermark seal only after every cohort finalizer succeeds', () => {
    const route = readFileSync(
      join(process.cwd(), 'app/api/cron/compute-leaderboard/route.ts'),
      'utf8'
    )
    const completeWriteGuard = route.indexOf('if (upsertAborted || upsertErrors > 0)')
    const zeroOut = route.indexOf('await zeroOutExcluded({', completeWriteGuard)
    const atomicCleanup = route.indexOf('await atomicPlatformCleanup(', zeroOut)
    const rerank = route.indexOf('await rerankAllRows(', atomicCleanup)
    const publish = route.indexOf('await upsertSourceFreshness({', rerank)
    const publishLog = route.indexOf('logger.info(', publish)

    expect(completeWriteGuard).toBeGreaterThan(-1)
    expect(route.slice(completeWriteGuard, zeroOut)).toContain('throw new Error(')
    expect(zeroOut).toBeGreaterThan(completeWriteGuard)
    expect(atomicCleanup).toBeGreaterThan(zeroOut)
    expect(rerank).toBeGreaterThan(atomicCleanup)
    expect(publish).toBeGreaterThan(rerank)
    expect(publishLog).toBeGreaterThan(publish)
    expect(route.slice(publish, publishLog)).not.toMatch(/\b(?:try|catch)\b/)
    expect(route).not.toContain('source freshness publish failed')
    expect(route).toContain('source_as_of: trader.source_board_as_of')
    expect(route.slice(publish, publishLog)).toContain('expectedSources: freshRankingPlatforms')
    expect(route.slice(publish, publishLog)).toContain('sourceEvidence: freshSourceEvidence')
  })

  it('does not rescore stale source inputs while preserving their last-good rows', () => {
    const route = readFileSync(
      join(process.cwd(), 'app/api/cron/compute-leaderboard/route.ts'),
      'utf8'
    )

    expect(route).toContain('const freshPlatformSet = new Set(freshPlatforms)')
    expect(route).toContain('.filter((t) => freshPlatformSet.has(t.source))')
  })

  it('never zeroes a stale source while cleaning excluded rows from fresh sources', async () => {
    const gt = jest.fn().mockResolvedValue({ error: null })
    const inIds = jest.fn(() => ({ gt }))
    const sourceEq = jest.fn(() => ({ in: inIds }))
    const seasonEq = jest.fn(() => ({ eq: sourceEq }))
    const update = jest.fn(() => ({ eq: seasonEq }))
    const from = jest.fn(() => ({ update }))
    const traderMap = new Map<string, TraderRow>([
      ['fresh:excluded', { source: 'fresh', source_trader_id: 'excluded' } as TraderRow],
      ['stale:last-good', { source: 'stale', source_trader_id: 'last-good' } as TraderRow],
    ])

    await expect(
      zeroOutExcluded({
        supabase: { from } as never,
        season: '90D',
        uniqueTraders: [],
        traderMap,
        freshPlatforms: ['fresh'],
        isOutOfTime: () => false,
        upsertAborted: false,
        timeLeftMs: () => 60_000,
      })
    ).resolves.toBe(1)

    expect(sourceEq).toHaveBeenCalledWith('source', 'fresh')
    expect(inIds).toHaveBeenCalledWith('source_trader_id', ['excluded'])
    expect(JSON.stringify(sourceEq.mock.calls)).not.toContain('stale')
    expect(JSON.stringify(inIds.mock.calls)).not.toContain('last-good')
  })
})
