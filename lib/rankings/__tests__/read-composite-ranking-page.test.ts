import type { SealedLeaderboardPublicationProofSet } from '@/lib/rankings/read-publication-proofs'
import type { SealedCompositeRankingPublicationSet } from '@/lib/rankings/read-sealed-composite-ranking-generation'
import { getPool } from '@/lib/db'
import {
  COMPOSITE_RANKING_STATEMENT_TIMEOUT_MS,
  readCompositeRankingPage,
  readCompositeRankingPageWithDatabaseTimeout,
} from '@/lib/rankings/read-composite-ranking-page'

jest.mock('@/lib/db', () => ({ getPool: jest.fn() }))
const mockGetPool = jest.mocked(getPool)
const mockPoolConnect = jest.fn()

const COHORTS = {
  '7D': '11111111-1111-4111-8111-111111111111',
  '30D': '22222222-2222-4222-8222-222222222222',
  '90D': '33333333-3333-4333-8333-333333333333',
} as const
const SOURCES = ['binance_futures', 'hyperliquid'] as const

function seasonPublication(season: keyof typeof COHORTS): SealedLeaderboardPublicationProofSet {
  return {
    state: 'sealed',
    season,
    scoreCohortId: COHORTS[season],
    proofs: SOURCES.map((source, index) => ({
      season_id: season,
      source,
      source_as_of: '2026-07-29T10:00:00.000000Z',
      recorded_at: '2026-07-29T10:01:00.000000Z',
      score_cohort_id: COHORTS[season],
      rank_mutation_seq: 9,
      current_mutation_seq: 9,
      published_rank_count: 1,
      published_identity_sha256: (index === 0 ? 'a' : 'b').repeat(64),
      is_sealed: true,
    })),
  }
}

const publication: SealedCompositeRankingPublicationSet = {
  state: 'sealed',
  publications: [seasonPublication('7D'), seasonPublication('30D'), seasonPublication('90D')],
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'alice',
    handle: 'Alice',
    source_type: 'futures',
    roi: 40,
    pnl: 1000,
    win_rate: 0.6,
    max_drawdown: -10,
    trades_count: 30,
    followers: 20,
    copiers: 10,
    avatar_url: null,
    computed_at: '2026-07-29T10:00:00.000Z',
    profitability_score: 80,
    risk_control_score: 70,
    execution_score: 75,
    score_completeness: 'full',
    trading_style: 'swing',
    avg_holding_hours: 12,
    sharpe_ratio: 1.2,
    sortino_ratio: 1.4,
    calmar_ratio: 1.1,
    profit_factor: 1.5,
    trader_type: 'human',
    primary_season: '90D',
    primary_publication_id: COHORTS['90D'],
    score_7d: 90,
    score_30d: 80,
    score_90d: 70,
    composite_score: 73.5,
    composite_rank: 1,
    ...overrides,
  }
}

function clientReturning(data: unknown, error: unknown = null) {
  const query = Promise.resolve({ data, error })
  return {
    rpc: jest.fn(() => query),
  }
}

const input = {
  publication,
  scopeSources: [...SOURCES],
  limit: 100,
  offset: 0,
  sortBy: 'arena_score' as const,
  sortDir: 'desc' as const,
}

describe('readCompositeRankingPage', () => {
  it('passes every exact cohort and authority to the versioned RPC', async () => {
    const client = clientReturning({
      contract: 'sealed-composite-rankings-rpc@1',
      rows: [row()],
      total_count: 1,
    })

    await expect(readCompositeRankingPage(client as never, input)).resolves.toEqual({
      rows: [expect.objectContaining({ composite_score: 73.5, composite_rank: 1 })],
      totalCount: 1,
    })
    expect(client.rpc).toHaveBeenCalledWith(
      'arena_read_composite_rankings_v1',
      expect.objectContaining({
        p_7d_cohort_id: COHORTS['7D'],
        p_30d_cohort_id: COHORTS['30D'],
        p_90d_cohort_id: COHORTS['90D'],
        p_7d_sources: [...SOURCES],
        p_30d_sources: [...SOURCES],
        p_90d_sources: [...SOURCES],
        p_scope_sources: [...SOURCES],
      })
    )
  })

  it('rejects a label-only 90D score that does not equal 5/25/70 weighting', async () => {
    const client = clientReturning({
      contract: 'sealed-composite-rankings-rpc@1',
      rows: [row({ composite_score: 70 })],
      total_count: 1,
    })

    await expect(readCompositeRankingPage(client as never, input)).rejects.toThrow(
      'mismatched weighted score'
    )
  })

  it('rejects a primary row from a different publication', async () => {
    const client = clientReturning({
      contract: 'sealed-composite-rankings-rpc@1',
      rows: [row({ primary_publication_id: COHORTS['7D'] })],
      total_count: 1,
    })

    await expect(readCompositeRankingPage(client as never, input)).rejects.toThrow(
      'wrong publication'
    )
  })

  it('rejects duplicate composite identities and malformed envelopes', async () => {
    const duplicateClient = clientReturning({
      contract: 'sealed-composite-rankings-rpc@1',
      rows: [row(), row({ composite_rank: 2 })],
      total_count: 2,
    })
    await expect(readCompositeRankingPage(duplicateClient as never, input)).rejects.toThrow(
      'duplicate identity'
    )

    const legacyClient = clientReturning({ rows: [row()], total_count: 1 })
    await expect(readCompositeRankingPage(legacyClient as never, input)).rejects.toThrow(
      'invalid envelope'
    )
  })

  it('fails closed on an RPC error or a scope outside the proof authority', async () => {
    const failedClient = clientReturning(null, { message: 'statement timeout' })
    await expect(readCompositeRankingPage(failedClient as never, input)).rejects.toThrow(
      'statement timeout'
    )

    await expect(
      readCompositeRankingPage(clientReturning(null) as never, {
        ...input,
        scopeSources: ['drift'],
      })
    ).rejects.toThrow('scope exceeds')
  })
})

