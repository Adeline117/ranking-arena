/**
 * @jest-environment node
 */

import {
  CleanupRankPublicationError,
  LEADERBOARD_RANK_PUBLICATION_CLEANUP_CONTRACT,
  LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITY_LENGTH,
  LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITIES,
  LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_REQUEST_BYTES,
  LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCE_LENGTH,
  LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCES,
  LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_TIMEOUT_MS,
  cleanupLeaderboardRankPublication,
  type CleanupRankPublicationErrorCode,
} from '../cleanup-rank-publication'
import type { SourcePublicationRow } from '../source-publication-evidence'

const COHORT_ID = '123e4567-e89b-12d3-a456-426614174000'

function publication(
  source: string,
  publishedRankCount: number,
  overrides: Partial<SourcePublicationRow> = {}
): SourcePublicationRow {
  return {
    source,
    source_as_of: '2026-07-24T01:02:03.123456Z',
    published_rank_count: publishedRankCount,
    score_cohort_id: COHORT_ID,
    registry_slugs: [`${source}-futures`],
    snapshot_ids: [101],
    ...overrides,
  }
}

const FRESH_PUBLICATIONS = [publication('beta', 2), publication('alpha', 1)]
const FINAL_IDENTITIES = new Map<string, readonly string[]>([
  ['beta', ['z-trader', 'a-trader']],
  ['alpha', ['only-trader']],
])
const EXPECTED_SOURCE_PUBLICATIONS = [
  { source: 'alpha', trader_ids: ['only-trader'] },
  { source: 'beta', trader_ids: ['a-trader', 'z-trader'] },
]

function input(overrides: Record<string, unknown> = {}) {
  return {
    season: '30D' as const,
    scoreCohortId: COHORT_ID,
    freshPublications: FRESH_PUBLICATIONS,
    finalEligibleIdentityMap: FINAL_IDENTITIES,
    ...overrides,
  }
}

function successfulResponse(overrides: Record<string, unknown> = {}) {
  return {
    contract: LEADERBOARD_RANK_PUBLICATION_CLEANUP_CONTRACT,
    season_id: '30D',
    score_cohort_id: COHORT_ID,
    source_count: 2,
    kept_count: 3,
    deleted_count: 7,
    ...overrides,
  }
}

function supabaseReturning(data: unknown, error: unknown = null) {
  return {
    rpc: jest.fn().mockResolvedValue({ data, error }),
  }
}

async function captureCleanupError(
  operation: Promise<unknown>,
  expectedCode: CleanupRankPublicationErrorCode
): Promise<CleanupRankPublicationError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(CleanupRankPublicationError)
    expect((error as CleanupRankPublicationError).code).toBe(expectedCode)
    return error as CleanupRankPublicationError
  }
  throw new Error(`expected CleanupRankPublicationError(${expectedCode})`)
}

