const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockCacheDelete = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}))

jest.mock('@/lib/cache', () => ({
  del: (...args: unknown[]) => mockCacheDelete(...args),
}))

jest.mock('@/connectors', () => ({ getConnector: jest.fn() }))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { refreshHotScoresInline } from './inline-jobs'

function rpcResult(data: unknown, error: { message: string } | null = null) {
  return { data, error }
}

describe('refreshHotScoresInline mutation authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCacheDelete.mockResolvedValue(true)
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'update_post_velocity') return rpcResult(4)
      if (name === 'update_post_report_counts') return rpcResult(3)
      if (name === 'refresh_hot_scores_incremental') return rpcResult(2)
      throw new Error(`unexpected RPC ${name}`)
    })
  })

  it('acknowledges only an exact incremental mutation count', async () => {
    await expect(refreshHotScoresInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'success',
        detail: { method: 'incremental', count: 2, velocityCount: 4, reportCount: 3 },
      })
    )
    expect(mockCacheDelete).toHaveBeenCalledWith('hot_posts:top50')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('uses the canonical full RPC when incremental refresh fails', async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'update_post_velocity' || name === 'update_post_report_counts') {
        return rpcResult(0)
      }
      if (name === 'refresh_hot_scores_incremental') {
        return rpcResult(null, { message: 'incremental unavailable' })
      }
      if (name === 'refresh_hot_scores') return rpcResult(7)
      throw new Error(`unexpected RPC ${name}`)
    })

    await expect(refreshHotScoresInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'success',
        detail: { method: 'full', count: 7, velocityCount: 0, reportCount: 0 },
      })
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([null, '3', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'fails before scoring when a prerequisite returns invalid count %p',
    async (invalidCount) => {
      mockRpc.mockResolvedValueOnce(rpcResult(invalidCount))

      await expect(refreshHotScoresInline()).resolves.toEqual(
        expect.objectContaining({
          status: 'error',
          error: 'update_post_velocity returned an invalid mutation count',
        })
      )
      expect(mockRpc).toHaveBeenCalledTimes(1)
      expect(mockCacheDelete).not.toHaveBeenCalled()
    }
  )

  it('fails when a prerequisite write reports a database error', async () => {
    mockRpc.mockResolvedValueOnce(rpcResult(null, { message: 'velocity write failed' }))

    await expect(refreshHotScoresInline()).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        error: 'update_post_velocity failed: velocity write failed',
      })
    )
    expect(mockCacheDelete).not.toHaveBeenCalled()
  })

  it('does not publish an obsolete direct-formula fallback when both score RPCs fail', async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'update_post_velocity' || name === 'update_post_report_counts') {
        return rpcResult(0)
      }
      if (name === 'refresh_hot_scores_incremental') return rpcResult('2')
      if (name === 'refresh_hot_scores') return rpcResult(null, { message: 'full unavailable' })
      throw new Error(`unexpected RPC ${name}`)
    })

    const result = await refreshHotScoresInline()

    expect(result.status).toBe('error')
    expect(result.error).toContain('incremental: invalid mutation count')
    expect(result.error).toContain('full: full unavailable')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockCacheDelete).not.toHaveBeenCalled()
  })

  it('reports cache invalidation failure after a successful database mutation', async () => {
    mockCacheDelete.mockRejectedValue(new Error('cache unavailable'))

    await expect(refreshHotScoresInline()).resolves.toEqual(
      expect.objectContaining({ status: 'error', error: 'cache unavailable' })
    )
  })
})
