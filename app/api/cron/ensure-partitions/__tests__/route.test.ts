/** @jest-environment node */

const mockRpc = jest.fn()

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) =>
    handler(request, { supabase: { rpc: mockRpc } }),
}))

import { GET } from '../route'

describe('GET /api/cron/ensure-partitions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses the generated RPC argument name', async () => {
    mockRpc.mockResolvedValue({ data: ['2026-08'], error: null })

    await expect(GET({} as never)).resolves.toEqual({
      count: 1,
      partitions_created: ['2026-08'],
    })
    expect(mockRpc).toHaveBeenCalledWith('ensure_future_partitions', { p_months_ahead: 4 })
  })

  it('fails closed when partition creation fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } })

    await expect(GET({} as never)).rejects.toThrow(
      'ensure_future_partitions failed: permission denied'
    )
  })
})
