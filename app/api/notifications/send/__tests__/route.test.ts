/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockVerifyServiceAuth = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockLogger = jest.fn()

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyServiceAuth: (...args: unknown[]) => mockVerifyServiceAuth(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: (...args: unknown[]) => mockLogger(...args) },
}))

import {
  V1_INTERNAL_NOTIFICATION_DELIVERY_NO_STORE_HEADERS,
  V1_INTERNAL_NOTIFICATION_DELIVERY_UNAVAILABLE_BODY,
} from '@/lib/notifications/v1-internal-delivery-publication'
import { POST } from '../route'

function unreadableRequest(headers: Record<string, string> = {}) {
  let urlReads = 0
  const json = jest.fn(() => {
    throw new Error('notification delivery hold must not read a request body')
  })
  const request = {
    headers: new Headers(headers),
    json,
    get url() {
      urlReads += 1
      return 'https://www.arenafi.org/api/notifications/send?type=ignored'
    },
  } as never

  return { request, json, urlReads: () => urlReads }
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(
    V1_INTERNAL_NOTIFICATION_DELIVERY_NO_STORE_HEADERS
  )) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('POST /api/notifications/send V1 internal delivery hold', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns a no-store 401 before endpoint work for invalid service authentication', async () => {
    mockVerifyServiceAuth.mockReturnValue(false)
    const input = unreadableRequest({ authorization: 'Bearer invalid' })

    const response = POST(input.request)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mockVerifyServiceAuth).toHaveBeenCalledWith(input.request)
    expect(input.json).not.toHaveBeenCalled()
    expect(input.urlReads()).toBe(0)
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockLogger).not.toHaveBeenCalled()
    expectNoStore(response)
  })

  it.each([
    ['a follow payload', { authorization: 'Bearer service-cron-secret' }],
    ['a trader alert payload', { 'x-internal-key': 'internal-api-key' }],
    ['an unsupported payload', { authorization: 'Bearer service-cron-secret' }],
  ])(
    'returns the same hold for authenticated service delivery regardless of %s',
    async (_name, headers) => {
      mockVerifyServiceAuth.mockReturnValue(true)
      const input = unreadableRequest(headers)

      const response = POST(input.request)

      expect(response.status).toBe(410)
      await expect(response.json()).resolves.toEqual(
        V1_INTERNAL_NOTIFICATION_DELIVERY_UNAVAILABLE_BODY
      )
      expect(mockVerifyServiceAuth).toHaveBeenCalledWith(input.request)
      expect(input.json).not.toHaveBeenCalled()
      expect(input.urlReads()).toBe(0)
      expect(mockCheckRateLimit).not.toHaveBeenCalled()
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
      expect(mockLogger).not.toHaveBeenCalled()
      expectNoStore(response)
    }
  )

  it('has no type filter, body, rate-limit, logger, or notification insert capability', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/notifications/send/route.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')

    expect(code).toContain('verifyServiceAuth(request)')
    expect(code).not.toMatch(
      /VALID_TYPES|UNPUBLISHED_TRADER_NOTIFICATION_TYPES|request\.json|request\.url|searchParams/
    )
    expect(code).not.toMatch(/checkRateLimit|RateLimitPresets|getSupabaseAdmin|handleError/)
    expect(code).not.toMatch(/\blogger\b|\.from\(|\.insert\(|\.select\(|\.single\(/)
  })
})
