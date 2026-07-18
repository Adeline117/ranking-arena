/** @jest-environment node */

const mockFrom = jest.fn()
const mockRetrieve = jest.fn()
const mockList = jest.fn()
const mockUpdateUserSubscription = jest.fn()
const mockCheckNFTMembership = jest.fn()

jest.mock('@/lib/stripe', () => ({
  getStripe: () => ({ subscriptions: { retrieve: mockRetrieve, list: mockList } }),
  STRIPE_PRICE_IDS: {
    monthly: 'price_monthly',
    yearly: 'price_yearly',
    lifetime: 'price_lifetime',
  },
  STRIPE_API_PRICE_IDS: { starter: 'price_api_starter', pro: 'price_api_pro' },
}))

jest.mock('@/app/api/stripe/webhook/handlers/subscription', () => ({
  updateUserSubscription: (...args: unknown[]) => mockUpdateUserSubscription(...args),
}))

jest.mock('@/lib/web3/nft', () => ({
  checkNFTMembership: (...args: unknown[]) => mockCheckNFTMembership(...args),
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: jest.fn().mockResolvedValue({
    sent: false,
    rateLimited: false,
    channels: [],
  }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    const result = await handler(request, { supabase: { from: mockFrom } })
    return Response.json({ ok: true, ...result })
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function chainable(result: { data?: unknown; error?: unknown }) {
  const handler = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(result)
          return jest.fn().mockImplementation(handler)
        },
      }
    )
  return handler()
}

function queueDatabaseResults(...results: Array<{ data?: unknown; error?: unknown }>) {
  const queue = [...results]
  mockFrom.mockImplementation(() => {
    const result = queue.shift()
    if (!result) throw new Error('Unexpected database query')
    return chainable(result)
  })
}

function stripeSubscription(status: 'active' | 'canceled' = 'active') {
  return {
    id: 'sub_verified',
    status,
    customer: 'cus_owner',
    start_date: 1_700_000_000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_monthly' } }] },
  }
}

describe('GET /api/cron/reconcile-subscriptions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdateUserSubscription.mockResolvedValue(undefined)
  })

  it('does not grant Pro when Stripe retrieval fails', async () => {
    queueDatabaseResults(
      {
        data: [
          {
            user_id: 'user-1',
            stripe_subscription_id: 'sub_local',
            stripe_customer_id: 'cus_owner',
          },
        ],
        error: null,
      },
      { data: [{ id: 'user-1', stripe_customer_id: 'cus_owner' }], error: null },
      { data: [], error: null }
    )
    mockRetrieve.mockRejectedValue(new Error('Stripe unavailable'))

    const response = await GET(new NextRequest('http://localhost/api/cron/reconcile-subscriptions'))
    const body = await response.json()

    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    expect(body).toMatchObject({ upgraded: 0, skipped: 1 })
  })

  it('repairs a free profile only after Stripe confirms an active configured price', async () => {
    const verified = stripeSubscription()
    queueDatabaseResults(
      {
        data: [
          {
            user_id: 'user-1',
            stripe_subscription_id: 'sub_verified',
            stripe_customer_id: 'cus_owner',
          },
        ],
        error: null,
      },
      { data: [{ id: 'user-1', stripe_customer_id: 'cus_owner' }], error: null },
      { data: [], error: null }
    )
    mockRetrieve.mockResolvedValue(verified)

    const response = await GET(new NextRequest('http://localhost/api/cron/reconcile-subscriptions'))
    const body = await response.json()

    expect(mockUpdateUserSubscription).toHaveBeenCalledWith('user-1', verified, 'monthly')
    expect(body).toMatchObject({ upgraded: 1, skipped: 0 })
  })

  it('preserves Pro when Stripe cannot verify that recurring access ended', async () => {
    queueDatabaseResults(
      { data: [], error: null },
      {
        data: [{ id: 'user-1', pro_plan: 'monthly', stripe_customer_id: 'cus_owner' }],
        error: null,
      },
      { data: [], error: null },
      { data: [], error: null }
    )
    mockList.mockRejectedValue(new Error('Stripe unavailable'))

    const response = await GET(new NextRequest('http://localhost/api/cron/reconcile-subscriptions'))
    const body = await response.json()

    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    expect(body).toMatchObject({ downgraded: 0, skipped: 1 })
  })

  it('does not let an NFT badge preserve Pro after Stripe confirms access ended', async () => {
    queueDatabaseResults(
      { data: [], error: null },
      {
        data: [{ id: 'user-1', pro_plan: 'monthly', stripe_customer_id: 'cus_owner' }],
        error: null,
      },
      { data: [], error: null },
      { data: null, error: null }
    )
    mockList.mockResolvedValue({ data: [stripeSubscription('canceled')] })
    mockCheckNFTMembership.mockResolvedValue(true)

    const response = await GET(new NextRequest('http://localhost/api/cron/reconcile-subscriptions'))
    const body = await response.json()

    expect(body).toMatchObject({ downgraded: 1, skipped: 0 })
    expect(mockCheckNFTMembership).not.toHaveBeenCalled()
  })
})
