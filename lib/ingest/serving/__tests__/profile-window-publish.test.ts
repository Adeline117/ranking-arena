import type { ParsedProfile, SourceRow } from '../../core/types'

const query = jest.fn()
const release = jest.fn()

jest.mock('../../db', () => ({
  ingestClientConnect: jest.fn(async () => ({ query, release })),
  getIngestPool: jest.fn(),
}))

import { publishProfile } from '../publish'

const src = { id: 34, slug: 'gtrade', currency: 'USDC' } as SourceRow

function profile(extras: Record<string, unknown>): ParsedProfile {
  return {
    nickname: null,
    avatarUrlOrigin: null,
    stats: [
      {
        timeframe: 30,
        asOf: '2026-07-15T12:00:00.000Z',
        roi: null,
        pnl: 123,
        sharpe: null,
        mdd: null,
        winRate: 50,
        winPositions: 1,
        totalPositions: 2,
        copierPnl: null,
        copierCount: null,
        aum: null,
        volume: null,
        profitShareRate: null,
        holdingDurationAvgHours: null,
        tradingPreferences: null,
        extras,
      },
    ],
    replaceSeries: [{ timeframe: 30, metrics: ['pnl'] }],
    series: [
      {
        timeframe: 30,
        metric: 'pnl',
        points: Array.from({ length: 9 }, (_, index) => ({
          ts: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
          value: index * 10,
        })),
      },
    ],
  }
}

