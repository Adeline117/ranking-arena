const mockRpc = jest.fn()
const mockCacheDelete = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}))

jest.mock('@/lib/cache', () => ({
  del: (...args: unknown[]) => mockCacheDelete(...args),
}))

jest.mock('@/connectors', () => ({ getConnector: jest.fn() }))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { repairPostInteractionCountsInline } from './inline-jobs'

function rpcResult(data: unknown, error: { message: string } | null = null) {
  return { data, error }
}

function recentTimestamp(ageMs = 0) {
  return new Date(Date.now() - ageMs).toISOString()
}

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    status: 'processed',
    selected_count: 1,
    processed_count: 1,
    repaired_count: 1,
    discarded_count: 0,
    contended_count: 0,
    has_more: false,
    remaining_count: 0,
    oldest_enqueued_at: null,
    ...overrides,
  }
}

describe('repairPostInteractionCountsInline', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('drains due work through independent one-item RPC transactions', async () => {
    mockRpc
      .mockResolvedValueOnce(
        rpcResult(
          acknowledgement({
            has_more: true,
            remaining_count: 1,
            oldest_enqueued_at: recentTimestamp(),
          })
        )
      )
      .mockResolvedValueOnce(rpcResult(acknowledgement()))

    await expect(repairPostInteractionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        name: 'repair-post-interaction-counts',
        status: 'success',
        detail: expect.objectContaining({
          rpcCalls: 2,
          processedCount: 2,
          repairedCount: 2,
          hasMore: false,
          remainingCount: 0,
          stopReason: 'no-due-work',
        }),
      })
    )
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'repair_post_interaction_counts_atomic', {
      p_limit: 1,
    })
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'repair_post_interaction_counts_atomic', {
      p_limit: 1,
    })
  })

  it.each([
    ['an extra key', { ...acknowledgement(), extra: true }],
    ['an invalid status', acknowledgement({ status: 'invalid' })],
    ['inconsistent processed totals', acknowledgement({ repaired_count: 1, discarded_count: 1 })],
    [
      'a non-ISO oldest timestamp',
      acknowledgement({
        selected_count: 0,
        processed_count: 0,
        repaired_count: 0,
        remaining_count: 1,
        oldest_enqueued_at: 'yesterday',
      }),
    ],
  ])('fails closed when the acknowledgement contains %s', async (_case, invalidAck) => {
    mockRpc.mockResolvedValue(rpcResult(invalidAck))

    await expect(repairPostInteractionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        error: 'repair_post_interaction_counts_atomic returned an invalid acknowledgement',
      })
    )
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('passes the abort signal to Supabase and fails if it is aborted in flight', async () => {
    const controller = new AbortController()
    const abortSignal = jest.fn(async (signal: AbortSignal) => {
      controller.abort(new Error('batch stopped'))
      return rpcResult(acknowledgement())
    })
    mockRpc.mockReturnValue({ abortSignal })

    await expect(repairPostInteractionCountsInline(controller.signal)).resolves.toEqual(
      expect.objectContaining({ status: 'error', error: 'batch stopped' })
    )
    expect(abortSignal).toHaveBeenCalledWith(controller.signal)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('does not start a transaction when the batch signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('deadline reached'))

    await expect(repairPostInteractionCountsInline(controller.signal)).resolves.toEqual(
      expect.objectContaining({ status: 'error', error: 'deadline reached' })
    )
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('stops after a wholly contended acknowledgement instead of hot-looping', async () => {
    mockRpc.mockResolvedValue(
      rpcResult(
        acknowledgement({
          processed_count: 0,
          repaired_count: 0,
          contended_count: 1,
          has_more: true,
          remaining_count: 1,
          oldest_enqueued_at: recentTimestamp(),
        })
      )
    )

    await expect(repairPostInteractionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'success',
        detail: expect.objectContaining({
          rpcCalls: 1,
          contendedCount: 1,
          hasMore: true,
          stopReason: 'contention',
        }),
      })
    )
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('accepts concurrent telemetry that discovers due work after selecting no candidate', async () => {
    mockRpc.mockResolvedValue(
      rpcResult(
        acknowledgement({
          selected_count: 0,
          processed_count: 0,
          repaired_count: 0,
          has_more: true,
          remaining_count: 1,
          oldest_enqueued_at: recentTimestamp(),
        })
      )
    )

    await expect(repairPostInteractionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'success',
        detail: expect.objectContaining({
          rpcCalls: 1,
          selectedCount: 0,
          processedCount: 0,
          hasMore: true,
          remainingCount: 1,
          stopReason: 'no-due-work',
        }),
      })
    )
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('allows deferred work but fails the job when remaining backlog exceeds 1000', async () => {
    mockRpc.mockResolvedValue(
      rpcResult(
        acknowledgement({
          selected_count: 0,
          processed_count: 0,
          repaired_count: 0,
          has_more: false,
          remaining_count: 1_001,
          oldest_enqueued_at: recentTimestamp(),
        })
      )
    )

    await expect(repairPostInteractionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        detail: expect.objectContaining({
          backlogExceeded: true,
          hasMore: false,
          remainingCount: 1_001,
        }),
        error: expect.stringContaining('remaining_count 1001 exceeds 1000'),
      })
    )
  })

  it('fails the job when the oldest queued obligation is older than 15 minutes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-04T12:00:00.000Z'))
    mockRpc.mockResolvedValue(
      rpcResult(
        acknowledgement({
          selected_count: 0,
          processed_count: 0,
          repaired_count: 0,
          remaining_count: 1,
          oldest_enqueued_at: '2026-08-04T11:44:59.999Z',
        })
      )
    )

    await expect(repairPostInteractionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        detail: expect.objectContaining({ backlogExceeded: true, oldestAgeMs: 900_001 }),
        error: expect.stringContaining('oldest item age 900001ms exceeds 900000ms'),
      })
    )
  })

  it('caps a continuously due queue at 100 one-item transactions', async () => {
    mockRpc.mockImplementation(async () =>
      rpcResult(
        acknowledgement({
          has_more: true,
          remaining_count: 1,
          oldest_enqueued_at: recentTimestamp(),
        })
      )
    )

    await expect(repairPostInteractionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'success',
        detail: expect.objectContaining({ rpcCalls: 100, stopReason: 'call-limit' }),
      })
    )
    expect(mockRpc).toHaveBeenCalledTimes(100)
    expect(mockRpc.mock.calls.every(([, args]) => args.p_limit === 1)).toBe(true)
  })

  it('stops after the inline time budget while preserving the final telemetry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-04T12:00:00.000Z'))
    mockRpc.mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-08-04T12:01:15.000Z'))
      return rpcResult(
        acknowledgement({
          has_more: true,
          remaining_count: 1,
          oldest_enqueued_at: '2026-08-04T12:00:00.000Z',
        })
      )
    })

    await expect(repairPostInteractionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'success',
        durationMs: 75_000,
        detail: expect.objectContaining({ rpcCalls: 1, stopReason: 'time-budget' }),
      })
    )
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })
})
