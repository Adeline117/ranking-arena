/**
 * @jest-environment node
 */

import {
  LEADERBOARD_PUBLICATION_PROOFS_MAX_REQUEST_BYTES,
  LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCE_LENGTH,
  LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCES,
  LEADERBOARD_PUBLICATION_PROOFS_MAX_TIMEOUT_MS,
  LEADERBOARD_PUBLICATION_PROOFS_MAX_TRADERS,
  ReadPublicationProofsError,
  readLeaderboardPublicationProofs as readPublicationProofsAtRuntime,
  type ReadPublicationProofsErrorCode,
} from '../read-publication-proofs'

const COHORT_ID = '123e4567-e89b-12d3-a456-426614174000'
const OTHER_COHORT_ID = '223e4567-e89b-12d3-a456-426614174000'
const RECORDED_AT = '2026-07-24T04:00:00.123456+00:00'
const NOW = new Date('2026-07-24T12:00:00.000Z')

function readLeaderboardPublicationProofs(
  supabase: Parameters<typeof readPublicationProofsAtRuntime>[0],
  request: Parameters<typeof readPublicationProofsAtRuntime>[1],
  options: Parameters<typeof readPublicationProofsAtRuntime>[2] = {}
) {
  return readPublicationProofsAtRuntime(supabase, request, { now: NOW, ...options })
}

function proofRow(source: string, overrides: Record<string, unknown> = {}) {
  const sequence = source === 'alpha' ? 0 : 4
  return {
    season_id: '30D',
    source,
    source_as_of: source === 'alpha' ? '2026-07-23T23:00:00Z' : '2026-07-24T01:02:03.12+01:30',
    recorded_at: RECORDED_AT,
    score_cohort_id: COHORT_ID,
    rank_mutation_seq: sequence,
    current_mutation_seq: sequence,
    published_rank_count: source === 'alpha' ? 0 : 2,
    published_identity_sha256: source === 'alpha' ? 'a'.repeat(64) : 'b'.repeat(64),
    is_sealed: true,
    ...overrides,
  }
}

function successfulRows() {
  return [proofRow('alpha'), proofRow('beta')]
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    season: '30D' as const,
    sources: ['beta', 'alpha'],
    ...overrides,
  }
}

function supabaseReturning(data: unknown, error: unknown = null) {
  return {
    rpc: jest.fn().mockResolvedValue({ data, error, status: error == null ? 200 : 400 }),
  }
}

async function captureError(
  operation: Promise<unknown>,
  expectedCode: ReadPublicationProofsErrorCode
): Promise<ReadPublicationProofsError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(ReadPublicationProofsError)
    expect((error as ReadPublicationProofsError).code).toBe(expectedCode)
    return error as ReadPublicationProofsError
  }
  throw new Error(`expected ReadPublicationProofsError(${expectedCode})`)
}

