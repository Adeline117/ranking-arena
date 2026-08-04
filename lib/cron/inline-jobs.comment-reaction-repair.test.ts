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

import { repairCommentReactionCountsInline } from './inline-jobs'

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

describe('repairCommentReactionCountsInline', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('awaits independent one-item RPC transactions before starting the next', async () => {
    let resolveFirst!: (value: ReturnType<typeof rpcResult>) => void
    const firstCall = new Promise<ReturnType<typeof rpcResult>>((resolve) => {
      resolveFirst = resolve
    })
    mockRpc.mockReturnValueOnce(firstCall).mockResolvedValueOnce(rpcResult(acknowledgement()))

    const pending = repairCommentReactionCountsInline()
    await Promise.resolve()

    expect(mockRpc).toHaveBeenCalledTimes(1)
    resolveFirst(
      rpcResult(
        acknowledgement({
          has_more: true,
          remaining_count: 1,
          oldest_enqueued_at: recentTimestamp(),
        })
      )
    )

    await expect(pending).resolves.toEqual(
      expect.objectContaining({
        name: 'repair-comment-reaction-counts',
        status: 'success',
        detail: expect.objectContaining({
          rpcCalls: 2,
          processedCount: 2,
          repairedCount: 2,
          stopReason: 'no-due-work',
        }),
      })
    )
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'repair_comment_reaction_counts_atomic', {
      p_limit: 1,
    })
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'repair_comment_reaction_counts_atomic', {
      p_limit: 1,
    })
  })

  it('rejects an acknowledgement with any extra key', async () => {
    mockRpc.mockResolvedValue(rpcResult({ ...acknowledgement(), extra: true }))

    await expect(repairCommentReactionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        error: 'repair_comment_reaction_counts_atomic returned an invalid acknowledgement',
      })
    )
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['selected_count exceeds p_limit', acknowledgement({ selected_count: 2 })],
    [
      'processed_count exceeds p_limit',
      acknowledgement({ selected_count: 2, processed_count: 2, repaired_count: 2 }),
    ],
    ['processed total mismatches repaired plus discarded', acknowledgement({ discarded_count: 1 })],
    ['selected total mismatches processed plus contended', acknowledgement({ selected_count: 0 })],
    ['an empty backlog reports has_more', acknowledgement({ has_more: true })],
    [
      'an empty backlog reports an oldest item',
      acknowledgement({ oldest_enqueued_at: recentTimestamp() }),
    ],
    [
      'a non-empty backlog omits its oldest item',
      acknowledgement({
        selected_count: 0,
        processed_count: 0,
        repaired_count: 0,
        remaining_count: 1,
      }),
    ],
  ])('fails closed when %s', async (_case, invalidAck) => {
    mockRpc.mockResolvedValue(rpcResult(invalidAck))

    await expect(repairCommentReactionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        error: 'repair_comment_reaction_counts_atomic returned an invalid acknowledgement',
      })
    )
  })

  it('passes the abort signal to Supabase and fails when aborted in flight', async () => {
    const controller = new AbortController()
    const abortSignal = jest.fn(async (signal: AbortSignal) => {
      controller.abort(new Error('comment batch stopped'))
      return rpcResult(acknowledgement())
    })
    mockRpc.mockReturnValue({ abortSignal })

    await expect(repairCommentReactionCountsInline(controller.signal)).resolves.toEqual(
      expect.objectContaining({ status: 'error', error: 'comment batch stopped' })
    )
    expect(abortSignal).toHaveBeenCalledWith(controller.signal)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('does not start a transaction when the batch signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('comment deadline reached'))

    await expect(repairCommentReactionCountsInline(controller.signal)).resolves.toEqual(
      expect.objectContaining({ status: 'error', error: 'comment deadline reached' })
    )
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails the job when remaining backlog exceeds 1000', async () => {
    mockRpc.mockResolvedValue(
      rpcResult(
        acknowledgement({
          selected_count: 0,
          processed_count: 0,
          repaired_count: 0,
          remaining_count: 1_001,
          oldest_enqueued_at: recentTimestamp(),
        })
      )
    )

    await expect(repairCommentReactionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        detail: expect.objectContaining({ backlogExceeded: true, remainingCount: 1_001 }),
        error: expect.stringContaining('remaining_count 1001 exceeds 1000'),
      })
    )
  })

  it('fails the job when the oldest obligation is older than 15 minutes', async () => {
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

    await expect(repairCommentReactionCountsInline()).resolves.toEqual(
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

    await expect(repairCommentReactionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'success',
        detail: expect.objectContaining({ rpcCalls: 100, stopReason: 'call-limit' }),
      })
    )
    expect(mockRpc).toHaveBeenCalledTimes(100)
    expect(mockRpc.mock.calls.every(([, args]) => args.p_limit === 1)).toBe(true)
  })

  it('stops after the 75-second inline budget with final telemetry intact', async () => {
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

    await expect(repairCommentReactionCountsInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'success',
        durationMs: 75_000,
        detail: expect.objectContaining({ rpcCalls: 1, stopReason: 'time-budget' }),
      })
    )
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })
})
