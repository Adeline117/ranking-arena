/**
 * @jest-environment node
 */

import { createHash } from 'node:crypto'

import {
  LEADERBOARD_RANK_PUBLICATION_CONTRACT,
  SealRankPublicationError,
  sealLeaderboardRankPublication,
  type SealRankPublicationErrorCode,
} from '../seal-rank-publication'
import type { SourcePublicationRow } from '../source-publication-evidence'

const COHORT_ID = '123e4567-e89b-12d3-a456-426614174000'
const PUBLISHED_AT = '2026-07-24T04:00:00.123456Z'
// PostgreSQL 17 fixture: digest('["a-trader", "z-trader"]'::jsonb::text, 'sha256').
// Keep one database-produced value so the test oracle is not isomorphic to the client helper.
const POSTGRES_BETA_IDENTITY_SHA256 =
  'e726bff88911c1612e95a5dc621ff6ab37a92344d3a9b69687749576777e5af5'

function publication(
  source: string,
  sourceAsOf: string,
  publishedRankCount: number
): SourcePublicationRow {
  return {
    source,
    source_as_of: sourceAsOf,
    published_rank_count: publishedRankCount,
    score_cohort_id: COHORT_ID,
    registry_slugs: [`${source}-futures`],
    snapshot_ids: [101],
  }
}

const FRESH_PUBLICATIONS = [
  publication('beta', '2026-07-24T01:02:03.12+01:30', 2),
  publication('alpha', '2026-07-23T23:00:00Z', 1),
]

const FINAL_IDENTITIES = new Map<string, readonly string[]>([
  ['beta', ['z-trader', 'a-trader', 'a-trader']],
  ['alpha', ['only-trader']],
])

const EXPECTED_SOURCE_PUBLICATIONS = [
  {
    source: 'alpha',
    source_as_of: '2026-07-23T23:00:00.000000Z',
    trader_ids: ['only-trader'],
  },
  {
    source: 'beta',
    source_as_of: '2026-07-23T23:32:03.120000Z',
    trader_ids: ['a-trader', 'z-trader'],
  },
]

function postgresJsonbIdentityHash(identities: readonly string[]): string {
  const jsonbText = `[${identities.map((identity) => JSON.stringify(identity)).join(', ')}]`
  return createHash('sha256').update(jsonbText, 'utf8').digest('hex')
}

function successfulSealResponse(overrides: Record<string, unknown> = {}) {
  return {
    contract: LEADERBOARD_RANK_PUBLICATION_CONTRACT,
    season_id: '30D',
    score_cohort_id: COHORT_ID,
    source_count: 2,
    trader_count: 3,
    published_at: '2026-07-24T04:00:00.123456+00:00',
    is_sealed: true,
    proofs: EXPECTED_SOURCE_PUBLICATIONS.map((source, index) => ({
      source: source.source,
      source_as_of: source.source_as_of,
      recorded_at: PUBLISHED_AT,
      score_cohort_id: COHORT_ID,
      rank_mutation_seq: index + 4,
      published_rank_count: source.trader_ids.length,
      published_identity_sha256:
        source.source === 'beta'
          ? POSTGRES_BETA_IDENTITY_SHA256
          : postgresJsonbIdentityHash(source.trader_ids),
    })),
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    season: '30D' as const,
    scoreCohortId: COHORT_ID,
    freshPublications: FRESH_PUBLICATIONS,
    finalEligibleIdentityMap: FINAL_IDENTITIES,
    ...overrides,
  }
}

function supabaseReturning(data: unknown, error: unknown = null) {
  return {
    rpc: jest.fn().mockResolvedValue({ data, error }),
  }
}

async function captureSealError(
  operation: Promise<unknown>,
  expectedCode: SealRankPublicationErrorCode
): Promise<SealRankPublicationError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(SealRankPublicationError)
    expect((error as SealRankPublicationError).code).toBe(expectedCode)
    return error as SealRankPublicationError
  }
  throw new Error(`expected SealRankPublicationError(${expectedCode})`)
}

