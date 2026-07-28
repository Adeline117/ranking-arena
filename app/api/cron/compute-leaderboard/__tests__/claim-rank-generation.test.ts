/**
 * @jest-environment node
 */

import {
  ClaimRankGenerationError,
  LEADERBOARD_RANK_GENERATION_CLAIM_CONTRACT,
  LEADERBOARD_RANK_GENERATION_MAX_BATCHES,
  LEADERBOARD_RANK_GENERATION_MAX_ROWS,
  LEADERBOARD_RANK_GENERATION_MAX_ROWS_PER_BATCH,
  LEADERBOARD_RANK_GENERATION_MAX_SEQUENCE,
  claimLeaderboardRankGeneration,
  type ClaimRankGenerationErrorCode,
} from '../claim-rank-generation'

const COHORT_ID = '123e4567-e89b-42d3-a456-426614174000'
const WRITE_SET_SHA256 = 'a'.repeat(64)
const COMPUTED_AT = '2026-07-25T00:00:00.000000Z'
const CLAIMED_AT = '2026-07-28T12:00:00.123456Z'
const LEASE_EXPIRES_AT = '2026-07-28T12:00:30.123456Z'

function input(overrides: Record<string, unknown> = {}) {
  return {
    season: '90D' as const,
    scoreCohortId: COHORT_ID,
    writeSetSha256: WRITE_SET_SHA256,
    expectedRankCount: 2,
    expectedBatchCount: 1,
    computedAt: '2026-07-25T00:00:00Z',
    leaseSeconds: 30,
    ...overrides,
  }
}

function successfulResponse(overrides: Record<string, unknown> = {}) {
  return {
    contract: LEADERBOARD_RANK_GENERATION_CLAIM_CONTRACT,
    season_id: '90D',
    score_cohort_id: COHORT_ID,
    generation_seq: 1,
    phase: 'claimed',
    write_set_sha256: WRITE_SET_SHA256,
    expected_rank_count: 2,
    expected_batch_count: 1,
    computed_at: COMPUTED_AT,
    claimed_at: CLAIMED_AT,
    lease_expires_at: LEASE_EXPIRES_AT,
    ...overrides,
  }
}

function envelope(
  data: unknown = successfulResponse(),
  error: unknown = null,
  status: unknown = 200
) {
  return { data, error, status }
}

function supabaseReturning(response: unknown) {
  return { rpc: jest.fn().mockResolvedValue(response) }
}

async function captureClaimError(
  operation: Promise<unknown>,
  expectedCode: ClaimRankGenerationErrorCode
): Promise<ClaimRankGenerationError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimRankGenerationError)
    expect((error as ClaimRankGenerationError).code).toBe(expectedCode)
    return error as ClaimRankGenerationError
  }
  throw new Error(`expected ClaimRankGenerationError(${expectedCode})`)
}