describe('publishProfile whole-window coverage gate', () => {
  beforeEach(() => {
    query.mockReset()
    release.mockReset()
    query.mockResolvedValue({ rows: [], rowCount: 1 })
  })

  it('merges only failure evidence and blocks stats, risk derivation, and series', async () => {
    const parsed = profile({
      profile_window_metrics_complete: false,
      gtrade_trades_incomplete_reason: 'window_prefix_not_covered',
    })

    await publishProfile(src, 42, parsed, { fullSeries: true })

    const sql = query.mock.calls.map(([statement]) => String(statement))
    expect(sql.map((statement) => statement.trim().split('\n')[0])).toEqual([
      'BEGIN',
      'UPDATE arena.trader_stats',
      'COMMIT',
    ])
    expect(sql.some((statement) => statement.includes('INSERT INTO arena.trader_stats'))).toBe(
      false
    )
    expect(sql.some((statement) => statement.includes('INSERT INTO arena.trader_series'))).toBe(
      false
    )
    const updateParams = query.mock.calls[1][1] as unknown[]
    expect(updateParams.slice(0, 2)).toEqual([42, 30])
    expect(JSON.parse(String(updateParams[2]))).toEqual({
      profile_window_metrics_complete: false,
      gtrade_trades_incomplete_reason: 'window_prefix_not_covered',
    })
    expect(updateParams[3]).toBe('2026-07-15T12:00:00.000Z')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('publishes typed metrics and series after a complete retry', async () => {
    await publishProfile(src, 42, profile({ profile_window_metrics_complete: true }), {
      fullSeries: true,
    })

    const sql = query.mock.calls.map(([statement]) => String(statement))
    expect(sql.some((statement) => statement.includes('INSERT INTO arena.trader_stats'))).toBe(true)
    expect(sql.some((statement) => statement.includes('INSERT INTO arena.trader_series'))).toBe(
      true
    )
    expect(sql.some((statement) => statement.includes('DELETE FROM arena.trader_series\n'))).toBe(
      true
    )
    expect(sql.some((statement) => statement.includes('arena.trader_series_weekly'))).toBe(true)
    expect(sql.map((statement) => statement.trim())).toContain('COMMIT')
  })

  it('clears both old series stores for a confirmed empty replacement', async () => {
    const parsed = profile({ profile_window_metrics_complete: true })
    parsed.series = []

    await publishProfile(src, 42, parsed, { fullSeries: true })

    const sql = query.mock.calls.map(([statement]) => String(statement))
    expect(
      sql.filter((statement) => statement.includes('DELETE FROM arena.trader_series'))
    ).toHaveLength(2)
    expect(sql.some((statement) => statement.includes('INSERT INTO arena.trader_series ('))).toBe(
      false
    )
    expect(sql.map((statement) => statement.trim())).toContain('COMMIT')
  })

  it('keeps a rich series when a long-tail publish stores only its latest point', async () => {
    const parsed = profile({ profile_window_metrics_complete: true })

    await publishProfile(src, 42, parsed, { fullSeries: false })

    const sql = query.mock.calls.map(([statement]) => String(statement))
    expect(sql.some((statement) => statement.includes('DELETE FROM arena.trader_series'))).toBe(
      false
    )
    const insertCall = query.mock.calls.find(([statement]) =>
      String(statement).includes('INSERT INTO arena.trader_series (')
    )
    expect(insertCall).toBeDefined()
    expect(JSON.parse(String((insertCall?.[1] as unknown[])[4]))).toEqual([
      parsed.series[0].points.at(-1),
    ])
  })

  it('still clears a confirmed empty replacement on the long-tail path', async () => {
    const parsed = profile({ profile_window_metrics_complete: true })
    parsed.series = []

    await publishProfile(src, 42, parsed, { fullSeries: false })

    const sql = query.mock.calls.map(([statement]) => String(statement))
    expect(
      sql.filter((statement) => statement.includes('DELETE FROM arena.trader_series'))
    ).toHaveLength(2)
    expect(sql.some((statement) => statement.includes('INSERT INTO arena.trader_series ('))).toBe(
      false
    )
  })

  it('clears only empty metrics from a mixed long-tail replacement', async () => {
    const parsed = profile({ profile_window_metrics_complete: true })
    parsed.replaceSeries = [{ timeframe: 30, metrics: ['pnl', 'account_value'] }]

    await publishProfile(src, 42, parsed, { fullSeries: false })

    const deleteCalls = query.mock.calls.filter(([statement]) =>
      String(statement).includes('DELETE FROM arena.trader_series')
    )
    expect(deleteCalls).toHaveLength(2)
    expect(deleteCalls.map(([, params]) => (params as unknown[])[2])).toEqual([
      ['account_value'],
      ['account_value'],
    ])
  })

  it('keeps partial Hyperliquid fills conservative while publishing independent fields', async () => {
    await publishProfile(
      { ...src, slug: 'hyperliquid' },
      42,
      profile({ fills_metrics_complete: false }),
      { fullSeries: true }
    )

    const statsCall = query.mock.calls.find(([statement]) =>
      String(statement).includes('INSERT INTO arena.trader_stats')
    )
    expect(statsCall).toBeDefined()
    expect((statsCall?.[1] as unknown[]).at(-1)).toBe(true)
    expect(String(statsCall?.[0])).toContain('THEN LEAST(arena.trader_stats.as_of, EXCLUDED.as_of)')
    expect(String(statsCall?.[0])).toContain("'_arena_profile_publication_epoch_ms'")
    expect(JSON.parse(String((statsCall?.[1] as unknown[])[18]))).toMatchObject({
      fills_metrics_complete: false,
      _arena_profile_publication_epoch_ms: Date.parse('2026-07-15T12:00:00.000Z'),
    })
  })

  it('rolls back a stale profile before it can replace newer series', async () => {
    query.mockImplementation(async (statement: string) => {
      if (statement.includes('INSERT INTO arena.trader_stats')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    })

    await expect(
      publishProfile(src, 42, profile({ profile_window_metrics_complete: true }), {
        fullSeries: true,
      })
    ).rejects.toMatchObject({ name: 'StaleProfilePublicationError' })

    const sql = query.mock.calls.map(([statement]) => String(statement))
    expect(sql.some((statement) => statement.includes('DELETE FROM arena.trader_series'))).toBe(
      false
    )
    expect(sql.some((statement) => statement.includes('INSERT INTO arena.trader_series ('))).toBe(
      false
    )
    expect(sql.map((statement) => statement.trim())).toContain('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rolls back when the evidence-only update fails', async () => {
    query.mockImplementation(async (statement: string) => {
      if (statement.includes('UPDATE arena.trader_stats')) throw new Error('update failed')
      return { rows: [], rowCount: 1 }
    })

    await expect(
      publishProfile(src, 42, profile({ profile_window_metrics_complete: false }), {
        fullSeries: true,
      })
    ).rejects.toThrow('update failed')
    expect(query.mock.calls.map(([statement]) => String(statement).trim())).toContain('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(1)
  })
})
