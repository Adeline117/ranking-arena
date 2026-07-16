jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private body: unknown

    constructor(body: unknown, init: ResponseInit = {}) {
      this.body = body
      this.status = init.status ?? 200
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

const mockRegisterSubscription = jest.fn()
const mockUnregisterSubscription = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: unknown) =>
    handler({ user: { id: 'user-a' }, request }),
}))
jest.mock('@/lib/services/push-notification', () => ({
  getPushNotificationService: () => ({
    registerSubscription: mockRegisterSubscription,
    unregisterSubscription: mockUnregisterSubscription,
  }),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}))

import { DELETE, POST } from '../route'

function requestWith(body: unknown) {
  return { json: jest.fn().mockResolvedValue(body) } as never
}

describe('/api/push/subscribe ownership', () => {
  const endpoint = 'https://push.test/one'

  beforeEach(() => {
    jest.clearAllMocks()
    mockRegisterSubscription.mockResolvedValue({ id: 'subscription-a' })
    mockUnregisterSubscription.mockResolvedValue(undefined)
  })

  it('registers a validated Web Push endpoint for the authenticated user', async () => {
    const response = await POST(
      requestWith({
        token: endpoint,
        provider: 'web',
        platform: 'web',
        endpoint,
        p256dh: 'public-key',
        auth: 'auth-secret',
      })
    )

    expect(response.status).toBe(200)
    expect(mockRegisterSubscription).toHaveBeenCalledWith('user-a', endpoint, 'web', {
      deviceId: undefined,
      deviceName: undefined,
      platform: 'web',
      endpoint,
      p256dh: 'public-key',
      auth: 'auth-secret',
    })
  })

  it('rejects mismatched Web Push token and endpoint', async () => {
    const response = await POST(
      requestWith({
        token: endpoint,
        provider: 'web',
        endpoint: `${endpoint}-other`,
        p256dh: 'public-key',
        auth: 'auth-secret',
      })
    )

    expect(response.status).toBe(400)
    expect(mockRegisterSubscription).not.toHaveBeenCalled()
  })

  it('deletes only the authenticated user token supplied in the request body', async () => {
    const response = await DELETE(requestWith({ token: endpoint }))

    expect(response.status).toBe(200)
    expect(mockUnregisterSubscription).toHaveBeenCalledWith('user-a', endpoint)
  })
})
