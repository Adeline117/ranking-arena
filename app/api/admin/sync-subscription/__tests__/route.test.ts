/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockVerifyAdminAuth = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockGetStripe = jest.fn()
const mockLogger = jest.fn()

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyAdminAuth: (...args: unknown[]) => mockVerifyAdminAuth(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/stripe', () => ({
  getStripe: (...args: unknown[]) => mockGetStripe(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: (...args: unknown[]) => mockLogger(...args),
}))

import {
  V1_BILLING_RECONCILIATION_NO_STORE_HEADERS,
  V1_BILLING_RECONCILIATION_UNAVAILABLE_BODY,
} from '@/lib/stripe/v1-billing-reconciliation-publication'
import { POST } from '../route'

function unreadableRequest(headers: Record<string, string> = {}) {
  let urlReads = 0
  const json = jest.fn(() => {
    throw new Error('subscription-sync hold must not read a request body')
  })
  const request = {
    headers: new Headers(headers),
    json,
    get url() {
      urlReads += 1
      return 'https://example.com/api/admin/sync-subscription?userId=ignored'
    },
  } as never

  return { request, json, urlReads: () => urlReads }
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_BILLING_RECONCILIATION_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('POST /api/admin/sync-subscription V1 hold', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns a no-store 401 before endpoint work for invalid admin authentication', async () => {
    mockVerifyAdminAuth.mockResolvedValue(false)
    const input = unreadableRequest({ authorization: 'Bearer invalid' })

    const response = await POST(input.request)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mockVerifyAdminAuth).toHaveBeenCalledWith(input.request)
    expect(input.json).not.toHaveBeenCalled()
    expect(input.urlReads()).toBe(0)
    expectNoStore(response)
  })

  it.each([
    ['service CRON bearer', { authorization: 'Bearer service-cron-secret' }],
    ['x-admin-token', { 'x-admin-token': 'admin-panel-token' }],
    ['allowed administrator JWT', { authorization: 'Bearer allowlisted-admin-jwt' }],
  ])(
    'preserves %s authentication handoff before returning the fixed hold',
    async (_name, headers) => {
      mockVerifyAdminAuth.mockImplementation(async (request: Request) => {
        return Object.entries(headers).every(
          ([header, value]) => request.headers.get(header) === value
        )
      })
      const input = unreadableRequest(headers)

      const response = await POST(input.request)

      expect(response.status).toBe(410)
      await expect(response.json()).resolves.toEqual(V1_BILLING_RECONCILIATION_UNAVAILABLE_BODY)
      expect(mockVerifyAdminAuth).toHaveBeenCalledWith(input.request)
      expect(input.json).not.toHaveBeenCalled()
      expect(input.urlReads()).toBe(0)
      expectNoStore(response)
    }
  )

  it('has no rate-limit, query, Stripe, logging, or endpoint database capability', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/admin/sync-subscription/route.ts'),
      'utf8'
    )
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')

    expect(code).toContain('verifyAdminAuth(request)')
    expect(code).not.toMatch(
      /checkRateLimit|RateLimitPresets|request\.url|searchParams|request\.json/
    )
    expect(code).not.toMatch(/getSupabaseAdmin|getStripe|STRIPE_PRICE_IDS|SUBSCRIPTION_STATUS_MAP/)
    expect(code).not.toMatch(/\blogger\b|\.from\(|\.upsert\(|\.update\(/)
    expect(code).not.toMatch(/user_profiles|subscriptions|stripe_customer_id|userId/)
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockGetStripe).not.toHaveBeenCalled()
    expect(mockLogger).not.toHaveBeenCalled()
  })
})
