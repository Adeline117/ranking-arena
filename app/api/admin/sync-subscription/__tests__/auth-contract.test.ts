/** @jest-environment node */

// Exercise the route with the real verifyAdminAuth implementation. The route
// must retain all three established administrator credential forms even while
// its reconciliation command is unavailable.
jest.mock('@/lib/env', () => ({
  env: {
    CRON_SECRET: 'sync-subscription-service-cron-secret',
  },
}))

const mockGetUser = jest.fn()
const mockMaybeSingle = jest.fn()
const mockFrom = jest.fn(() => ({
  select: jest.fn(() => ({
    eq: jest.fn(() => ({
      maybeSingle: mockMaybeSingle,
    })),
  })),
}))
const mockGetSupabaseAdmin = jest.fn(() => ({
  auth: { getUser: mockGetUser },
  from: mockFrom,
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

import { V1_BILLING_RECONCILIATION_UNAVAILABLE_BODY } from '@/lib/stripe/v1-billing-reconciliation-publication'
import { POST } from '../route'

const originalNodeEnv = process.env.NODE_ENV
const originalAdminApiKey = process.env.ADMIN_API_KEY
const originalAdminEmails = process.env.ADMIN_EMAILS

function request(headers: Record<string, string>): Request {
  return new Request('https://example.com/api/admin/sync-subscription?userId=ignored', {
    method: 'POST',
    headers,
  })
}

describe('POST /api/admin/sync-subscription credential contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.NODE_ENV = 'production'
    process.env.ADMIN_API_KEY = 'sync-subscription-admin-token'
    process.env.ADMIN_EMAILS = 'allowed-admin@example.com'
  })

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv
    if (originalAdminApiKey === undefined) delete process.env.ADMIN_API_KEY
    else process.env.ADMIN_API_KEY = originalAdminApiKey
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS
    else process.env.ADMIN_EMAILS = originalAdminEmails
  })

  it('accepts the established service CRON bearer before the V1 hold', async () => {
    const response = await POST(
      request({ authorization: 'Bearer sync-subscription-service-cron-secret' }) as never
    )

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual(V1_BILLING_RECONCILIATION_UNAVAILABLE_BODY)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('accepts the established x-admin-token before the V1 hold', async () => {
    const response = await POST(
      request({ 'x-admin-token': 'sync-subscription-admin-token' }) as never
    )

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual(V1_BILLING_RECONCILIATION_UNAVAILABLE_BODY)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('accepts an active production-allowlisted administrator JWT before the V1 hold', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-id', email: 'allowed-admin@example.com' } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({
      data: { role: 'admin', banned_at: null, deleted_at: null },
      error: null,
    })

    const response = await POST(
      request({ authorization: 'Bearer allowed-admin-jwt-token' }) as never
    )

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual(V1_BILLING_RECONCILIATION_UNAVAILABLE_BODY)
    expect(mockGetUser).toHaveBeenCalledWith('allowed-admin-jwt-token')
    expect(mockFrom).toHaveBeenCalledWith('user_profiles')
  })
})