describe('readLeaderboardPublicationProofs', () => {
  it('calls the dormant runtime RPC with canonical arguments and returns one sealed cohort', async () => {
    const supabase = supabaseReturning(successfulRows())

    const result = await readLeaderboardPublicationProofs(supabase as never, input())

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('arena_leaderboard_publication_proofs', {
      p_season_id: '30D',
      p_sources: ['alpha', 'beta'],
    })
    expect(result).toEqual({
      state: 'sealed',
      season: '30D',
      scoreCohortId: COHORT_ID,
      proofs: [
        {
          ...proofRow('alpha'),
          source_as_of: '2026-07-23T23:00:00.000000Z',
          recorded_at: '2026-07-24T04:00:00.123456Z',
        },
        {
          ...proofRow('beta'),
          source_as_of: '2026-07-23T23:32:03.120000Z',
          recorded_at: '2026-07-24T04:00:00.123456Z',
        },
      ],
    })
    expect(result.proofs[0].published_rank_count).toBe(0)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.proofs)).toBe(true)
    expect(result.proofs.every((proof) => Object.isFrozen(proof))).toBe(true)
  })

  it('uses one default call-start clock when now is omitted', async () => {
    jest.useFakeTimers()
    try {
      jest.setSystemTime(NOW)
      const supabase = supabaseReturning(successfulRows())

      await expect(
        readPublicationProofsAtRuntime(supabase as never, input())
      ).resolves.toMatchObject({ state: 'sealed', scoreCohortId: COHORT_ID })
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects the exact stale cutoff and accepts one microsecond newer', async () => {
    const exactCutoff = supabaseReturning([
      proofRow('alpha', { source_as_of: '2026-07-22T12:00:00.000000Z' }),
      proofRow('beta'),
    ])
    await captureError(
      readLeaderboardPublicationProofs(exactCutoff as never, input()),
      'rpc_shape_mismatch'
    )
    expect(exactCutoff.rpc).toHaveBeenCalledTimes(1)

    const newer = supabaseReturning([
      proofRow('alpha', { source_as_of: '2026-07-22T12:00:00.000001Z' }),
      proofRow('beta'),
    ])
    await expect(readLeaderboardPublicationProofs(newer as never, input())).resolves.toMatchObject({
      state: 'sealed',
      proofs: [{ source: 'alpha', source_as_of: '2026-07-22T12:00:00.000001Z' }, {}],
    })
  })

  it('rejects future source and publication timestamps beyond the five-minute tolerance', async () => {
    const futureSource = supabaseReturning([
      proofRow('alpha', {
        source_as_of: '2026-07-24T12:05:00.000001Z',
        recorded_at: '2026-07-24T12:00:00.000000Z',
      }),
      proofRow('beta', { recorded_at: '2026-07-24T12:00:00.000000Z' }),
    ])
    const sourceError = await captureError(
      readLeaderboardPublicationProofs(futureSource as never, input()),
      'rpc_shape_mismatch'
    )
    expect(sourceError.message).toContain('not currently fresh')

    const futureRecordedAt = '2026-07-24T12:05:00.000001Z'
    const futurePublication = supabaseReturning([
      proofRow('alpha', { recorded_at: futureRecordedAt }),
      proofRow('beta', { recorded_at: futureRecordedAt }),
    ])
    const publicationError = await captureError(
      readLeaderboardPublicationProofs(futurePublication as never, input()),
      'rpc_shape_mismatch'
    )
    expect(publicationError.message).toContain('publication timestamp is in the future')
  })

  it('does not let an all-zero cohort bypass source freshness', async () => {
    const allZeroStale = supabaseReturning([
      proofRow('alpha', {
        source_as_of: '2026-07-22T12:00:00.000000Z',
        published_rank_count: 0,
      }),
      proofRow('beta', {
        source_as_of: '2026-07-22T11:59:59.999999Z',
        published_rank_count: 0,
      }),
    ])

    await captureError(
      readLeaderboardPublicationProofs(allZeroStale as never, input()),
      'rpc_shape_mismatch'
    )
    expect(allZeroStale.rpc).toHaveBeenCalledTimes(1)
  })

  it('accepts zero counts but bounds each source and the season total to 250000', async () => {
    const exactLimit = supabaseReturning([
      proofRow('alpha', { published_rank_count: 125_000 }),
      proofRow('beta', { published_rank_count: 125_000 }),
    ])
    await expect(
      readLeaderboardPublicationProofs(exactLimit as never, input())
    ).resolves.toMatchObject({ state: 'sealed' })

    const sourceOverflow = supabaseReturning([
      proofRow('alpha', {
        published_rank_count: LEADERBOARD_PUBLICATION_PROOFS_MAX_TRADERS + 1,
      }),
      proofRow('beta'),
    ])
    await captureError(
      readLeaderboardPublicationProofs(sourceOverflow as never, input()),
      'rpc_shape_mismatch'
    )

    const totalOverflow = supabaseReturning([
      proofRow('alpha', { published_rank_count: 125_000 }),
      proofRow('beta', { published_rank_count: 125_001 }),
    ])
    const totalError = await captureError(
      readLeaderboardPublicationProofs(totalOverflow as never, input()),
      'rpc_shape_mismatch'
    )
    expect(totalError.message).toContain('total rank count exceeds')
  })

  it.each([
    ['lowercase season', { season: '30d' }],
    ['whitespace season', { season: ' 30D' }],
    ['empty sources', { sources: [] }],
    [
      'too many sources',
      {
        sources: Array.from(
          { length: LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCES + 1 },
          (_, index) => `source_${index}`
        ),
      },
    ],
    ['uppercase source', { sources: ['Alpha'] }],
    ['hyphenated source', { sources: ['alpha-beta'] }],
    ['whitespace source', { sources: [' alpha'] }],
    ['duplicate source', { sources: ['alpha', 'alpha'] }],
    ['unknown input field', { extra: true }],
  ])('rejects non-canonical input before dispatch: %s', async (_label, overrides) => {
    const supabase = supabaseReturning(successfulRows())

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input(overrides)),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('accepts a 128-character source and rejects 129 characters before dispatch', async () => {
    const exactSource = 'a'.repeat(LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCE_LENGTH)
    const exactSupabase = supabaseReturning([proofRow(exactSource)])

    await expect(
      readLeaderboardPublicationProofs(exactSupabase as never, input({ sources: [exactSource] }))
    ).resolves.toMatchObject({ state: 'sealed', proofs: [{ source: exactSource }] })
    expect(exactSupabase.rpc).toHaveBeenCalledTimes(1)

    const oversizedSupabase = supabaseReturning([])
    await captureError(
      readLeaderboardPublicationProofs(
        oversizedSupabase as never,
        input({ sources: ['a'.repeat(LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCE_LENGTH + 1)] })
      ),
      'invalid_input'
    )
    expect(oversizedSupabase.rpc).not.toHaveBeenCalled()
  })

  it('keeps the maximum legal canonical RPC args below the explicit 64 KiB bound', async () => {
    const sources = Array.from(
      { length: LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCES },
      (_, index) => `source_${index.toString().padStart(3, '0')}_${'a'.repeat(117)}`
    )
    expect(
      sources.every((source) => source.length === LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCE_LENGTH)
    ).toBe(true)
    const rows = [...sources].sort().map((source) => proofRow(source, { published_rank_count: 0 }))
    const supabase = supabaseReturning(rows)

    await expect(
      readLeaderboardPublicationProofs(supabase as never, input({ sources }))
    ).resolves.toMatchObject({ state: 'sealed' })

    const dispatchedArgs = supabase.rpc.mock.calls[0][1]
    expect(LEADERBOARD_PUBLICATION_PROOFS_MAX_REQUEST_BYTES).toBe(65_536)
    expect(new TextEncoder().encode(JSON.stringify(dispatchedArgs)).byteLength).toBe(33_571)
  })

  it('converts an input inspection trap into a typed invalid-input error', async () => {
    const trappedInput = new Proxy(input(), {
      ownKeys() {
        throw new Error('input ownKeys trap')
      },
    })
    const supabase = supabaseReturning(successfulRows())

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, trappedInput),
      'invalid_input'
    )
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('snapshots a stateful season once and rejects its first invalid value before dispatch', async () => {
    let seasonReads = 0
    const statefulInput = Object.defineProperties(
      {},
      {
        season: {
          enumerable: true,
          get() {
            seasonReads += 1
            return seasonReads === 1 ? '30d' : '30D'
          },
        },
        sources: {
          enumerable: true,
          value: ['alpha'],
        },
      }
    )
    const supabase = supabaseReturning([proofRow('alpha')])

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, statefulInput as never),
      'invalid_input'
    )

    expect(seasonReads).toBe(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('snapshots a stateful sources property once and rejects its first empty value', async () => {
    let sourceReads = 0
    const statefulInput = Object.defineProperties(
      {},
      {
        season: {
          enumerable: true,
          value: '30D',
        },
        sources: {
          enumerable: true,
          get() {
            sourceReads += 1
            return sourceReads === 1 ? [] : ['alpha']
          },
        },
      }
    )
    const supabase = supabaseReturning([proofRow('alpha')])

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, statefulInput as never),
      'invalid_input'
    )

    expect(sourceReads).toBe(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects an invalid Date and converts a now getter trap into typed invalid input', async () => {
    const invalidDateSupabase = supabaseReturning(successfulRows())
    await captureError(
      readLeaderboardPublicationProofs(invalidDateSupabase as never, input(), {
        now: new Date(Number.NaN),
      }),
      'invalid_input'
    )
    expect(invalidDateSupabase.rpc).not.toHaveBeenCalled()

    const trappedOptions = Object.defineProperty({}, 'now', {
      get() {
        throw new Error('now getter trap')
      },
    })
    const trappedSupabase = supabaseReturning(successfulRows())
    await captureError(
      readPublicationProofsAtRuntime(trappedSupabase as never, input(), trappedOptions),
      'invalid_input'
    )
    expect(trappedSupabase.rpc).not.toHaveBeenCalled()
  })

  it('snapshots every options property exactly once', async () => {
    const reads = { timeoutMs: 0, signal: 0, now: 0 }
    const statefulOptions = Object.defineProperties(
      {},
      {
        timeoutMs: {
          get() {
            reads.timeoutMs += 1
            if (reads.timeoutMs > 1) throw new Error('timeoutMs read twice')
            return 100
          },
        },
        signal: {
          get() {
            reads.signal += 1
            if (reads.signal > 1) throw new Error('signal read twice')
            return undefined
          },
        },
        now: {
          get() {
            reads.now += 1
            if (reads.now > 1) throw new Error('now read twice')
            return NOW
          },
        },
      }
    )
    const supabase = supabaseReturning(successfulRows())

    await expect(
      readPublicationProofsAtRuntime(supabase as never, input(), statefulOptions)
    ).resolves.toMatchObject({ state: 'sealed' })

    expect(reads).toEqual({ timeoutMs: 1, signal: 1, now: 1 })
  })

  it('rejects a structurally forged AbortSignal before dispatch', async () => {
    const forgedSignal = {
      aborted: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }
    const supabase = supabaseReturning(successfulRows())

    await captureError(
      readPublicationProofsAtRuntime(supabase as never, input(), {
        now: NOW,
        signal: forgedSignal as never,
      }),
      'invalid_input'
    )
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, LEADERBOARD_PUBLICATION_PROOFS_MAX_TIMEOUT_MS + 1])(
    'rejects invalid timeout %s before dispatch',
    async (timeoutMs) => {
      const supabase = supabaseReturning(successfulRows())

      await captureError(
        readLeaderboardPublicationProofs(supabase as never, input(), { timeoutMs }),
        'invalid_input'
      )
      expect(supabase.rpc).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['empty response', []],
    ['missing response row', [proofRow('alpha')]],
    ['extra response row', [...successfulRows(), proofRow('gamma')]],
    ['duplicate response source', [proofRow('alpha'), proofRow('alpha')]],
    ['unsorted response', [proofRow('beta'), proofRow('alpha')]],
    ['null row', [null, proofRow('beta')]],
  ])('rejects an inexact response source set without retry: %s', async (_label, rows) => {
    const supabase = supabaseReturning(rows)

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_shape_mismatch'
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['wrong season', { season_id: '7D' }],
    ['unsealed row', { is_sealed: false }],
    ['null seal', { is_sealed: null }],
    ['non-canonical cohort', { score_cohort_id: COHORT_ID.toUpperCase() }],
    ['fence advance', { current_mutation_seq: 5 }],
    ['negative rank sequence', { rank_mutation_seq: -1 }],
    ['fractional current sequence', { current_mutation_seq: 0.5 }],
    ['unsafe sequence', { rank_mutation_seq: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative published count', { published_rank_count: -1 }],
    ['fractional published count', { published_rank_count: 0.5 }],
    ['uppercase digest', { published_identity_sha256: 'A'.repeat(64) }],
    ['short digest', { published_identity_sha256: 'a'.repeat(63) }],
    ['date-only source timestamp', { source_as_of: '2026-07-24' }],
    ['impossible source timestamp', { source_as_of: '2026-02-30T00:00:00Z' }],
    ['nanosecond source timestamp', { source_as_of: '2026-07-24T00:00:00.1234567Z' }],
    ['invalid recorded timezone', { recorded_at: '2026-07-24T04:00:00+24:00' }],
    ['source timestamp beyond seal tolerance', { source_as_of: '2026-07-24T04:05:01Z' }],
    ['unknown field', { unexpected: true }],
  ])('rejects an untrusted proof row without retry: %s', async (_label, overrides) => {
    const supabase = supabaseReturning([proofRow('alpha', overrides), proofRow('beta')])

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_shape_mismatch'
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('rejects a proof row with a missing migration field', async () => {
    const { current_mutation_seq: _omitted, ...missingField } = proofRow('alpha')
    const supabase = supabaseReturning([missingField, proofRow('beta')])

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_shape_mismatch'
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('rejects mixed cohorts even when every individual row claims to be sealed', async () => {
    const supabase = supabaseReturning([
      proofRow('alpha'),
      proofRow('beta', { score_cohort_id: OTHER_COHORT_ID }),
    ])

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_shape_mismatch'
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('rejects multiple publication timestamps inside one cohort', async () => {
    const supabase = supabaseReturning([
      proofRow('alpha'),
      proofRow('beta', { recorded_at: '2026-07-24T04:00:01.123456Z' }),
    ])

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_shape_mismatch'
    )
  })

  it('converts a row ownKeys trap into a typed shape error without retry', async () => {
    const trappedRow = new Proxy(proofRow('alpha'), {
      ownKeys() {
        throw new Error('row ownKeys trap')
      },
    })
    const supabase = supabaseReturning([trappedRow, proofRow('beta')])

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_shape_mismatch'
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('snapshots every proof field once before validating and returning it', async () => {
    const expected = proofRow('alpha')
    const reads = new Map<string, number>()
    const statefulRow = Object.create(null) as Record<string, unknown>

    for (const [key, value] of Object.entries(expected)) {
      Object.defineProperty(statefulRow, key, {
        enumerable: true,
        get() {
          const readCount = (reads.get(key) ?? 0) + 1
          reads.set(key, readCount)
          if (readCount > 2 && key === 'score_cohort_id') return 'not-a-uuid'
          if (readCount > 2 && key === 'published_identity_sha256') return 'not-a-digest'
          if (readCount > 1 && key !== 'score_cohort_id' && key !== 'published_identity_sha256') {
            throw new Error(`${key} read twice`)
          }
          return value
        },
      })
    }
    const supabase = supabaseReturning([statefulRow])

    await expect(
      readLeaderboardPublicationProofs(
        supabase as never,
        input({ season: '30D', sources: ['alpha'] })
      )
    ).resolves.toMatchObject({
      state: 'sealed',
      scoreCohortId: COHORT_ID,
      proofs: [
        {
          score_cohort_id: COHORT_ID,
          published_identity_sha256: 'a'.repeat(64),
        },
      ],
    })
    expect(Object.keys(expected).every((key) => reads.get(key) === 1)).toBe(true)
  })

  it('converts an envelope property trap into a typed deterministic error', async () => {
    const envelope = new Proxy(
      { data: successfulRows(), error: null },
      {
        get(target, property, receiver) {
          if (property === 'error') throw new Error('envelope get trap')
          return Reflect.get(target, property, receiver)
        },
      }
    )
    const supabase = { rpc: jest.fn().mockResolvedValue(envelope) }

    await captureError(readLeaderboardPublicationProofs(supabase as never, input()), 'rpc_error')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('snapshots status, error, and data from a successful envelope exactly once', async () => {
    const reads = { status: 0, error: 0, data: 0 }
    const envelope = Object.defineProperties(
      {},
      {
        status: {
          get() {
            reads.status += 1
            if (reads.status > 1) throw new Error('status read twice')
            return 200
          },
        },
        error: {
          get() {
            reads.error += 1
            if (reads.error > 1) throw new Error('error read twice')
            return null
          },
        },
        data: {
          get() {
            reads.data += 1
            if (reads.data > 1) throw new Error('data read twice')
            return successfulRows()
          },
        },
      }
    )
    const supabase = { rpc: jest.fn().mockResolvedValue(envelope) }

    await expect(
      readLeaderboardPublicationProofs(supabase as never, input())
    ).resolves.toMatchObject({ state: 'sealed' })

    expect(reads).toEqual({ status: 1, error: 1, data: 1 })
  })

  it('does not retry a deterministic RPC error', async () => {
    const supabase = supabaseReturning(null, {
      code: '22023',
      message: 'proof sources are invalid or duplicated',
    })

    const error = await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_error'
    )
    expect(error.message).toContain('22023')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('snapshots nested RPC error fields exactly once', async () => {
    const reads = { code: 0, message: 0 }
    const statefulError = Object.defineProperties(
      {},
      {
        code: {
          get() {
            reads.code += 1
            if (reads.code > 1) throw new Error('code read twice')
            return '22023'
          },
        },
        message: {
          get() {
            reads.message += 1
            if (reads.message > 1) throw new Error('message read twice')
            return 'full authority required'
          },
        },
      }
    )
    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data: null, error: statefulError, status: 400 }),
    }

    const error = await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_error'
    )
    expect(error.message).toContain('22023')
    expect(reads).toEqual({ code: 1, message: 1 })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it.each([502, 503, 504])(
    'retries one unstructured gateway status %i with the same frozen args',
    async (status) => {
      const supabase = {
        rpc: jest
          .fn()
          .mockResolvedValueOnce({ data: successfulRows(), error: null, status })
          .mockResolvedValueOnce({ data: successfulRows(), error: null, status: 200 }),
      }

      await expect(
        readLeaderboardPublicationProofs(supabase as never, input())
      ).resolves.toMatchObject({ state: 'sealed' })
      expect(supabase.rpc).toHaveBeenCalledTimes(2)
      expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
      expect(Object.isFrozen(supabase.rpc.mock.calls[0][1])).toBe(true)
    }
  )

  it('does not retry a structured gateway SQL/PostgREST error', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { code: 'PGRST003', message: 'database unavailable' },
        status: 504,
      }),
    }

    const error = await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_error'
    )
    expect(error.message).toContain('PGRST003')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('never accepts valid-looking proof data from a failed HTTP status', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data: successfulRows(), error: null, status: 500 }),
    }

    const error = await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_error'
    )
    expect(error.message).toContain('HTTP status 500')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('does not authorize proof data when the transport status is missing', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data: successfulRows(), error: null }),
    }

    const error = await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_error'
    )
    expect(error.message).toContain('invalid HTTP status')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('retries one Supabase transport status 0 envelope with the same canonical args', async () => {
    const transportEnvelope = {
      data: null,
      error: { code: '', message: 'TypeError: Failed to fetch' },
      status: 0,
      statusText: '',
    }
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce(transportEnvelope)
        .mockResolvedValueOnce({ data: successfulRows(), error: null, status: 200 }),
    }

    await expect(
      readLeaderboardPublicationProofs(supabase as never, input())
    ).resolves.toMatchObject({ state: 'sealed', scoreCohortId: COHORT_ID })
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
  })

  it('reports rpc_ambiguous when both Supabase envelopes have transport status 0', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { code: '', message: 'TypeError: Failed to fetch' },
        status: 0,
      }),
    }

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_ambiguous'
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
  })

  it('reports caller abort instead of retrying an ambiguous status 0 envelope', async () => {
    const controller = new AbortController()
    const envelope = {
      data: null,
      error: { code: '', message: 'TypeError: Failed to fetch' },
      get status() {
        controller.abort(new Error('cron deadline exhausted'))
        return 0
      },
    }
    const supabase = { rpc: jest.fn().mockResolvedValue(envelope) }

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input(), {
        signal: controller.signal,
      }),
      'rpc_aborted'
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('does not retry null data or a missing envelope', async () => {
    const nullSupabase = supabaseReturning(null)
    await captureError(readLeaderboardPublicationProofs(nullSupabase as never, input()), 'rpc_null')
    expect(nullSupabase.rpc).toHaveBeenCalledTimes(1)

    const missingSupabase = { rpc: jest.fn().mockResolvedValue(undefined) }
    await captureError(
      readLeaderboardPublicationProofs(missingSupabase as never, input()),
      'rpc_error'
    )
    expect(missingSupabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('retries one transport response loss with the exact same canonical argument object', async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockRejectedValueOnce(new TypeError('connection reset after request write'))
        .mockResolvedValueOnce({ data: successfulRows(), error: null, status: 200 }),
    }

    await expect(
      readLeaderboardPublicationProofs(supabase as never, input())
    ).resolves.toMatchObject({ state: 'sealed', scoreCohortId: COHORT_ID })
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
    expect(supabase.rpc.mock.calls[0][1]).toEqual({
      p_season_id: '30D',
      p_sources: ['alpha', 'beta'],
    })
  })

  it('snapshots query and bound-awaitable terminators exactly once', async () => {
    const reads = { queryThen: 0, abortSignal: 0, boundThen: 0 }
    const boundAwaitable = Object.defineProperty({}, 'then', {
      get() {
        reads.boundThen += 1
        if (reads.boundThen > 1) throw new Error('bound then read twice')
        return (resolve: (value: unknown) => void) =>
          resolve({ data: successfulRows(), error: null, status: 200 })
      },
    })
    const query = Object.defineProperties(
      {},
      {
        then: {
          get() {
            reads.queryThen += 1
            if (reads.queryThen > 1) throw new Error('query then read twice')
            return (_resolve: (value: unknown) => void) => undefined
          },
        },
        abortSignal: {
          get() {
            reads.abortSignal += 1
            if (reads.abortSignal > 1) throw new Error('abortSignal read twice')
            return () => boundAwaitable
          },
        },
      }
    )
    const supabase = { rpc: jest.fn().mockReturnValue(query) }

    await expect(
      readLeaderboardPublicationProofs(supabase as never, input())
    ).resolves.toMatchObject({ state: 'sealed' })
    expect(reads).toEqual({ queryThen: 1, abortSignal: 1, boundThen: 1 })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('snapshots a direct query then getter exactly once', async () => {
    let thenReads = 0
    const query = Object.defineProperty({}, 'then', {
      get() {
        thenReads += 1
        if (thenReads > 1) throw new Error('direct then read twice')
        return (resolve: (value: unknown) => void) =>
          resolve({ data: successfulRows(), error: null, status: 200 })
      },
    })
    const supabase = { rpc: jest.fn().mockReturnValue(query) }

    await expect(
      readLeaderboardPublicationProofs(supabase as never, input())
    ).resolves.toMatchObject({ state: 'sealed' })
    expect(thenReads).toBe(1)
  })

  it('stops after the sole retry when both transport responses are lost', async () => {
    const supabase = { rpc: jest.fn().mockRejectedValue(new TypeError('connection reset')) }

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input()),
      'rpc_ambiguous'
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it('retries one timeout with a fresh AbortSignal and the same arguments', async () => {
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
          return Promise.resolve({ data: successfulRows(), error: null, status: 200 })
        }),
      }
      const supabase = {
        rpc: jest.fn().mockReturnValueOnce(firstQuery).mockReturnValueOnce(secondQuery),
      }

      const operation = readLeaderboardPublicationProofs(supabase as never, input(), {
        timeoutMs: 25,
      })
      await jest.advanceTimersByTimeAsync(25)
      await expect(operation).resolves.toMatchObject({ state: 'sealed' })

      expect(supabase.rpc).toHaveBeenCalledTimes(2)
      expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
      expect(capturedSignals).toHaveLength(2)
      expect(capturedSignals[0].aborted).toBe(true)
      expect(capturedSignals[1].aborted).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('reports a typed timeout after the sole retry also expires', async () => {
    jest.useFakeTimers()
    try {
      const query = {
        abortSignal: jest.fn(() => new Promise<never>(() => undefined)),
      }
      const supabase = { rpc: jest.fn().mockReturnValue(query) }
      const operation = readLeaderboardPublicationProofs(supabase as never, input(), {
        timeoutMs: 10,
      })
      const captured = captureError(operation, 'rpc_timeout')

      await jest.advanceTimersByTimeAsync(20)
      await captured
      expect(supabase.rpc).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('honors an external AbortSignal without retrying', async () => {
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    const query = {
      abortSignal: jest.fn((signal: AbortSignal) => {
        capturedSignal = signal
        return new Promise<never>(() => undefined)
      }),
    }
    const supabase = { rpc: jest.fn().mockReturnValue(query) }

    const operation = readLeaderboardPublicationProofs(supabase as never, input(), {
      signal: controller.signal,
    })
    controller.abort(new Error('cron deadline exhausted'))
    await captureError(operation, 'rpc_aborted')

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('does not dispatch for an already-aborted caller signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const supabase = supabaseReturning(successfulRows())

    await captureError(
      readLeaderboardPublicationProofs(supabase as never, input(), {
        signal: controller.signal,
      }),
      'rpc_aborted'
    )
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('does not retry synchronous client, RPC getter, or AbortSignal binding traps', async () => {
    const throwingCall = {
      rpc: jest.fn(() => {
        throw new Error('client construction failed')
      }),
    }
    await captureError(
      readLeaderboardPublicationProofs(throwingCall as never, input()),
      'rpc_call_error'
    )
    expect(throwingCall.rpc).toHaveBeenCalledTimes(1)

    const getterTrap = new Proxy(
      {},
      {
        get() {
          throw new Error('rpc getter trap')
        },
      }
    )
    await captureError(
      readLeaderboardPublicationProofs(getterTrap as never, input()),
      'rpc_call_error'
    )

    const bindingQuery = {
      abortSignal: jest.fn(() => {
        throw new Error('AbortSignal binding trap')
      }),
    }
    const bindingSupabase = { rpc: jest.fn().mockReturnValue(bindingQuery) }
    await captureError(
      readLeaderboardPublicationProofs(bindingSupabase as never, input()),
      'rpc_call_error'
    )
    expect(bindingSupabase.rpc).toHaveBeenCalledTimes(1)
  })
})
