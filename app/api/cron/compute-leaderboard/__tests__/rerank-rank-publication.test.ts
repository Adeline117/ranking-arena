/**
 * @jest-environment node
 */

import {
  LEADERBOARD_PUBLIC_RERANK_CONTRACT,
  LEADERBOARD_PUBLIC_RERANK_MAX_ROWS,
  LEADERBOARD_PUBLIC_RERANK_MAX_TIMEOUT_MS,
  LEADERBOARD_PUBLIC_RERANK_MAX_UPDATED_ROWS,
  RerankRankPublicationError,
  rerankLeaderboardPublication,
  type RerankRankPublicationErrorCode,
} from '../rerank-rank-publication'

const COHORT_ID = '123e4567-e89b-12d3-a456-426614174000'

function input(overrides: Record<string, unknown> = {}) {
  return {
    season: '30D' as const,
    scoreCohortId: COHORT_ID,
    ...overrides,
  }
}

function successfulResponse(overrides: Record<string, unknown> = {}) {
  return {
    contract: LEADERBOARD_PUBLIC_RERANK_CONTRACT,
    season_id: '30D',
    score_cohort_id: COHORT_ID,
    eligible_rank_count: 2,
    // This is deliberately greater than eligible_rank_count: rerank also
    // clears ranks on ineligible/non-authority rows in the season universe.
    updated_rank_count: 7,
    ...overrides,
  }
}

function supabaseReturning(data: unknown, error: unknown = null) {
  return {
    rpc: jest.fn().mockResolvedValue({ data, error }),
  }
}

async function captureRerankError(
  operation: Promise<unknown>,
  expectedCode: RerankRankPublicationErrorCode
): Promise<RerankRankPublicationError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(RerankRankPublicationError)
    expect((error as RerankRankPublicationError).code).toBe(expectedCode)
    return error as RerankRankPublicationError
  }
  throw new Error(`expected RerankRankPublicationError(${expectedCode})`)
}

