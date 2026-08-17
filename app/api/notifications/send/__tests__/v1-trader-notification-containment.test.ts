/** @jest-environment node */

const mockGetSupabaseAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockVerifyServiceAuth = jest.fn()

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
  handleError: jest.fn(),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { write: { name: 'write-test-policy' } },
}))

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyServiceAuth: (...args: unknown[]) => mockVerifyServiceAuth(...args),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

function request(type: string): NextRequest {
  return new NextRequest('https://www.arenafi.org/api/notifications/send', {
    method: 'POST',
    body: JSON.stringify({
      user_id: '11111111-1111-4111-8111-111111111111',
      type,
      title: 'Retired notification',
      message: 'This must not be delivered.',
    }),
  })
}

function expectNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe(
    'private, no-store, max-age=0, must-revalidate'
  )
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
}

describe('V1 trader-notification containment for the internal sender', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifyServiceAuth.mockReturnValue(true)
    mockCheckRateLimit.mockResolvedValue(null)
  })

  it.each(['trader_alert', 'ranking_change'])(
    'rejects the unpublished %s type before rate limiting or database access',
    async (type) => {
      const response = await POST(request(type))

      expect(response.status).toBe(410)
      await expect(response.json()).resolves.toEqual({
        error: 'Retired notification type',
        code: 'TRADER_NOTIFICATIONS_NOT_PUBLISHED',
        message:
          'Trader alerts, ranking-change notifications, and personalized digests are temporarily unavailable during V1 verification.',
      })
      expect(mockVerifyServiceAuth).toHaveBeenCalledTimes(1)
      expect(mockCheckRateLimit).not.toHaveBeenCalled()
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
      expectNoStore(response)
    }
  )

  it('authenticates before reading a body or applying a rate limit', async () => {
    mockVerifyServiceAuth.mockReturnValue(false)
    const body = jest.fn(() => {
      throw new Error('unauthorized request body must remain unread')
    })

    const response = await POST({ json: body } as never)

    expect(response.status).toBe(401)
    expect(body).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expectNoStore(response)
  })
})