describe('sealLeaderboardRankPublication', () => {
  it('sends one canonical three-key source payload and validates every returned proof', async () => {
    const supabase = supabaseReturning(successfulSealResponse())

    const result = await sealLeaderboardRankPublication(supabase as never, input())

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('seal_leaderboard_rank_publication', {
      p_season_id: '30D',
      p_score_cohort_id: COHORT_ID,
      p_source_publications: EXPECTED_SOURCE_PUBLICATIONS,
    })
    const requestSources = supabase.rpc.mock.calls[0][1].p_source_publications
    expect(requestSources.map((source: Record<string, unknown>) => Object.keys(source))).toEqual([
      ['source', 'source_as_of', 'trader_ids'],
      ['source', 'source_as_of', 'trader_ids'],
    ])
    expect(result).toEqual(successfulSealResponse())
  })

  it('sorts identities by UTF-8 byte order before hashing and sending them', async () => {
    const identities = ['😀', '\ue000']
    const sourcePublications = [publication('alpha', '2026-07-23T23:00:00Z', 2)]
    const expectedIdentities = ['\ue000', '😀']
    const response = {
      ...successfulSealResponse(),
      source_count: 1,
      trader_count: 2,
      proofs: [
        {
          source: 'alpha',
          source_as_of: '2026-07-23T23:00:00.000000Z',
          recorded_at: PUBLISHED_AT,
          score_cohort_id: COHORT_ID,
          rank_mutation_seq: 0,
          published_rank_count: 2,
          published_identity_sha256: postgresJsonbIdentityHash(expectedIdentities),
        },
      ],
    }
    const supabase = supabaseReturning(response)

    await sealLeaderboardRankPublication(
      supabase as never,
      input({
        freshPublications: sourcePublications,
        finalEligibleIdentityMap: new Map([['alpha', identities]]),
      })
    )

    expect(supabase.rpc.mock.calls[0][1].p_source_publications[0].trader_ids).toEqual(
      expectedIdentities
    )
  })

  it('preserves an explicitly empty fresh source and verifies its empty identity digest', async () => {
    const emptyPublication = [publication('empty', '2026-07-23T23:00:00Z', 0)]
    const emptyIdentities: string[] = []
    const response = {
      ...successfulSealResponse(),
      source_count: 1,
      trader_count: 0,
      proofs: [
        {
          source: 'empty',
          source_as_of: '2026-07-23T23:00:00.000000Z',
          recorded_at: PUBLISHED_AT,
          score_cohort_id: COHORT_ID,
          rank_mutation_seq: 0,
          published_rank_count: 0,
          published_identity_sha256: postgresJsonbIdentityHash([]),
        },
      ],
    }
    const supabase = supabaseReturning(response)

    await sealLeaderboardRankPublication(
      supabase as never,
      input({
        freshPublications: emptyPublication,
        finalEligibleIdentityMap: new Map([['empty', emptyIdentities]]),
      })
    )

    expect(supabase.rpc.mock.calls[0][1].p_source_publications).toEqual([
      {
        source: 'empty',
        source_as_of: '2026-07-23T23:00:00.000000Z',
        trader_ids: [],
      },
    ])
  })

  it.each([
    ['invalid season', { season: '1D' }],
    ['non-canonical cohort', { scoreCohortId: COHORT_ID.toUpperCase() }],
    [
      'row cohort mismatch',
      {
        freshPublications: [
          { ...FRESH_PUBLICATIONS[0], score_cohort_id: '223e4567-e89b-12d3-a456-426614174000' },
        ],
        finalEligibleIdentityMap: new Map([['beta', ['a-trader', 'z-trader']]]),
      },
    ],
    [
      'missing source identities',
      { finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]) },
    ],
    [
      'non-fresh source identities',
      {
        finalEligibleIdentityMap: new Map([...FINAL_IDENTITIES, ['retained', ['trader']]]),
      },
    ],
    [
      'deduplicated count mismatch',
      {
        freshPublications: [publication('alpha', '2026-07-23T23:00:00Z', 2)],
        finalEligibleIdentityMap: new Map([['alpha', ['same', 'same']]]),
      },
    ],
  ])('rejects %s before making an RPC call', async (_label, overrides) => {
    const supabase = supabaseReturning(successfulSealResponse())

    await captureSealError(
      sealLeaderboardRankPublication(supabase as never, input(overrides)),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('does not retry a deterministic RPC error response', async () => {
    const supabase = supabaseReturning(null, {
      code: '23514',
      message: 'published trader identities do not match leaderboard rows',
    })

    const error = await captureSealError(
      sealLeaderboardRankPublication(supabase as never, input()),
      'rpc_error'
    )

    expect(error.message).toContain('23514')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('does not retry a null RPC response', async () => {
    const supabase = supabaseReturning(null)

    await captureSealError(sealLeaderboardRankPublication(supabase as never, input()), 'rpc_null')

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['wrong contract', { contract: 'leaderboard-rank-publication@0' }],
    ['unsealed response', { is_sealed: false }],
    ['wrong source count', { source_count: 1 }],
    ['wrong trader count', { trader_count: 2 }],
    [
      'wrong proof cohort',
      {
        proofs: successfulSealResponse().proofs.map((proof, index) =>
          index === 0
            ? { ...proof, score_cohort_id: '223e4567-e89b-12d3-a456-426614174000' }
            : proof
        ),
      },
    ],
    [
      'wrong proof watermark',
      {
        proofs: successfulSealResponse().proofs.map((proof, index) =>
          index === 0 ? { ...proof, source_as_of: '2026-07-23T22:00:00.000000Z' } : proof
        ),
      },
    ],
    [
      'wrong identity digest',
      {
        proofs: successfulSealResponse().proofs.map((proof, index) =>
          index === 0 ? { ...proof, published_identity_sha256: '0'.repeat(64) } : proof
        ),
      },
    ],
    [
      'extra proof key',
      {
        proofs: successfulSealResponse().proofs.map((proof, index) =>
          index === 0 ? { ...proof, extra: true } : proof
        ),
      },
    ],
    [
      'proof timestamp differs from publication timestamp',
      {
        proofs: successfulSealResponse().proofs.map((proof, index) =>
          index === 0 ? { ...proof, recorded_at: '2026-07-24T04:00:01.123456Z' } : proof
        ),
      },
    ],
  ])('fails closed without retrying a shape mismatch: %s', async (_label, overrides) => {
    const supabase = supabaseReturning(successfulSealResponse(overrides))

    await captureSealError(
      sealLeaderboardRankPublication(supabase as never, input()),
      'rpc_shape_mismatch'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('retries one response-loss rejection with the exact same cohort and payload', async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockRejectedValueOnce(new TypeError('connection reset after request write'))
        .mockResolvedValueOnce({ data: successfulSealResponse(), error: null }),
    }

    const result = await sealLeaderboardRankPublication(supabase as never, input())

    expect(result.is_sealed).toBe(true)
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
    expect(supabase.rpc.mock.calls[1][1].p_score_cohort_id).toBe(COHORT_ID)
    expect(supabase.rpc.mock.calls[1][1].p_source_publications).toBe(
      supabase.rpc.mock.calls[0][1].p_source_publications
    )
  })

  it('stops after the sole retry when both dispatched responses are lost', async () => {
    const supabase = {
      rpc: jest.fn().mockRejectedValue(new TypeError('connection reset')),
    }

    await captureSealError(
      sealLeaderboardRankPublication(supabase as never, input()),
      'rpc_ambiguous'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it('retries one deadline expiry and forwards an AbortSignal to both attempts', async () => {
    jest.useFakeTimers()
    try {
      const capturedSignals: AbortSignal[] = []
      const firstQuery = {
        abortSignal: jest.fn((signal: AbortSignal) => {
          capturedSignals.push(signal)
          return new Promise<never>(() => undefined)
        }),
      }
      const secondQuery = {
        abortSignal: jest.fn((signal: AbortSignal) => {
          capturedSignals.push(signal)
          return Promise.resolve({ data: successfulSealResponse(), error: null })
        }),
      }
      const supabase = {
        rpc: jest.fn().mockReturnValueOnce(firstQuery).mockReturnValueOnce(secondQuery),
      }

      const operation = sealLeaderboardRankPublication(supabase as never, input(), {
        timeoutMs: 25,
      })
      await jest.advanceTimersByTimeAsync(25)
      await expect(operation).resolves.toMatchObject({ is_sealed: true })

      expect(supabase.rpc).toHaveBeenCalledTimes(2)
      expect(capturedSignals).toHaveLength(2)
      expect(capturedSignals[0].aborted).toBe(true)
      expect(capturedSignals[1].aborted).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('honors caller abort without issuing a retry', async () => {
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    const query = {
      abortSignal: jest.fn((signal: AbortSignal) => {
        capturedSignal = signal
        return new Promise<never>(() => undefined)
      }),
    }
    const supabase = { rpc: jest.fn().mockReturnValue(query) }

    const operation = sealLeaderboardRankPublication(supabase as never, input(), {
      signal: controller.signal,
    })
    controller.abort()
    await captureSealError(operation, 'rpc_aborted')

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('does not retry a synchronous pre-dispatch client failure', async () => {
    const supabase = {
      rpc: jest.fn(() => {
        throw new Error('client construction failed')
      }),
    }

    await captureSealError(
      sealLeaderboardRankPublication(supabase as never, input()),
      'rpc_call_error'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })
})
