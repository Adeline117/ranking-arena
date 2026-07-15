jest.mock('next/server', () => ({
  NextResponse: class MockNextResponse {
    status: number
    private body: unknown

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }

    async json() {
      return this.body
    }
  },
}))

const mockGetAuthUser = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}))

import { POST } from '../route'

describe('POST /api/presence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: 'user-123' })
    mockRpc.mockResolvedValue({ error: null })
  })

  it('records presence and the activity-day fact through one atomic RPC', async () => {
    const response = await POST({} as never)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('record_user_activity', {
      p_user_id: 'user-123',
      p_seen_at: expect.any(String),
    })
    expect(await response.json()).toEqual({ ok: true })
  })

  it('does not report success when the atomic write fails', async () => {
    mockRpc.mockResolvedValue({ error: { message: 'write failed', code: 'XX000' } })

    const response = await POST({} as never)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Update failed' })
  })

  it('rejects anonymous heartbeats before writing', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST({} as never)

    expect(response.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
