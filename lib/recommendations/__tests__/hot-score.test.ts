/**
 * A hot-trader ranking needs sealed historical change evidence. These tests
 * keep the current-cohort probe on the public view and ensure raw snapshots
 * never become a substitute proof.
 */

const mockResponses: Record<string, { data: unknown; error?: unknown }> = {}
const mockFrom = jest.fn((table: string) => {
  const response = mockResponses[table] ?? { data: [] }
  const promise = Promise.resolve({ data: response.data, error: response.error ?? null })
  const query: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'not', 'gt', 'or', 'order']) {
    query[method] = () => query
  }
  query.limit = () => promise
  query.then = (...args: Parameters<Promise<unknown>['then']>) => promise.then(...args)
  return query
})

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

import { computeHotTraders } from '../hot-score'

function publishedProbe(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'top-one',
    rank: 1,
    arena_score: 92,
    roi: 20,
    pnl: 200,
    win_rate: 60,
    max_drawdown: 12,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    season_id: '90D',
    ...overrides,
  }
}

beforeEach(() => {
  for (const key of Object.keys(mockResponses)) delete mockResponses[key]
  mockFrom.mockClear()
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-07-03T00:00:00Z'))
})

afterEach(() => jest.useRealTimers())

describe('computeHotTraders publication boundary', () => {
  it('uses only the sealed current cohort, then marks historical hotness partial', async () => {
    mockResponses.public_ranked_leaderboard = { data: [publishedProbe()] }

    await expect(computeHotTraders()).resolves.toEqual({
      traders: [],
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'historical_hot_evidence_unavailable',
      ranking_visibility_reasons: ['historical_hot_evidence_unavailable'],
    })

    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(mockFrom).not.toHaveBeenCalledWith('trader_daily_snapshots')
  })

  it('reports unknown when the current public cohort cannot be read', async () => {
    mockResponses.public_ranked_leaderboard = {
      data: null,
      error: { message: 'current cohort unavailable' },
    }

    await expect(computeHotTraders()).resolves.toEqual({
      traders: [],
      ranking_visibility: 'unknown',
      ranking_visibility_reason: 'public_cohort_unavailable',
      ranking_visibility_reasons: ['public_cohort_unavailable'],
    })
  })

  it('does not treat a malformed public-view boundary as proof', async () => {
    mockResponses.public_ranked_leaderboard = {
      data: [publishedProbe({ metrics_estimated: true })],
    }

    await expect(computeHotTraders()).resolves.toEqual({
      traders: [],
      ranking_visibility: 'unknown',
      ranking_visibility_reason: 'public_cohort_unavailable',
      ranking_visibility_reasons: ['public_cohort_unavailable'],
    })
  })

  it('does not treat an empty current view as a complete empty hot ranking', async () => {
    mockResponses.public_ranked_leaderboard = { data: [] }

    await expect(computeHotTraders()).resolves.toEqual({
      traders: [],
      ranking_visibility: 'unknown',
      ranking_visibility_reason: 'public_cohort_unavailable',
      ranking_visibility_reasons: ['public_cohort_unavailable'],
    })
  })
})
