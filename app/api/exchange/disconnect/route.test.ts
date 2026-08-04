const mockDisconnectApiKey = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
let mockUser: { id: string } | null = { id: '11111111-1111-4111-8111-111111111111' }

function response(body: unknown, status = 200) {
  return { status, json: async () => body }
}

jest.mock('@/lib/api/middleware', () => ({
  withApiMiddleware:
    (handler: (context: { user: typeof mockUser; request: unknown }) => Promise<unknown>) =>
    async (request: unknown) => {
      const result = await handler({ user: mockUser, request })
      return result && typeof (result as { json?: unknown }).json === 'function'
        ? result
        : response(result)
    },
  createErrorResponse: (error: string, status: number) => response({ error }, status),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/services/api-key-binder', () => {
  const actual = jest.requireActual('@/lib/services/api-key-binder')
  return {
    ...actual,
    disconnectApiKey: (...args: unknown[]) => mockDisconnectApiKey(...args),
  }
})

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn() }),
}))

import { DELETE } from './route'

function request(exchange: unknown) {
  return { json: async () => ({ exchange }) } as never
}

function malformedRequest() {
  return { json: async () => Promise.reject(new SyntaxError('invalid JSON')) } as never
}

describe('DELETE /api/exchange/disconnect lifecycle boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUser = { id: '11111111-1111-4111-8111-111111111111' }
    mockGetSupabaseAdmin.mockReturnValue({ rpc: jest.fn() })
    mockDisconnectApiKey.mockResolvedValue({ success: true })
  })

  it('normalizes a proven historical CEX key and calls the atomic service', async () => {
    const response = await DELETE(request(' BYBIT_SPOT '))

    expect(response.status).toBe(200)
    expect(mockDisconnectApiKey).toHaveBeenCalledWith(
      { rpc: expect.any(Function) },
      '11111111-1111-4111-8111-111111111111',
      'bybit_spot'
    )
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Disconnected successfully',
    })
  })

  it.each(['gmx', 'gate', 'gateio', 'kucoin', 'mexc_spot', 'bybit_futures'])(
    'rejects non-account or guessed historical key %s before service access',
    async (exchange) => {
      const response = await DELETE(request(exchange))

      expect(response.status).toBe(400)
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
      expect(mockDisconnectApiKey).not.toHaveBeenCalled()
    }
  )

  it('rejects a non-string exchange before service access', async () => {
    const response = await DELETE(request(42))

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockDisconnectApiKey).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed JSON instead of surfacing a middleware 500', async () => {
    const response = await DELETE(malformedRequest())

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockDisconnectApiKey).not.toHaveBeenCalled()
  })

  it('returns the same 404 for a missing or non-owned connection', async () => {
    mockDisconnectApiKey.mockResolvedValue({
      success: false,
      error: 'Account connection not found',
      errorCode: 'not_found',
    })

    const response = await DELETE(request('binance'))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Exchange connection not found' })
  })
})
