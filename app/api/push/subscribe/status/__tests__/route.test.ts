jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Headers
    private body: unknown

    constructor(body: unknown, init: ResponseInit = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockHasActiveSubscription = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: unknown) =>
    handler({ user: { id: 'user-a' }, request }),
}))
jest.mock('@/lib/services/push-notification', () => ({
  getPushNotificationService: () => ({ hasActiveSubscription: mockHasActiveSubscription }),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}))

import { POST } from '../route'

function requestWith(body: unknown) {
  return { json: jest.fn().mockResolvedValue(body) } as never
}

describe('POST /api/push/subscribe/status', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns only the current viewer ownership boolean without caching it', async () => {
    mockHasActiveSubscription.mockResolvedValue(true)

    const response = await POST(requestWith({ token: 'https://push.test/one' }))

    expect(mockHasActiveSubscription).toHaveBeenCalledWith('user-a', 'https://push.test/one')
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { subscribed: true },
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('rejects malformed status input before touching the service', async () => {
    const response = await POST(requestWith({ token: '', extra: true }))

    expect(response.status).toBe(400)
    expect(mockHasActiveSubscription).not.toHaveBeenCalled()
  })
})
