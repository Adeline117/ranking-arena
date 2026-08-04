const USER_ID = '11111111-1111-4111-8111-111111111111'
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222'
const RESPONSE_TIME = '2026-01-01T00:00:00.000Z'

class MockResponse {
  constructor(
    private readonly body: unknown,
    readonly status = 200
  ) {}

  async json() {
    return this.body
  }
}

const mockOrder = jest.fn()
const mockIn = jest.fn(() => ({ order: mockOrder }))
const mockEq = jest.fn(() => ({ in: mockIn }))
const mockSelect = jest.fn(() => ({ eq: mockEq }))
const mockFrom = jest.fn(() => ({ select: mockSelect }))

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: (context: { user: { id: string } }) => unknown) => async () =>
    handler({ user: { id: USER_ID } }),
}))
jest.mock('@/lib/api/response', () => ({
  success: (data: unknown) =>
    new MockResponse({ success: true, data, meta: { timestamp: RESPONSE_TIME } }),
  error: (message: string, status: number) =>
    new MockResponse({ success: false, error: message }, status),
}))
jest.mock('@/lib/exchange/read-only-platforms', () => ({
  API_KEY_CONNECTION_PLATFORMS: ['binance', 'bybit', 'bitget'] as const,
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}))

import { GET } from '../route'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    user_id: USER_ID,
    exchange: 'binance',
    is_active: true,
    last_sync_at: null,
    last_sync_status: 'success',
    last_sync_error: null,
    created_at: RESPONSE_TIME,
    updated_at: RESPONSE_TIME,
    ...overrides,
  }
}

describe('GET /api/exchange/connections runtime contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockOrder.mockResolvedValue({ data: [row()], error: null })
  })

  it('returns only a validated owner-bound current-platform projection', async () => {
    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { connections: [row()] },
      meta: { timestamp: RESPONSE_TIME },
    })
    expect(mockFrom).toHaveBeenCalledWith('user_exchange_connections')
    expect(mockEq).toHaveBeenCalledWith('user_id', USER_ID)
    expect(mockIn).toHaveBeenCalledWith('exchange', ['binance', 'bybit', 'bitget'])
    expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false })

    const projection = String(mockSelect.mock.calls[0]?.[0])
    expect(projection).toContain('last_sync_status')
    expect(projection).not.toContain('api_key_encrypted')
  })

  it.each([
    [row({ user_id: '33333333-3333-4333-8333-333333333333' })],
    [row({ api_key_encrypted: 'must-not-cross-boundary' })],
    [row({ exchange: 'mexc' })],
    [row(), row({ id: '33333333-3333-4333-8333-333333333333' })],
  ])('fails closed on an invalid result set: %p', async (...rows) => {
    mockOrder.mockResolvedValue({ data: rows, error: null })

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    expect((await response.json()) as unknown).not.toEqual(
      expect.objectContaining({ success: true })
    )
  })

  it('returns an error when the owner-scoped query fails', async () => {
    mockOrder.mockResolvedValue({ data: null, error: { code: 'XX001' } })

    const response = await GET({} as never)

    expect(response.status).toBe(500)
  })
})
