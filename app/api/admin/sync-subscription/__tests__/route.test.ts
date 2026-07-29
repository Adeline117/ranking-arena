/** @jest-environment node */

const mockFrom = jest.fn()
const mockListSubscriptions = jest.fn()
const mockUpdateUserSubscription = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyAdminAuth: jest.fn().mockResolvedValue(true),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {} },
}))

jest.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    subscriptions: { list: (...args: unknown[]) => mockListSubscriptions(...args) },
  }),
  STRIPE_PRICE_IDS: {
    monthly: 'price_pro_monthly',
    yearly: 'price_pro_yearly',
  },
  SUBSCRIPTION_STATUS_MAP: {
    active: 'active',
    trialing: 'trialing',
  },
}))

jest.mock('@/app/api/stripe/webhook/handlers/subscription', () => ({
  updateUserSubscription: (...args: unknown[]) => mockUpdateUserSubscription(...args),
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

function profileQuery() {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    single: jest.fn().mockResolvedValue({
      data: {
        id: USER_ID,
        stripe_customer_id: 'cus_pro_owner',
        subscription_tier: 'free',
        pro_plan: null,
      },
      error: null,
    }),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function activeSubscription() {
  return {
    id: 'sub_pro_current',
    customer: 'cus_pro_owner',
    status: 'active',
    start_date: 1_800_000_000,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: 1_800_000_000,
          current_period_end: 1_802_592_000,
          price: { id: 'price_pro_monthly' },
        },
      ],
    },
  }
}

function request() {
  return new NextRequest(`http://localhost/api/admin/sync-subscription?userId=${USER_ID}`, {
    method: 'POST',
  })
}

describe('admin subscription synchronization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return profileQuery()
      throw new Error(`Unexpected direct admin write to ${table}`)
    })
    mockListSubscriptions.mockResolvedValue({
      data: [activeSubscription()],
      has_more: false,
    })
    mockUpdateUserSubscription.mockResolvedValue('updated')
  })

  it('uses the shared atomic financial projection writer for an active subscription', async () => {
    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, action: 'synced_active' })
    expect(mockUpdateUserSubscription).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ id: 'sub_pro_current' }),
      'monthly'
    )
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('reports a sticky full-refund block without direct-table Pro revival', async () => {
    mockUpdateUserSubscription.mockResolvedValue('blocked_full_refund')

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      action: 'blocked_full_refund',
    })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the atomic projection writer is unavailable', async () => {
    mockUpdateUserSubscription.mockRejectedValue(new Error('projection unavailable'))

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ error: 'Internal server error' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })
})