describe('readCompositeRankingPageWithDatabaseTimeout', () => {
  beforeEach(() => {
    mockGetPool.mockReset()
    mockPoolConnect.mockReset()
    mockGetPool.mockReturnValue({ connect: mockPoolConnect } as never)
  })

  it('arms the database timeout before the parameterized RPC in a read-only transaction', async () => {
    const payload = {
      contract: 'sealed-composite-rankings-rpc@1',
      rows: [row()],
      total_count: 1,
    }
    const query = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ payload }], rowCount: 1 })
      .mockResolvedValueOnce({})
    const release = jest.fn()
    mockPoolConnect.mockResolvedValue({ query, release })

    await expect(readCompositeRankingPageWithDatabaseTimeout(input)).resolves.toEqual({
      rows: [expect.objectContaining({ composite_score: 73.5 })],
      totalCount: 1,
    })

    expect(query.mock.calls[0]).toEqual(['BEGIN TRANSACTION READ ONLY'])
    expect(query.mock.calls[1]).toEqual([
      `SET LOCAL statement_timeout = '${COMPOSITE_RANKING_STATEMENT_TIMEOUT_MS}ms'`,
    ])
    expect(query.mock.calls[2][0]).toContain('public.arena_read_composite_rankings_v1')
    expect(query.mock.calls[2][1]).toEqual([
      COHORTS['7D'],
      COHORTS['30D'],
      COHORTS['90D'],
      [...SOURCES],
      [...SOURCES],
      [...SOURCES],
      [...SOURCES],
      100,
      0,
      'arena_score',
      'desc',
      null,
      null,
      null,
    ])
    expect(query.mock.calls[3]).toEqual(['COMMIT'])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rolls back and releases the connection when the bounded statement fails', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('canceling statement due to statement timeout'))
      .mockResolvedValueOnce({})
    const release = jest.fn()
    mockPoolConnect.mockResolvedValue({ query, release })

    await expect(readCompositeRankingPageWithDatabaseTimeout(input)).rejects.toThrow(
      'statement timeout'
    )
    expect(query.mock.calls[3]).toEqual(['ROLLBACK'])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases exactly once when BEGIN fails before a transaction opens', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('begin failed'))
    const release = jest.fn()
    mockPoolConnect.mockResolvedValue({ query, release })

    await expect(readCompositeRankingPageWithDatabaseTimeout(input)).rejects.toThrow('begin failed')
    expect(query).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('preserves a SET failure even when rollback also fails and releases exactly once', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('set failed'))
      .mockRejectedValueOnce(new Error('rollback failed'))
    const release = jest.fn()
    mockPoolConnect.mockResolvedValue({ query, release })

    await expect(readCompositeRankingPageWithDatabaseTimeout(input)).rejects.toThrow('set failed')
    expect(query.mock.calls[2]).toEqual(['ROLLBACK'])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rolls back an aborted SELECT and releases exactly once', async () => {
    const aborted = new Error('request aborted')
    aborted.name = 'AbortError'
    const query = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(aborted)
      .mockResolvedValueOnce({})
    const release = jest.fn()
    mockPoolConnect.mockResolvedValue({ query, release })

    await expect(readCompositeRankingPageWithDatabaseTimeout(input)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(query.mock.calls[3]).toEqual(['ROLLBACK'])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rolls back a failed COMMIT and releases exactly once', async () => {
    const payload = {
      contract: 'sealed-composite-rankings-rpc@1',
      rows: [row()],
      total_count: 1,
    }
    const query = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ payload }], rowCount: 1 })
      .mockRejectedValueOnce(new Error('commit failed'))
      .mockResolvedValueOnce({})
    const release = jest.fn()
    mockPoolConnect.mockResolvedValue({ query, release })

    await expect(readCompositeRankingPageWithDatabaseTimeout(input)).rejects.toThrow(
      'commit failed'
    )
    expect(query.mock.calls[4]).toEqual(['ROLLBACK'])
    expect(release).toHaveBeenCalledTimes(1)
  })
})