describe('cleanupLeaderboardRankPublication', () => {
  it('calls the dormant RPC with one canonical exact two-key source payload', async () => {
    const response = successfulResponse()
    const supabase = supabaseReturning(response)

    const result = await cleanupLeaderboardRankPublication(supabase as never, input())

    expect(result).toEqual(response)
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('cleanup_leaderboard_rank_publication', {
      p_season_id: '30D',
      p_score_cohort_id: COHORT_ID,
      p_source_publications: EXPECTED_SOURCE_PUBLICATIONS,
    })
    const args = supabase.rpc.mock.calls[0][1]
    expect(args.p_source_publications.map(Object.keys)).toEqual([
      ['source', 'trader_ids'],
      ['source', 'trader_ids'],
    ])
    expect(args.p_source_publications[0]).not.toHaveProperty('source_as_of')
    expect(Object.isFrozen(args)).toBe(true)
    expect(Object.isFrozen(args.p_source_publications)).toBe(true)
    expect(Object.isFrozen(args.p_source_publications[0].trader_ids)).toBe(true)
  })

  it('snapshots every top-level input accessor exactly once', async () => {
    const reads = {
      season: 0,
      scoreCohortId: 0,
      freshPublications: 0,
      finalEligibleIdentityMap: 0,
    }
    const onePublication = [publication('alpha', 1)]
    const oneIdentityMap = new Map([['alpha', ['only-trader']]])
    const statefulInput = Object.defineProperties(
      {},
      {
        season: {
          get() {
            reads.season += 1
            return reads.season === 1 ? '30D' : 'invalid'
          },
        },
        scoreCohortId: {
          get() {
            reads.scoreCohortId += 1
            return reads.scoreCohortId === 1 ? COHORT_ID : COHORT_ID.toUpperCase()
          },
        },
        freshPublications: {
          get() {
            reads.freshPublications += 1
            return reads.freshPublications === 1 ? onePublication : []
          },
        },
        finalEligibleIdentityMap: {
          get() {
            reads.finalEligibleIdentityMap += 1
            return reads.finalEligibleIdentityMap === 1 ? oneIdentityMap : new Map()
          },
        },
      }
    )
    const response = successfulResponse({ source_count: 1, kept_count: 1 })
    const supabase = supabaseReturning(response)

    await expect(
      cleanupLeaderboardRankPublication(supabase as never, statefulInput as never)
    ).resolves.toEqual(response)

    expect(reads).toEqual({
      season: 1,
      scoreCohortId: 1,
      freshPublications: 1,
      finalEligibleIdentityMap: 1,
    })
    expect(supabase.rpc.mock.calls[0][1]).toEqual({
      p_season_id: '30D',
      p_score_cohort_id: COHORT_ID,
      p_source_publications: [{ source: 'alpha', trader_ids: ['only-trader'] }],
    })
  })

  it('does not re-read a top-level getter after its first invalid value', async () => {
    let seasonReads = 0
    const statefulInput = Object.defineProperty(input(), 'season', {
      configurable: true,
      get() {
        seasonReads += 1
        return seasonReads === 1 ? 'invalid' : '30D'
      },
    })
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, statefulInput),
      'invalid_input'
    )

    expect(seasonReads).toBe(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('snapshots each publication field and array member exactly once', async () => {
    const fieldReads = new Map<string, number>()
    const next = <T>(field: string, first: T, later: unknown): T | unknown => {
      const count = (fieldReads.get(field) ?? 0) + 1
      fieldReads.set(field, count)
      return count === 1 ? first : later
    }
    let registryLengthReads = 0
    let registryMemberReads = 0
    let snapshotLengthReads = 0
    let snapshotMemberReads = 0
    const registrySlugs = new Proxy(['alpha-futures'], {
      get(target, property, receiver) {
        if (property === 'length') registryLengthReads += 1
        if (property === '0') registryMemberReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const snapshotIds = new Proxy([101], {
      get(target, property, receiver) {
        if (property === 'length') snapshotLengthReads += 1
        if (property === '0') snapshotMemberReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const statefulPublication = Object.defineProperties(
      {},
      {
        source: {
          enumerable: true,
          get: () => next('source', 'alpha', 'INVALID'),
        },
        source_as_of: {
          enumerable: true,
          get: () => next('source_as_of', '2026-07-24T01:02:03.123456Z', 'invalid'),
        },
        published_rank_count: {
          enumerable: true,
          get: () => next('published_rank_count', 1, -1),
        },
        score_cohort_id: {
          enumerable: true,
          get: () => next('score_cohort_id', COHORT_ID, COHORT_ID.toUpperCase()),
        },
        registry_slugs: {
          enumerable: true,
          get: () => next('registry_slugs', registrySlugs, []),
        },
        snapshot_ids: {
          enumerable: true,
          get: () => next('snapshot_ids', snapshotIds, []),
        },
      }
    )
    const response = successfulResponse({ source_count: 1, kept_count: 1 })
    const supabase = supabaseReturning(response)

    await expect(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({
          freshPublications: [statefulPublication],
          finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]),
        })
      )
    ).resolves.toEqual(response)

    expect(Object.fromEntries(fieldReads)).toEqual({
      source: 1,
      source_as_of: 1,
      published_rank_count: 1,
      score_cohort_id: 1,
      registry_slugs: 1,
      snapshot_ids: 1,
    })
    expect({
      registryLengthReads,
      registryMemberReads,
      snapshotLengthReads,
      snapshotMemberReads,
    }).toEqual({
      registryLengthReads: 1,
      registryMemberReads: 1,
      snapshotLengthReads: 1,
      snapshotMemberReads: 1,
    })
    expect(supabase.rpc.mock.calls[0][1].p_source_publications).toEqual([
      { source: 'alpha', trader_ids: ['only-trader'] },
    ])
  })

  it('rejects a publication getter whose first value is invalid without re-reading it', async () => {
    let sourceReads = 0
    const statefulPublication = Object.defineProperty(publication('alpha', 1), 'source', {
      configurable: true,
      enumerable: true,
      get() {
        sourceReads += 1
        return sourceReads === 1 ? 'INVALID' : 'alpha'
      },
    })
    const supabase = supabaseReturning(successfulResponse({ source_count: 1, kept_count: 1 }))

    await captureCleanupError(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({
          freshPublications: [statefulPublication],
          finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]),
        })
      ),
      'invalid_input'
    )

    expect(sourceReads).toBe(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('uses Map intrinsics instead of caller-defined keys/get/size accessors', async () => {
    let mapTrapReads = 0
    const identities = new Map([['alpha', ['only-trader']]])
    Object.defineProperties(identities, {
      keys: {
        get() {
          mapTrapReads += 1
          throw new Error('keys getter trap')
        },
      },
      get: {
        get() {
          mapTrapReads += 1
          throw new Error('get getter trap')
        },
      },
      size: {
        get() {
          mapTrapReads += 1
          throw new Error('size getter trap')
        },
      },
    })
    const response = successfulResponse({ source_count: 1, kept_count: 1 })
    const supabase = supabaseReturning(response)

    await expect(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({
          freshPublications: [publication('alpha', 1)],
          finalEligibleIdentityMap: identities,
        })
      )
    ).resolves.toEqual(response)

    expect(mapTrapReads).toBe(0)
    expect(supabase.rpc.mock.calls[0][1].p_source_publications).toEqual([
      { source: 'alpha', trader_ids: ['only-trader'] },
    ])
  })

  it('snapshots publication and identity array members exactly once', async () => {
    const reads = {
      publicationLength: 0,
      publicationMember: 0,
      identityLength: 0,
      identityMember: 0,
    }
    const publicationArray = new Proxy([publication('alpha', 1)], {
      get(target, property, receiver) {
        if (property === 'length') reads.publicationLength += 1
        if (property === '0') reads.publicationMember += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const identityArray = new Proxy(['only-trader'], {
      get(target, property, receiver) {
        if (property === 'length') reads.identityLength += 1
        if (property === '0') {
          reads.identityMember += 1
          return reads.identityMember === 1 ? 'only-trader' : 'changed-after-validation'
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const response = successfulResponse({ source_count: 1, kept_count: 1 })
    const supabase = supabaseReturning(response)

    await expect(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({
          freshPublications: publicationArray,
          finalEligibleIdentityMap: new Map([['alpha', identityArray]]),
        })
      )
    ).resolves.toEqual(response)

    expect(reads).toEqual({
      publicationLength: 1,
      publicationMember: 1,
      identityLength: 1,
      identityMember: 1,
    })
    expect(supabase.rpc.mock.calls[0][1].p_source_publications).toEqual([
      { source: 'alpha', trader_ids: ['only-trader'] },
    ])
  })

  it('fails closed on a Proxy-wrapped Map before dispatch', async () => {
    const proxiedMap = new Proxy(new Map([['alpha', ['only-trader']]]), {})
    const supabase = supabaseReturning(successfulResponse({ source_count: 1, kept_count: 1 }))

    await captureCleanupError(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({
          freshPublications: [publication('alpha', 1)],
          finalEligibleIdentityMap: proxiedMap,
        })
      ),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('accepts at most 256 physical-board evidence members per source', async () => {
    const registrySlugs = Array.from(
      { length: LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCES },
      (_, index) => `alpha-futures-${index}`
    )
    const snapshotIds = Array.from(
      { length: LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCES },
      (_, index) => index + 1
    )
    const response = successfulResponse({ source_count: 1, kept_count: 1 })
    const supabase = supabaseReturning(response)

    await expect(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({
          freshPublications: [
            publication('alpha', 1, { registry_slugs: registrySlugs, snapshot_ids: snapshotIds }),
          ],
          finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]),
        })
      )
    ).resolves.toEqual(response)

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it.each(['registry_slugs', 'snapshot_ids'] as const)(
    'rejects more than 256 %s evidence members before dispatch',
    async (field) => {
      const oversized = Array.from(
        { length: LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCES + 1 },
        (_, index) => (field === 'registry_slugs' ? `alpha-futures-${index}` : index + 1)
      )
      const supabase = supabaseReturning(successfulResponse({ source_count: 1, kept_count: 1 }))

      await captureCleanupError(
        cleanupLeaderboardRankPublication(
          supabase as never,
          input({
            freshPublications: [publication('alpha', 1, { [field]: oversized })],
            finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]),
          })
        ),
        'invalid_input'
      )

      expect(supabase.rpc).not.toHaveBeenCalled()
    }
  )

  it('sorts identities by UTF-8 byte order like the seal/JSONB contract', async () => {
    const identities = ['😀', '\ue000']
    const supabase = supabaseReturning(
      successfulResponse({ source_count: 1, kept_count: 2, deleted_count: 0 })
    )

    await cleanupLeaderboardRankPublication(
      supabase as never,
      input({
        freshPublications: [publication('alpha', 2)],
        finalEligibleIdentityMap: new Map([['alpha', identities]]),
      })
    )

    expect(supabase.rpc.mock.calls[0][1].p_source_publications).toEqual([
      { source: 'alpha', trader_ids: ['\ue000', '😀'] },
    ])
  })

  it('measures the 512 identity limit in Unicode code points, not UTF-16 code units', async () => {
    const boundaryIdentity = '😀'.repeat(LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITY_LENGTH)
    const supabase = supabaseReturning(
      successfulResponse({ source_count: 1, kept_count: 1, deleted_count: 0 })
    )

    await cleanupLeaderboardRankPublication(
      supabase as never,
      input({
        freshPublications: [publication('alpha', 1)],
        finalEligibleIdentityMap: new Map([['alpha', [boundaryIdentity]]]),
      })
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc.mock.calls[0][1].p_source_publications[0].trader_ids).toEqual([
      boundaryIdentity,
    ])
  })

  it('preserves an explicitly empty fresh source and accepts a zero delete replay', async () => {
    const response = successfulResponse({
      source_count: 1,
      kept_count: 0,
      deleted_count: 0,
    })
    const supabase = supabaseReturning(response)

    await expect(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({
          freshPublications: [publication('empty', 0)],
          finalEligibleIdentityMap: new Map([['empty', []]]),
        })
      )
    ).resolves.toEqual(response)
    expect(supabase.rpc.mock.calls[0][1].p_source_publications).toEqual([
      { source: 'empty', trader_ids: [] },
    ])
  })

  it.each([
    ['invalid season', { season: '30d' }],
    ['uppercase cohort', { scoreCohortId: COHORT_ID.toUpperCase() }],
    ['empty publication set', { freshPublications: [] }],
    ['non-map identities', { finalEligibleIdentityMap: { alpha: ['only-trader'] } }],
    [
      'row cohort mismatch',
      {
        freshPublications: [
          publication('alpha', 1, {
            score_cohort_id: '223e4567-e89b-12d3-a456-426614174000',
          }),
        ],
        finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]),
      },
    ],
    [
      'non-canonical source',
      {
        freshPublications: [publication('Alpha', 1)],
        finalEligibleIdentityMap: new Map([['Alpha', ['only-trader']]]),
      },
    ],
    [
      'overlong source',
      {
        freshPublications: [
          publication('a'.repeat(LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCE_LENGTH + 1), 1),
        ],
        finalEligibleIdentityMap: new Map([
          ['a'.repeat(LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCE_LENGTH + 1), ['only-trader']],
        ]),
      },
    ],
    [
      'duplicate source publication',
      {
        freshPublications: [publication('alpha', 1), publication('alpha', 1)],
        finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]),
      },
    ],
    [
      'missing source identities',
      { finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]) },
    ],
    [
      'extra map source',
      {
        finalEligibleIdentityMap: new Map([...FINAL_IDENTITIES, ['retained', ['trader']]]),
      },
    ],
    [
      'duplicate identity',
      {
        freshPublications: [publication('alpha', 1)],
        finalEligibleIdentityMap: new Map([['alpha', ['same', 'same']]]),
      },
    ],
    [
      'eligible identity count mismatch',
      {
        freshPublications: [publication('alpha', 2)],
        finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]),
      },
    ],
    [
      'invalid identity scalar',
      {
        freshPublications: [publication('alpha', 1)],
        finalEligibleIdentityMap: new Map([['alpha', ['bad\u0000identity']]]),
      },
    ],
    [
      'overlong identity',
      {
        freshPublications: [publication('alpha', 1)],
        finalEligibleIdentityMap: new Map([
          ['alpha', ['😀'.repeat(LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITY_LENGTH + 1)]],
        ]),
      },
    ],
    [
      'invalid source timestamp',
      {
        freshPublications: [publication('alpha', 1, { source_as_of: '2026-02-31T00:00:00Z' })],
        finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]),
      },
    ],
    [
      'extra publication key',
      {
        freshPublications: [{ ...publication('alpha', 1), unexpected: true }],
        finalEligibleIdentityMap: new Map([['alpha', ['only-trader']]]),
      },
    ],
  ])('rejects input bypass before dispatch: %s', async (_label, overrides) => {
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input(overrides)),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-object input before dispatch', async () => {
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, null as never),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('enforces the 256-source request bound before examining source contents', async () => {
    const publications = Array.from(
      { length: LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCES + 1 },
      (_, index) => publication(`source_${index}`, 0)
    )
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({ freshPublications: publications, finalEligibleIdentityMap: new Map() })
      ),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('enforces the aggregate 250k identity bound before dispatch', async () => {
    const identities = Array.from(
      { length: LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITIES + 1 },
      (_, index) => `trader-${index}`
    )
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({
          freshPublications: [publication('alpha', identities.length)],
          finalEligibleIdentityMap: new Map([['alpha', identities]]),
        })
      ),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('enforces the 250k identity bound across sources before reading excess members', async () => {
    const firstIdentities = new Array<string>(
      LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITIES
    ).fill('duplicate-is-irrelevant-before-the-resource-fence')
    let excessMemberReads = 0
    const excessIdentities = new Proxy(['must-not-be-read'], {
      get(target, property, receiver) {
        if (property === '0') excessMemberReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({
          freshPublications: [publication('alpha', 0), publication('beta', 0)],
          finalEligibleIdentityMap: new Map([
            ['alpha', firstIdentities],
            ['beta', excessIdentities],
          ]),
        })
      ),
      'invalid_input'
    )

    expect(excessMemberReads).toBe(0)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('enforces the 64 MiB canonical JSON request bound before dispatch', async () => {
    const identityCount = Math.floor(
      (LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_REQUEST_BYTES - 64) /
        (LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITY_LENGTH + 3)
    )
    const oversizedIdentities = Array.from({ length: identityCount }, (_, index) => {
      const prefix = `${String(index).padStart(6, '0')}-`
      return `${prefix}${'x'.repeat(
        LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITY_LENGTH - prefix.length
      )}`
    })
    expect(oversizedIdentities.length).toBeLessThanOrEqual(
      LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITIES
    )
    expect(
      Buffer.byteLength(
        JSON.stringify([{ source: 'alpha', trader_ids: oversizedIdentities }]),
        'utf8'
      )
    ).toBeLessThanOrEqual(LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_REQUEST_BYTES)
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(
        supabase as never,
        input({
          freshPublications: [publication('alpha', oversizedIdentities.length)],
          finalEligibleIdentityMap: new Map([['alpha', oversizedIdentities]]),
        })
      ),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  }, 30_000)

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_TIMEOUT_MS + 1,
  ])('rejects an invalid or unbounded timeout before dispatch: %s', async (timeoutMs) => {
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input(), { timeoutMs }),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('reads timeout and signal option accessors exactly once', async () => {
    let timeoutReads = 0
    let signalReads = 0
    const controller = new AbortController()
    const options = Object.defineProperties(
      {},
      {
        timeoutMs: {
          get() {
            timeoutReads += 1
            return 25
          },
        },
        signal: {
          get() {
            signalReads += 1
            return controller.signal
          },
        },
      }
    )
    const supabase = supabaseReturning(successfulResponse())

    await expect(
      cleanupLeaderboardRankPublication(supabase as never, input(), options)
    ).resolves.toEqual(successfulResponse())

    expect(timeoutReads).toBe(1)
    expect(signalReads).toBe(1)
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('rejects a stateful fake signal accessor before dispatch', async () => {
    let signalReads = 0
    const controller = new AbortController()
    const options = Object.defineProperty({}, 'signal', {
      get() {
        signalReads += 1
        return signalReads === 1 ? { aborted: false } : controller.signal
      },
    })
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input(), options),
      'invalid_input'
    )

    expect(signalReads).toBe(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects a fully duck-typed fake AbortSignal before dispatch', async () => {
    const fakeSignal = {
      aborted: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input(), {
        signal: fakeSignal as never,
      }),
      'invalid_input'
    )

    expect(fakeSignal.addEventListener).not.toHaveBeenCalled()
    expect(fakeSignal.removeEventListener).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('does not retry a deterministic RPC error', async () => {
    const supabase = supabaseReturning(null, {
      code: '23514',
      message: 'cleanup identities do not match the written cohort',
    })

    const error = await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input()),
      'rpc_error'
    )

    expect(error.message).toContain('23514')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('reads each deterministic RPC error field exactly once', async () => {
    let codeReads = 0
    let messageReads = 0
    const statefulError = Object.defineProperties(
      {},
      {
        code: {
          get() {
            codeReads += 1
            return codeReads === 1 ? '23514' : ''
          },
        },
        message: {
          get() {
            messageReads += 1
            return messageReads === 1 ? 'deterministic constraint failure' : 'changed'
          },
        },
      }
    )
    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data: null, error: statefulError, status: 503 }),
    }

    const error = await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input()),
      'rpc_error'
    )

    expect(error.message).toContain('23514')
    expect(error.message).toContain('deterministic constraint failure')
    expect({ codeReads, messageReads }).toEqual({ codeReads: 1, messageReads: 1 })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('retries a real Supabase status-zero transport envelope with the same frozen args', async () => {
    const replayResponse = successfulResponse({ deleted_count: 0 })
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: null,
          error: { code: '', message: 'TypeError: fetch failed' },
          status: 0,
          statusText: '',
        })
        .mockResolvedValueOnce({ data: replayResponse, error: null, status: 200 }),
    }

    await expect(cleanupLeaderboardRankPublication(supabase as never, input())).resolves.toEqual(
      replayResponse
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
    expect(Object.isFrozen(supabase.rpc.mock.calls[0][1])).toBe(true)
  })

  it('reports ambiguity after two real Supabase status-zero transport envelopes', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { code: '', message: 'TypeError: connection reset' },
        status: 0,
        statusText: '',
      }),
    }

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input()),
      'rpc_ambiguous'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
  })

  it('honors caller abort observed while classifying an ambiguous transport response', async () => {
    const controller = new AbortController()
    const response = {
      data: null,
      error: { code: '', message: 'TypeError: connection reset' },
      get status() {
        controller.abort(new Error('cron budget exhausted'))
        return 0
      },
    }
    const supabase = { rpc: jest.fn().mockResolvedValue(response) }

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input(), {
        signal: controller.signal,
      }),
      'rpc_aborted'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it.each([502, 503, 504])(
    'retries an unstructured %s gateway response whose commit state is unknowable',
    async (status) => {
      const replayResponse = successfulResponse({ deleted_count: 0 })
      const supabase = {
        rpc: jest
          .fn()
          .mockResolvedValueOnce({
            data: null,
            error: { message: 'upstream response unavailable' },
            status,
          })
          .mockResolvedValueOnce({ data: replayResponse, error: null, status: 200 }),
      }

      await expect(cleanupLeaderboardRankPublication(supabase as never, input())).resolves.toEqual(
        replayResponse
      )
      expect(supabase.rpc).toHaveBeenCalledTimes(2)
      expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
    }
  )

  it.each([
    [502, 'PT502'],
    [503, '53300'],
    [504, 'PGRST003'],
  ])(
    'does not retry a structured deterministic RPC error mapped to HTTP %s',
    async (status, code) => {
      const supabase = {
        rpc: jest.fn().mockResolvedValue({
          data: null,
          error: { code, message: 'structured database or PostgREST failure' },
          status,
        }),
      }

      const error = await captureCleanupError(
        cleanupLeaderboardRankPublication(supabase as never, input()),
        'rpc_error'
      )

      expect(error.message).toContain(code)
      expect(supabase.rpc).toHaveBeenCalledTimes(1)
    }
  )

  it('fails closed without retrying an unreadable structured gateway error', async () => {
    const unreadableError = Object.defineProperties(
      { message: 'gateway failed' },
      {
        code: {
          get() {
            throw new Error('code getter trap')
          },
        },
      }
    )
    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data: null, error: unreadableError, status: 503 }),
    }

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input()),
      'rpc_error'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('does not retry null data or a missing envelope', async () => {
    const nullClient = supabaseReturning(null)
    await captureCleanupError(
      cleanupLeaderboardRankPublication(nullClient as never, input()),
      'rpc_null'
    )
    expect(nullClient.rpc).toHaveBeenCalledTimes(1)

    const missingEnvelopeClient = { rpc: jest.fn().mockResolvedValue(undefined) }
    await captureCleanupError(
      cleanupLeaderboardRankPublication(missingEnvelopeClient as never, input()),
      'rpc_error'
    )
    expect(missingEnvelopeClient.rpc).toHaveBeenCalledTimes(1)
  })

  it('snapshots envelope and successful response fields exactly once', async () => {
    const rawResponse = successfulResponse()
    const responseReads = new Map<string, number>()
    const statefulResponse: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rawResponse)) {
      Object.defineProperty(statefulResponse, key, {
        enumerable: true,
        get() {
          const count = (responseReads.get(key) ?? 0) + 1
          responseReads.set(key, count)
          return count === 1 ? value : 'changed-after-validation'
        },
      })
    }

    const envelopeReads = { data: 0, error: 0, status: 0 }
    const envelope = Object.defineProperties(
      {},
      {
        data: {
          get() {
            envelopeReads.data += 1
            return envelopeReads.data === 1 ? statefulResponse : null
          },
        },
        error: {
          get() {
            envelopeReads.error += 1
            return envelopeReads.error === 1 ? null : { code: 'changed' }
          },
        },
        status: {
          get() {
            envelopeReads.status += 1
            return envelopeReads.status === 1 ? 200 : 0
          },
        },
      }
    )
    const supabase = { rpc: jest.fn().mockResolvedValue(envelope) }

    await expect(cleanupLeaderboardRankPublication(supabase as never, input())).resolves.toEqual(
      rawResponse
    )

    expect(envelopeReads).toEqual({ data: 1, error: 1, status: 1 })
    expect(Object.fromEntries(responseReads)).toEqual({
      contract: 1,
      season_id: 1,
      score_cohort_id: 1,
      source_count: 1,
      kept_count: 1,
      deleted_count: 1,
    })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['wrong contract', successfulResponse({ contract: 'leaderboard-rank-publication-cleanup@0' })],
    ['wrong season', successfulResponse({ season_id: '7D' })],
    [
      'wrong cohort',
      successfulResponse({ score_cohort_id: '223e4567-e89b-12d3-a456-426614174000' }),
    ],
    ['wrong source count', successfulResponse({ source_count: 1 })],
    ['wrong kept count', successfulResponse({ kept_count: 2 })],
    ['negative deleted count', successfulResponse({ deleted_count: -1 })],
    ['fractional deleted count', successfulResponse({ deleted_count: 1.5 })],
    ['unsafe deleted count', successfulResponse({ deleted_count: Number.MAX_SAFE_INTEGER + 1 })],
    ['extra key', successfulResponse({ extra: true })],
    [
      'missing key',
      (() => {
        const { deleted_count: _deletedCount, ...response } = successfulResponse()
        return response
      })(),
    ],
    ['array response', []],
  ])('fails closed without retrying a strict response mismatch: %s', async (_label, response) => {
    const supabase = supabaseReturning(response)

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input()),
      'rpc_shape_mismatch'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('retries one lost response with the exact same frozen canonical args', async () => {
    const replayResponse = successfulResponse({ deleted_count: 0 })
    const supabase = {
      rpc: jest
        .fn()
        .mockRejectedValueOnce(new TypeError('connection reset after request write'))
        .mockResolvedValueOnce({ data: replayResponse, error: null }),
    }

    await expect(cleanupLeaderboardRankPublication(supabase as never, input())).resolves.toEqual(
      replayResponse
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
    expect(supabase.rpc.mock.calls[1][1].p_source_publications).toBe(
      supabase.rpc.mock.calls[0][1].p_source_publications
    )
    expect(supabase.rpc.mock.calls[1][1]).toEqual({
      p_season_id: '30D',
      p_score_cohort_id: COHORT_ID,
      p_source_publications: EXPECTED_SOURCE_PUBLICATIONS,
    })
  })

  it('stops after the sole retry when both dispatched responses are lost', async () => {
    const supabase = { rpc: jest.fn().mockRejectedValue(new TypeError('connection reset')) }

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input()),
      'rpc_ambiguous'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it('retries one deadline with the same args and a fresh AbortSignal', async () => {
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
          return Promise.resolve({ data: successfulResponse({ deleted_count: 0 }), error: null })
        }),
      }
      const supabase = {
        rpc: jest.fn().mockReturnValueOnce(firstQuery).mockReturnValueOnce(secondQuery),
      }

      const operation = cleanupLeaderboardRankPublication(supabase as never, input(), {
        timeoutMs: 25,
      })
      await jest.advanceTimersByTimeAsync(25)
      await expect(operation).resolves.toEqual(successfulResponse({ deleted_count: 0 }))

      expect(supabase.rpc).toHaveBeenCalledTimes(2)
      expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
      expect(capturedSignals).toHaveLength(2)
      expect(capturedSignals[0].aborted).toBe(true)
      expect(capturedSignals[1].aborted).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('honors an external abort without retrying', async () => {
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    const query = {
      abortSignal: jest.fn((signal: AbortSignal) => {
        capturedSignal = signal
        return new Promise<never>(() => undefined)
      }),
    }
    const supabase = { rpc: jest.fn().mockReturnValue(query) }

    const operation = cleanupLeaderboardRankPublication(supabase as never, input(), {
      signal: controller.signal,
    })
    controller.abort(new Error('cron budget exhausted'))
    await captureCleanupError(operation, 'rpc_aborted')

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('does not dispatch when the external signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const supabase = supabaseReturning(successfulResponse())

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input(), { signal: controller.signal }),
      'rpc_aborted'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([
    [
      'synchronous RPC throw',
      () => ({
        rpc: jest.fn(() => {
          throw new Error('client construction failed')
        }),
      }),
    ],
    [
      'throwing then getter',
      () => ({
        rpc: jest.fn(() =>
          Object.defineProperty({}, 'then', {
            get() {
              throw new Error('then getter trap')
            },
          })
        ),
      }),
    ],
    [
      'throwing AbortSignal getter',
      () => ({
        rpc: jest.fn(() =>
          Object.defineProperties(
            {},
            {
              then: { value: jest.fn() },
              abortSignal: {
                get() {
                  throw new Error('abort getter trap')
                },
              },
            }
          )
        ),
      }),
    ],
    [
      'non-awaitable AbortSignal result',
      () => ({ rpc: jest.fn(() => ({ abortSignal: jest.fn(() => ({ then: 42 })) })) }),
    ],
    [
      'throwing AbortSignal binder',
      () => ({
        rpc: jest.fn(() => ({
          abortSignal: jest.fn(() => {
            throw new Error('bind trap')
          }),
        })),
      }),
    ],
    [
      'synchronously throwing thenable',
      () => ({
        rpc: jest.fn(() => ({
          then: () => {
            throw new Error('then call trap')
          },
        })),
      }),
    ],
  ])('fails a pre-dispatch thenable trap without retrying: %s', async (_label, makeClient) => {
    const supabase = makeClient()

    await captureCleanupError(
      cleanupLeaderboardRankPublication(supabase as never, input()),
      'rpc_call_error'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })
})
