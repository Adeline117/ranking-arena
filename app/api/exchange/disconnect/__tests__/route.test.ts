jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private readonly body: unknown

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockUserId = '11111111-1111-4111-8111-111111111111'
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222'
const mockMaybeSingle = jest.fn()
const mockSelect = jest.fn(() => ({ maybeSingle: mockMaybeSingle }))
const mockEqExchange = jest.fn(() => ({ select: mockSelect }))
const mockEqUser = jest.fn(() => ({ eq: mockEqExchange }))
const mockUpdate = jest.fn(() => ({ eq: mockEqUser }))
const mockFrom = jest.fn(() => ({ update: mockUpdate }))

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: { user: { id: string }; request: { json(): Promise<unknown> } }) => unknown
    ) =>
    async (request: { json(): Promise<unknown> }) =>
      handler({ user: { id: mockUserId }, request }),
}))
jest.mock('@/lib/exchange/read-only-platforms', () => ({
  API_KEY_CONNECTION_PLATFORMS: ['binance', 'bybit', 'bitget'] as const,
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn() }),
}))

import { DELETE } from '../route'

function request(body: unknown, rejects = false) {
  return {
    json: rejects
      ? jest.fn().mockRejectedValue(new Error('invalid'))
      : jest.fn().mockResolvedValue(body),
  }
}

function disconnectedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    user_id: mockUserId,
    exchange: 'binance',
    is_active: false,
    ...overrides,
  }
}

describe('DELETE /api/exchange/disconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMaybeSingle.mockResolvedValue({ data: disconnectedRow(), error: null })
  })

  it('returns an exact receipt only after the owner-bound row is inactive', async () => {
    const response = await DELETE(request({ exchange: 'binance' }) as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, exchange: 'binance' })
    expect(mockFrom).toHaveBeenCalledWith('user_exchange_connections')
    expect(mockUpdate).toHaveBeenCalledWith({
      is_active: false,
      updated_at: expect.any(String),
    })
    expect(mockEqUser).toHaveBeenCalledWith('user_id', mockUserId)
    expect(mockEqExchange).toHaveBeenCalledWith('exchange', 'binance')
    expect(mockSelect).toHaveBeenCalledWith('id, user_id, exchange, is_active')
  })

  it.each([
    [{}, false],
    [{ exchange: 'gmx' }, false],
    [{ exchange: 'binance', extra: true }, false],
    [null, true],
  ])('rejects an invalid request before writing: %p', async (body, rejects) => {
    const response = await DELETE(request(body, rejects) as never)

    expect(response.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('fails closed on zero rows, a mismatched row, or a database error', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: disconnectedRow({ exchange: 'bybit' }), error: null })
      .mockResolvedValueOnce({ data: null, error: { code: 'XX001' } })

    const missing = await DELETE(request({ exchange: 'binance' }) as never)
    const mismatched = await DELETE(request({ exchange: 'binance' }) as never)
    const failed = await DELETE(request({ exchange: 'binance' }) as never)

    expect(missing.status).toBe(404)
    expect(mismatched.status).toBe(500)
    expect(failed.status).toBe(500)
  })
})