describe('claimLeaderboardRankGeneration', () => {
  it('sends one exact frozen canonical request and accepts a numeric 2xx envelope', async () => {
    const supabase = supabaseReturning(envelope(successfulResponse(), null, 201))

    const result = await claimLeaderboardRankGeneration(
      supabase as never,
      input({ computedAt: '2026-07-25T01:30:00+01:30' })
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('claim_leaderboard_rank_generation', {
      p_season_id: '90D',
      p_score_cohort_id: COHORT_ID,
      p_write_set_sha256: WRITE_SET_SHA256,
      p_expected_rank_count: 2,
      p_expected_batch_count: 1,
      p_computed_at: COMPUTED_AT,
      p_lease_seconds: 30,
    })
    const args = supabase.rpc.mock.calls[0][1]
    expect(Object.keys(args)).toEqual([
      'p_season_id',
      'p_score_cohort_id',
      'p_write_set_sha256',
      'p_expected_rank_count',
      'p_expected_batch_count',
      'p_computed_at',
      'p_lease_seconds',
    ])
    expect(Object.isFrozen(args)).toBe(true)
    expect(result).toEqual(successfulResponse())
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('accepts the only valid empty generation count pair', async () => {
    const supabase = supabaseReturning(
      envelope(successfulResponse({ expected_rank_count: 0, expected_batch_count: 0 }))
    )

    await expect(
      claimLeaderboardRankGeneration(
        supabase as never,
        input({ expectedRankCount: 0, expectedBatchCount: 0 })
      )
    ).resolves.toMatchObject({ expected_rank_count: 0, expected_batch_count: 0 })
  })

  it('reads then once when AbortSignal binding returns the same mutable query', async () => {
    let thenReads = 0
    const realThen = (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
      Promise.resolve(envelope()).then(resolve, reject)
    const forgedThen = (resolve: (value: unknown) => void) =>
      resolve(envelope(successfulResponse({ generation_seq: 999 })))
    const query = Object.defineProperties(
      {
        abortSignal() {
          return query
        },
      },
      {
        then: {
          get() {
            thenReads += 1
            return thenReads === 1 ? realThen : forgedThen
          },
        },
      }
    )
    const supabase = { rpc: jest.fn(() => query) }

    await expect(claimLeaderboardRankGeneration(supabase as never, input())).resolves.toEqual(
      successfulResponse()
    )

    expect(thenReads).toBe(1)
  })

  it('snapshots every top-level input accessor exactly once', async () => {
    const values = input()
    const reads = new Map<string, number>()
    const statefulInput = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          {
            enumerable: true,
            get() {
              reads.set(key, (reads.get(key) ?? 0) + 1)
              return reads.get(key) === 1 ? value : Symbol(`changed-${key}`)
            },
          },
        ])
      )
    )
    const supabase = supabaseReturning(envelope())

    await expect(
      claimLeaderboardRankGeneration(supabase as never, statefulInput as never)
    ).resolves.toEqual(successfulResponse())

    expect(Object.fromEntries(reads)).toEqual(
      Object.fromEntries(Object.keys(values).map((key) => [key, 1]))
    )
  })

  it.each([
    ['null input', null],
    ['array input', []],
    ['missing key', { ...input(), leaseSeconds: undefined }],
    ['invalid season', input({ season: '1D' })],
    ['uppercase UUID', input({ scoreCohortId: COHORT_ID.toUpperCase() })],
    ['non-canonical UUID', input({ scoreCohortId: COHORT_ID.replaceAll('-', '') })],
    ['uppercase digest', input({ writeSetSha256: WRITE_SET_SHA256.toUpperCase() })],
    ['short digest', input({ writeSetSha256: 'a'.repeat(63) })],
  ])('rejects %s before dispatch', async (_label, candidate) => {
    const actualCandidate =
      _label === 'missing key'
        ? Object.fromEntries(
            Object.entries(candidate as object).filter(([key]) => key !== 'leaseSeconds')
          )
        : candidate
    const supabase = supabaseReturning(envelope())

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, actualCandidate as never),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects an extra input key before dispatch', async () => {
    const supabase = supabaseReturning(envelope())

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, { ...input(), extra: true } as never),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['negative rank count', { expectedRankCount: -1 }],
    ['fractional rank count', { expectedRankCount: 1.5 }],
    ['unsafe rank count', { expectedRankCount: Number.MAX_SAFE_INTEGER + 1 }],
    ['rank count above bound', { expectedRankCount: LEADERBOARD_RANK_GENERATION_MAX_ROWS + 1 }],
    ['negative batch count', { expectedBatchCount: -1 }],
    ['fractional batch count', { expectedBatchCount: 1.5 }],
    [
      'batch count above bound',
      { expectedBatchCount: LEADERBOARD_RANK_GENERATION_MAX_BATCHES + 1 },
    ],
    ['empty ranks with a batch', { expectedRankCount: 0, expectedBatchCount: 1 }],
    ['nonempty ranks without a batch', { expectedRankCount: 1, expectedBatchCount: 0 }],
    ['more batches than rows', { expectedRankCount: 2, expectedBatchCount: 3 }],
    [
      'more rows than batch capacity',
      {
        expectedRankCount: LEADERBOARD_RANK_GENERATION_MAX_ROWS_PER_BATCH + 1,
        expectedBatchCount: 1,
      },
    ],
  ])('rejects %s', async (_label, overrides) => {
    const supabase = supabaseReturning(envelope())

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input(overrides)),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['lease below minimum', 14],
    ['lease above maximum', 301],
    ['fractional lease', 30.5],
    ['non-numeric lease', '30'],
  ])('rejects %s', async (_label, leaseSeconds) => {
    const supabase = supabaseReturning(envelope())

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input({ leaseSeconds })),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['non-string timestamp', 123],
    ['missing timezone', '2026-07-25T00:00:00'],
    ['space separator', '2026-07-25 00:00:00Z'],
    ['too many fraction digits', '2026-07-25T00:00:00.1234567Z'],
    ['invalid leap day', '2026-02-29T00:00:00Z'],
    ['invalid hour', '2026-07-25T24:00:00Z'],
    ['invalid timezone hour', '2026-07-25T00:00:00+24:00'],
    ['invalid timezone minute', '2026-07-25T00:00:00+01:60'],
    ['unsupported year', '0999-12-31T23:59:59Z'],
    ['offset crosses supported year', '1000-01-01T00:00:00+23:59'],
    ['offset crosses upper supported year', '9999-12-31T23:59:59-23:59'],
  ])('rejects %s', async (_label, computedAt) => {
    const supabase = supabaseReturning(envelope())

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input({ computedAt })),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('maps throwing input reflection to invalid_input without dispatch', async () => {
    const throwingInput = new Proxy(input(), {
      ownKeys() {
        throw new Error('hostile ownKeys')
      },
    })
    const supabase = supabaseReturning(envelope())

    const error = await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, throwingInput),
      'invalid_input'
    )

    expect(error.cause).toBeInstanceOf(Error)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('does not re-read an invalid getter to obtain a later valid value', async () => {
    let reads = 0
    const statefulInput = Object.defineProperty(input(), 'season', {
      enumerable: true,
      get() {
        reads += 1
        return reads === 1 ? 'invalid' : '90D'
      },
    })
    const supabase = supabaseReturning(envelope())

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, statefulInput as never),
      'invalid_input'
    )

    expect(reads).toBe(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['null options', null],
    ['array options', []],
    ['extra option', { extra: true }],
    ['zero timeout', { timeoutMs: 0 }],
    ['fractional timeout', { timeoutMs: 1.5 }],
    ['excessive timeout', { timeoutMs: 60_001 }],
    ['forged signal', { signal: { aborted: false } }],
    ['prototype-only forged signal', { signal: Object.create(AbortSignal.prototype) }],
  ])('rejects %s before dispatch', async (_label, options) => {
    const supabase = supabaseReturning(envelope())

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input(), options as never),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('snapshots each options getter once', async () => {
    let timeoutReads = 0
    let signalReads = 0
    const controller = new AbortController()
    const options = Object.defineProperties(
      {},
      {
        timeoutMs: {
          enumerable: true,
          get() {
            timeoutReads += 1
            return timeoutReads === 1 ? 100 : 0
          },
        },
        signal: {
          enumerable: true,
          get() {
            signalReads += 1
            return signalReads === 1 ? controller.signal : { aborted: false }
          },
        },
      }
    )
    const supabase = supabaseReturning(envelope())

    await expect(
      claimLeaderboardRankGeneration(supabase as never, input(), options)
    ).resolves.toEqual(successfulResponse())
    expect({ timeoutReads, signalReads }).toEqual({ timeoutReads: 1, signalReads: 1 })
  })

  it('derives the default timeout from one third of a short lease', async () => {
    const timeoutSpy = jest.spyOn(global, 'setTimeout')
    const supabase = supabaseReturning(
      envelope(
        successfulResponse({
          claimed_at: '2026-07-28T12:00:00.123456Z',
          lease_expires_at: '2026-07-28T12:00:15.123456Z',
        })
      )
    )

    try {
      await expect(
        claimLeaderboardRankGeneration(supabase as never, input({ leaseSeconds: 15 }))
      ).resolves.toMatchObject({ lease_expires_at: '2026-07-28T12:00:15.123456Z' })
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5_000)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it.each([
    [15, 5_001],
    [30, 10_001],
  ])(
    'rejects a %ss lease with a %sms timeout that leaves no replay margin',
    async (lease, timeout) => {
      const supabase = supabaseReturning(envelope())

      await captureClaimError(
        claimLeaderboardRankGeneration(supabase as never, input({ leaseSeconds: lease }), {
          timeoutMs: timeout,
        }),
        'invalid_input'
      )

      expect(supabase.rpc).not.toHaveBeenCalled()
    }
  )

  it('rejects a signal already aborted before RPC dispatch', async () => {
    const controller = new AbortController()
    controller.abort()
    const supabase = supabaseReturning(envelope())

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input(), { signal: controller.signal }),
      'rpc_aborted'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('marks a caller abort after dispatch as ambiguous because the DB may have committed', async () => {
    const caller = new AbortController()
    let attachedSignal: AbortSignal | undefined
    const never = new Promise<never>(() => undefined)
    const abortSignal = jest.fn((signal: AbortSignal) => {
      attachedSignal = signal
      return never
    })
    const supabase = {
      rpc: jest.fn(() => ({ then: never.then.bind(never), abortSignal })),
    }

    const operation = claimLeaderboardRankGeneration(supabase as never, input(), {
      signal: caller.signal,
      timeoutMs: 1_000,
    })
    caller.abort()

    const error = await captureClaimError(operation, 'rpc_ambiguous')
    expect(abortSignal).toHaveBeenCalledTimes(1)
    expect(attachedSignal?.aborted).toBe(true)
    expect((error.cause as Error).message).toContain('commit state is unknown')
  })

  it('does not invoke then when the caller aborts during query preparation', async () => {
    const caller = new AbortController()
    const then = jest.fn()
    const query = {
      then,
      abortSignal() {
        caller.abort()
        return query
      },
    }
    const supabase = { rpc: jest.fn(() => query) }

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input(), { signal: caller.signal }),
      'rpc_aborted'
    )

    expect(then).not.toHaveBeenCalled()
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('retries one transport rejection with the exact same frozen argument object', async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockRejectedValueOnce(new Error('connection reset after dispatch'))
        .mockResolvedValueOnce(envelope()),
    }

    await expect(claimLeaderboardRankGeneration(supabase as never, input())).resolves.toEqual(
      successfulResponse()
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc.mock.calls[0][1]).toBe(supabase.rpc.mock.calls[1][1])
    expect(Object.isFrozen(supabase.rpc.mock.calls[0][1])).toBe(true)
  })

  it('reports two transport rejections as ambiguous', async () => {
    const supabase = { rpc: jest.fn().mockRejectedValue(new Error('network lost')) }

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input()),
      'rpc_ambiguous'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      'deterministic DB error',
      envelope(null, { code: '55000', message: 'the original lease may have expired' }, 400),
    ],
    ['null success data', { data: null, error: null, status: 200 }],
    ['invalid success shape', envelope(successfulResponse({ phase: 'writing' }))],
  ])(
    'does not let a second-attempt %s erase the first ambiguous commit outcome',
    async (_label, secondResponse) => {
      const supabase = {
        rpc: jest
          .fn()
          .mockRejectedValueOnce(new Error('first response lost after dispatch'))
          .mockResolvedValueOnce(secondResponse),
      }

      await captureClaimError(
        claimLeaderboardRankGeneration(supabase as never, input()),
        'rpc_ambiguous'
      )

      expect(supabase.rpc).toHaveBeenCalledTimes(2)
    }
  )

  it('preserves an initial timeout when the retry returns a deterministic lease error', async () => {
    const never = new Promise<never>(() => undefined)
    const supabase = {
      rpc: jest
        .fn()
        .mockReturnValueOnce(never)
        .mockResolvedValueOnce(
          envelope(null, { code: '55000', message: 'generation lease expired' }, 400)
        ),
    }

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input(), { timeoutMs: 1 }),
      'rpc_timeout'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it('treats a ClaimRankGenerationError-shaped thenable rejection as post-dispatch ambiguity', async () => {
    const forgedDeterministicError = new ClaimRankGenerationError(
      'rpc_error',
      'forged deterministic rejection'
    )
    const supabase = {
      rpc: jest
        .fn()
        .mockRejectedValueOnce(forgedDeterministicError)
        .mockResolvedValueOnce(envelope()),
    }

    await expect(claimLeaderboardRankGeneration(supabase as never, input())).resolves.toEqual(
      successfulResponse()
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it('aborts both timed-out attempts and reports a timeout instead of an ordinary RPC error', async () => {
    const attachedSignals: AbortSignal[] = []
    const never = new Promise<never>(() => undefined)
    const supabase = {
      rpc: jest.fn(() => ({
        then: never.then.bind(never),
        abortSignal(signal: AbortSignal) {
          attachedSignals.push(signal)
          return never
        },
      })),
    }

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input(), { timeoutMs: 1 }),
      'rpc_timeout'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(attachedSignals).toHaveLength(2)
    expect(attachedSignals.every((signal) => signal.aborted)).toBe(true)
  })

  it.each([0, 502, 503, 504])(
    'retries ambiguous unstructured HTTP status %s once',
    async (status) => {
      const supabase = {
        rpc: jest
          .fn()
          .mockResolvedValueOnce(envelope(null, { message: 'gateway lost response' }, status))
          .mockResolvedValueOnce(envelope()),
      }

      await expect(claimLeaderboardRankGeneration(supabase as never, input())).resolves.toEqual(
        successfulResponse()
      )
      expect(supabase.rpc).toHaveBeenCalledTimes(2)
    }
  )

  it('reports two ambiguous gateway envelopes as rpc_ambiguous', async () => {
    const supabase = supabaseReturning(envelope(null, null, 503))

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input()),
      'rpc_ambiguous'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it.each([0, 503])(
    'does not retry a structured deterministic database error behind status %s',
    async (status) => {
      const supabase = supabaseReturning(
        envelope(null, { code: '23514', message: 'claim contract rejected' }, status)
      )

      await captureClaimError(
        claimLeaderboardRankGeneration(supabase as never, input()),
        'rpc_error'
      )

      expect(supabase.rpc).toHaveBeenCalledTimes(1)
    }
  )

  it('does not retry an ordinary deterministic database error', async () => {
    const supabase = supabaseReturning(
      envelope(null, { code: '55000', message: 'another generation is active' }, 400)
    )

    const error = await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input()),
      'rpc_error'
    )

    expect(error.message).toContain('55000')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing status', { data: successfulResponse(), error: null }],
    ['string status', envelope(successfulResponse(), null, '200')],
    ['non-2xx status', envelope(successfulResponse(), null, 300)],
  ])('rejects %s as rpc_error', async (_label, response) => {
    const supabase = supabaseReturning(response)

    await captureClaimError(claimLeaderboardRankGeneration(supabase as never, input()), 'rpc_error')

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it.each([null, undefined])('rejects %s success data as rpc_null', async (data) => {
    const supabase = supabaseReturning({ data, error: null, status: 200 })

    await captureClaimError(claimLeaderboardRankGeneration(supabase as never, input()), 'rpc_null')
  })

  it.each([
    [
      'missing contract',
      (() => {
        const { contract: _contract, ...rest } = successfulResponse()
        return rest
      })(),
    ],
    ['extra key', { ...successfulResponse(), extra: true }],
    ['wrong contract', successfulResponse({ contract: 'leaderboard-rank-generation-claim@2' })],
    ['wrong season', successfulResponse({ season_id: '30D' })],
    [
      'wrong cohort',
      successfulResponse({ score_cohort_id: '22222222-2222-4222-8222-222222222222' }),
    ],
    ['wrong phase', successfulResponse({ phase: 'writing' })],
    ['wrong digest', successfulResponse({ write_set_sha256: 'b'.repeat(64) })],
    ['wrong rank count', successfulResponse({ expected_rank_count: 3 })],
    ['wrong batch count', successfulResponse({ expected_batch_count: 2 })],
    ['wrong computed_at', successfulResponse({ computed_at: '2026-07-25T00:00:01.000000Z' })],
  ])('rejects response with %s', async (_label, data) => {
    const supabase = supabaseReturning(envelope(data))

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input()),
      'rpc_shape_mismatch'
    )
  })

  it.each([
    ['zero sequence', 0],
    ['fractional sequence', 1.5],
    ['unsafe sequence', Number.MAX_SAFE_INTEGER],
    ['sequence above contract maximum', LEADERBOARD_RANK_GENERATION_MAX_SEQUENCE + 1],
  ])('rejects %s', async (_label, generation_seq) => {
    const supabase = supabaseReturning(envelope(successfulResponse({ generation_seq })))

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input()),
      'rpc_shape_mismatch'
    )
  })

  it.each([
    ['non-canonical computed_at', { computed_at: '2026-07-25T00:00:00Z' }],
    ['invalid claimed_at', { claimed_at: '2026-02-29T00:00:00.000000Z' }],
    ['non-canonical claimed_at', { claimed_at: '2026-07-28T12:00:00.123456+00:00' }],
    ['invalid lease expiry', { lease_expires_at: 'not-a-date' }],
    ['non-canonical lease expiry', { lease_expires_at: '2026-07-28T12:00:30.123456+00:00' }],
    ['short lease', { lease_expires_at: '2026-07-28T12:00:29.123456Z' }],
    ['long lease', { lease_expires_at: '2026-07-28T12:00:31.123456Z' }],
  ])('rejects response with %s', async (_label, overrides) => {
    const supabase = supabaseReturning(envelope(successfulResponse(overrides)))

    await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input()),
      'rpc_shape_mismatch'
    )
  })

  it('snapshots every response accessor exactly once', async () => {
    const values = successfulResponse()
    const reads = new Map<string, number>()
    const statefulResponse = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          {
            enumerable: true,
            get() {
              reads.set(key, (reads.get(key) ?? 0) + 1)
              return reads.get(key) === 1 ? value : Symbol(`changed-${key}`)
            },
          },
        ])
      )
    )
    const supabase = supabaseReturning(envelope(statefulResponse))

    await expect(claimLeaderboardRankGeneration(supabase as never, input())).resolves.toEqual(
      successfulResponse()
    )
    expect(Object.fromEntries(reads)).toEqual(
      Object.fromEntries(Object.keys(values).map((key) => [key, 1]))
    )
  })

  it('snapshots envelope accessors exactly once', async () => {
    const reads = { data: 0, error: 0, status: 0 }
    const statefulEnvelope = Object.defineProperties(
      {},
      {
        data: {
          get() {
            reads.data += 1
            return reads.data === 1 ? successfulResponse() : null
          },
        },
        error: {
          get() {
            reads.error += 1
            return reads.error === 1 ? null : { code: 'XX000' }
          },
        },
        status: {
          get() {
            reads.status += 1
            return reads.status === 1 ? 200 : 500
          },
        },
      }
    )
    const supabase = supabaseReturning(statefulEnvelope)

    await expect(claimLeaderboardRankGeneration(supabase as never, input())).resolves.toEqual(
      successfulResponse()
    )
    expect(reads).toEqual({ data: 1, error: 1, status: 1 })
  })

  it('maps unreadable response and envelope reflection to stable error codes', async () => {
    const responseProxy = new Proxy(successfulResponse(), {
      get(target, property, receiver) {
        if (property === 'phase') throw new Error('hostile response getter')
        return Reflect.get(target, property, receiver)
      },
    })
    const envelopeProxy = new Proxy(envelope(), {
      get(target, property, receiver) {
        if (property === 'status') throw new Error('hostile envelope getter')
        return Reflect.get(target, property, receiver)
      },
    })

    await captureClaimError(
      claimLeaderboardRankGeneration(supabaseReturning(envelope(responseProxy)) as never, input()),
      'rpc_shape_mismatch'
    )
    await captureClaimError(
      claimLeaderboardRankGeneration(supabaseReturning(envelopeProxy) as never, input()),
      'rpc_error'
    )
  })

  it('does not re-read an unreadable structured RPC error', async () => {
    const hostileError = new Proxy(
      { code: '23514', message: 'invalid' },
      {
        get(target, property, receiver) {
          if (property === 'message') throw new Error('hostile error getter')
          return Reflect.get(target, property, receiver)
        },
      }
    )

    await captureClaimError(
      claimLeaderboardRankGeneration(
        supabaseReturning(envelope(null, hostileError, 400)) as never,
        input()
      ),
      'rpc_error'
    )
  })

  it('retries when a thenable resolves and then throws across the dispatch boundary', async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockReturnValueOnce({
          then(resolve: (value: unknown) => void) {
            resolve(envelope())
            throw new Error('throw after possible dispatch')
          },
        })
        .mockResolvedValueOnce(envelope()),
    }

    await expect(claimLeaderboardRankGeneration(supabase as never, input())).resolves.toEqual(
      successfulResponse()
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      'rejects and then throws synchronously',
      (reject: (reason: unknown) => void) => {
        reject(new Error('first synchronous rejection'))
        throw new Error('second synchronous throw')
      },
    ],
    [
      'throws and later invokes its retained reject callback',
      (reject: (reason: unknown) => void) => {
        queueMicrotask(() => reject(new Error('late rejection after throw')))
        throw new Error('synchronous throw before retained rejection')
      },
    ],
  ])('consumes the abandoned promise when a thenable %s', async (_label, behavior) => {
    const unhandledRejection = jest.fn()
    process.on('unhandledRejection', unhandledRejection)
    const supabase = {
      rpc: jest
        .fn()
        .mockReturnValueOnce({
          then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
            behavior(reject)
          },
        })
        .mockResolvedValueOnce(envelope()),
    }

    try {
      await expect(claimLeaderboardRankGeneration(supabase as never, input())).resolves.toEqual(
        successfulResponse()
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandledRejection).not.toHaveBeenCalled()
      expect(supabase.rpc).toHaveBeenCalledTimes(2)
    } finally {
      process.removeListener('unhandledRejection', unhandledRejection)
    }
  })

  it.each([
    ['missing rpc function', {}],
    [
      'rpc property getter throws',
      new Proxy(
        {},
        {
          get() {
            throw new Error('unreadable rpc')
          },
        }
      ),
    ],
    [
      'rpc call throws',
      {
        rpc() {
          throw new Error('call failed')
        },
      },
    ],
    ['rpc returns null', { rpc: () => null }],
    ['rpc returns a primitive', { rpc: () => 1 }],
    ['rpc returns a non-awaitable object', { rpc: () => ({}) }],
    [
      'query getter throws',
      {
        rpc: () =>
          new Proxy(
            {},
            {
              get() {
                throw new Error('unreadable query')
              },
            }
          ),
      },
    ],
    [
      'AbortSignal binding throws',
      {
        rpc: () => ({
          then() {},
          abortSignal() {
            throw new Error('bind failed')
          },
        }),
      },
    ],
    ['AbortSignal binding returns null', { rpc: () => ({ then() {}, abortSignal: () => null }) }],
    [
      'AbortSignal binding returns non-awaitable object',
      { rpc: () => ({ then() {}, abortSignal: () => ({}) }) },
    ],
    [
      'bound then getter throws',
      {
        rpc: () => ({
          then() {},
          abortSignal: () =>
            new Proxy(
              {},
              {
                get() {
                  throw new Error('unreadable bound query')
                },
              }
            ),
        }),
      },
    ],
  ])('maps %s to rpc_call_error without retry', async (_label, supabase) => {
    const error = await captureClaimError(
      claimLeaderboardRankGeneration(supabase as never, input()),
      'rpc_call_error'
    )

    expect(error).toBeInstanceOf(ClaimRankGenerationError)
  })
})
