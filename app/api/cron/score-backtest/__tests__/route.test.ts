/**
 * @jest-environment node
 */

const mockRpc = jest.fn()
const mockSupabase = { rpc: mockRpc }

jest.mock('@/lib/api/with-cron', () => ({
  withCron:
    (_jobName: string, handler: (request: unknown, context: unknown) => Promise<unknown>) =>
    async (request: unknown) => {
      try {
        const result = await handler(request, { supabase: mockSupabase })
        return Response.json({ ok: true, ...result })
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        )
      }
    },
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import { GET } from '../route'

function rpcResult(data: unknown, error: unknown = null) {
  return {
    abortSignal: jest.fn().mockResolvedValue({ data, error }),
  }
}

describe('GET /api/cron/score-backtest', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc
      .mockReturnValueOnce(rpcResult(42))
      .mockReturnValueOnce(rpcResult({ status: 'no_pending_snapshot' }))
  })

  it('acknowledges valid snapshot and evaluation RPC results', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      count: 42,
      snapshotted: 42,
      evaluation: { status: 'no_pending_snapshot' },
    })
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'snapshot_score_backtest')
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'evaluate_score_backtest', {
      p_horizon_days: 30,
    })
    expect(timeoutSpy).toHaveBeenCalledWith(45_000)
    timeoutSpy.mockRestore()
  })

  it('fails the run when snapshot persistence returns a database error', async () => {
    mockRpc
      .mockReset()
      .mockReturnValueOnce(rpcResult(null, { message: 'snapshot DB unavailable' }))
      .mockReturnValueOnce(rpcResult({ status: 'no_pending_snapshot' }))

    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('snapshot_score_backtest: snapshot DB unavailable')
  })

  it('fails the run when evaluation returns a database error', async () => {
    mockRpc
      .mockReset()
      .mockReturnValueOnce(rpcResult(10))
      .mockReturnValueOnce(rpcResult(null, { message: 'evaluation DB unavailable' }))

    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('evaluate_score_backtest: evaluation DB unavailable')
  })

  it.each([null, '12', -1, 1.5, Number.NaN])(
    'rejects invalid snapshot acknowledgement %p',
    async (snapshotted) => {
      mockRpc
        .mockReset()
        .mockReturnValueOnce(rpcResult(snapshotted))
        .mockReturnValueOnce(rpcResult({ status: 'no_pending_snapshot' }))

      const response = await GET({} as never)

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toMatchObject({
        error: 'snapshot_score_backtest returned an invalid acknowledgement',
      })
    }
  )

  it.each([null, [], {}, { status: 'mystery' }])(
    'rejects invalid evaluation acknowledgement %p',
    async (evaluation) => {
      mockRpc
        .mockReset()
        .mockReturnValueOnce(rpcResult(10))
        .mockReturnValueOnce(rpcResult(evaluation))

      const response = await GET({} as never)

      expect(response.status).toBe(500)
      expect((await response.json()).error).toContain('evaluate_score_backtest returned')
    }
  )
})