describe('rerankLeaderboardPublication', () => {
  it('calls the dormant RPC through its exact two-argument contract', async () => {
    const response = successfulResponse()
    const supabase = supabaseReturning(response)

    const result = await rerankLeaderboardPublication(supabase as never, input())

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('rerank_leaderboard_publication', {
      p_season_id: '30D',
      p_score_cohort_id: COHORT_ID,
    })
    expect(result).toEqual(response)
  })

  it.each([
    ['lowercase season', { season: '30d' }],
    ['whitespace season', { season: ' 30D' }],
    ['uppercase cohort', { scoreCohortId: COHORT_ID.toUpperCase() }],
    ['compact cohort', { scoreCohortId: COHORT_ID.replaceAll('-', '') }],
    ['whitespace cohort', { scoreCohortId: `${COHORT_ID} ` }],
  ])('rejects non-canonical input before dispatch: %s', async (_label, overrides) => {
    const supabase = supabaseReturning(successfulResponse())

    await captureRerankError(
      rerankLeaderboardPublication(supabase as never, input(overrides)),
      'invalid_input'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, LEADERBOARD_PUBLIC_RERANK_MAX_TIMEOUT_MS + 1])(
    'rejects an unbounded/invalid timeout before dispatch: %s',
    async (timeoutMs) => {
      const supabase = supabaseReturning(successfulResponse())

      await captureRerankError(
        rerankLeaderboardPublication(supabase as never, input(), { timeoutMs }),
        'invalid_input'
      )

      expect(supabase.rpc).not.toHaveBeenCalled()
    }
  )

  it('accepts updated_rank_count greater than eligible_rank_count within the protocol bound', async () => {
    const response = successfulResponse({
      eligible_rank_count: 0,
      updated_rank_count: LEADERBOARD_PUBLIC_RERANK_MAX_ROWS + 1,
    })
    const supabase = supabaseReturning(response)

    await expect(rerankLeaderboardPublication(supabase as never, input())).resolves.toEqual(
      response
    )
  })

  it.each([
    ['wrong contract', { contract: 'leaderboard-public-rerank@0' }],
    ['wrong season', { season_id: '7D' }],
    ['wrong cohort', { score_cohort_id: '223e4567-e89b-12d3-a456-426614174000' }],
    ['extra key', { extra: true }],
    ['negative eligible count', { eligible_rank_count: -1 }],
    ['fractional updated count', { updated_rank_count: 1.5 }],
    ['unsafe eligible count', { eligible_rank_count: Number.MAX_SAFE_INTEGER + 1 }],
    [
      'eligible count above protocol bound',
      { eligible_rank_count: LEADERBOARD_PUBLIC_RERANK_MAX_ROWS + 1 },
    ],
    [
      'updated count above protocol bound',
      { updated_rank_count: LEADERBOARD_PUBLIC_RERANK_MAX_UPDATED_ROWS + 1 },
    ],
  ])('fails closed without retrying a response mismatch: %s', async (_label, overrides) => {
    const supabase = supabaseReturning(successfulResponse(overrides))

    await captureRerankError(
      rerankLeaderboardPublication(supabase as never, input()),
      'rpc_shape_mismatch'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('does not retry a deterministic RPC error', async () => {
    const supabase = supabaseReturning(null, {
      code: '23514',
      message: 'eligible leaderboard rows were not fully written by the score cohort',
    })

    const error = await captureRerankError(
      rerankLeaderboardPublication(supabase as never, input()),
      'rpc_error'
    )

    expect(error.message).toContain('23514')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('does not retry null data', async () => {
    const supabase = supabaseReturning(null)

    await captureRerankError(rerankLeaderboardPublication(supabase as never, input()), 'rpc_null')

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('does not retry a non-envelope response', async () => {
    const supabase = { rpc: jest.fn().mockResolvedValue(undefined) }

    await captureRerankError(rerankLeaderboardPublication(supabase as never, input()), 'rpc_error')

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('retries one lost response with the exact same season/cohort argument object', async () => {
    // A completed first call may have updated rows before its response was
    // lost; the idempotent replay can therefore legitimately report zero.
    const replayResponse = successfulResponse({ updated_rank_count: 0 })
    const supabase = {
      rpc: jest
        .fn()
        .mockRejectedValueOnce(new TypeError('connection reset after request write'))
        .mockResolvedValueOnce({ data: replayResponse, error: null }),
    }

    await expect(rerankLeaderboardPublication(supabase as never, input())).resolves.toEqual(
      replayResponse
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc.mock.calls[1][1]).toBe(supabase.rpc.mock.calls[0][1])
    expect(supabase.rpc.mock.calls[1][1]).toEqual({
      p_season_id: '30D',
      p_score_cohort_id: COHORT_ID,
    })
  })

  it('stops after the sole retry when both responses are lost', async () => {
    const supabase = {
      rpc: jest.fn().mockRejectedValue(new TypeError('connection reset')),
    }

    await captureRerankError(
      rerankLeaderboardPublication(supabase as never, input()),
      'rpc_ambiguous'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it('retries one deadline expiry and binds a fresh AbortSignal to each attempt', async () => {
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
          return Promise.resolve({ data: successfulResponse(), error: null })
        }),
      }
      const supabase = {
        rpc: jest.fn().mockReturnValueOnce(firstQuery).mockReturnValueOnce(secondQuery),
      }

      const operation = rerankLeaderboardPublication(supabase as never, input(), {
        timeoutMs: 25,
      })
      await jest.advanceTimersByTimeAsync(25)
      await expect(operation).resolves.toEqual(successfulResponse())

      expect(supabase.rpc).toHaveBeenCalledTimes(2)
      expect(capturedSignals).toHaveLength(2)
      expect(capturedSignals[0].aborted).toBe(true)
      expect(capturedSignals[1].aborted).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('honors a caller AbortSignal without retrying', async () => {
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    const query = {
      abortSignal: jest.fn((signal: AbortSignal) => {
        capturedSignal = signal
        return new Promise<never>(() => undefined)
      }),
    }
    const supabase = { rpc: jest.fn().mockReturnValue(query) }

    const operation = rerankLeaderboardPublication(supabase as never, input(), {
      signal: controller.signal,
    })
    controller.abort(new Error('cron budget exhausted'))
    await captureRerankError(operation, 'rpc_aborted')

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('does not dispatch when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const supabase = supabaseReturning(successfulResponse())

    await captureRerankError(
      rerankLeaderboardPublication(supabase as never, input(), { signal: controller.signal }),
      'rpc_aborted'
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('does not retry a synchronous pre-dispatch client failure', async () => {
    const supabase = {
      rpc: jest.fn(() => {
        throw new Error('client construction failed')
      }),
    }

    await captureRerankError(
      rerankLeaderboardPublication(supabase as never, input()),
      'rpc_call_error'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('does not retry an AbortSignal binding failure', async () => {
    const query = {
      abortSignal: jest.fn(() => {
        throw new Error('builder rejected AbortSignal')
      }),
    }
    const supabase = { rpc: jest.fn().mockReturnValue(query) }

    await captureRerankError(
      rerankLeaderboardPublication(supabase as never, input()),
      'rpc_call_error'
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })
})
