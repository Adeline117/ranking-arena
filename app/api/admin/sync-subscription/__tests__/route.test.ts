/** @jest-environment node */

const mockFrom = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
}))

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyAdminAuth: jest.fn().mockResolvedValue(true),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {} },
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    apiError: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'

function queryResult(data: unknown, error: unknown = null) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error }),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function request(userId = USER_ID) {
  return new NextRequest(`http://localhost/api/admin/sync-subscription?userId=${userId}`, {
    method: 'POST',
  })
}

describe('admin subscription synchronization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReturnValueOnce(queryResult({ id: USER_ID })).mockReturnValueOnce(
      queryResult({
        id: USER_ID,
        is_pro: true,
        subscription_tier: 'pro',
        pro_plan: 'monthly',
        pro_expires_at: '2026-08-29T00:00:00.000Z',
        stripe_customer_id: 'cus_owner',
        stripe_subscription_id: 'sub_current',
      })
    )
    mockRpc.mockResolvedValue({
      data: {
        status: 'reconciled',
        processed_count: 2,
        authority_count: 1,
        next_cursor: '22222222-2222-4222-8222-222222222222',
        has_more: false,
      },
      error: null,
    })
  })

  it('uses the atomic projection and official-group authority', async () => {
    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      action: 'reconciled_authority',
      projection: { id: USER_ID, is_pro: true, subscription_tier: 'pro' },
      reconciliation: { processedCount: 2, authorityCount: 1, pages: 1 },
    })
    expect(mockRpc).toHaveBeenCalledWith('reconcile_due_pro_entitlement_projections_atomic', {
      p_limit: 500,
      p_after_user_id: null,
    })
    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual(['user_profiles', 'user_profiles'])
  })

  it('fails closed when atomic reconciliation is unavailable', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'projection unavailable' },
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-canonical subject before database access', async () => {
    const response = await POST(request('NOT-A-UUID'))

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
