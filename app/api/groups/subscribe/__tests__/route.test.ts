jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()

    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    url: string
    method: string
    private readonly rawBody: string | undefined

    constructor(url: string, init: { method?: string; body?: string } = {}) {
      this.url = url
      this.method = init.method ?? 'GET'
      this.rawBody = init.body
    }

    async json() {
      if (this.rawBody === undefined) throw new Error('missing body')
      return JSON.parse(this.rawBody)
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockCheckoutRetrieve = jest.fn()
const mockPaymentIntentRetrieve = jest.fn()
const mockAssertStripePaymentRuntimeReady = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        supabase: { rpc: typeof mockRpc; from: typeof mockFrom }
        request: unknown
      }) => unknown
    ) =>
    (request: unknown) =>
      handler({
        user: { id: '11111111-1111-4111-8111-111111111111' },
        supabase: { rpc: mockRpc, from: mockFrom },
        request,
      }),
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/stripe', () => ({
  assertStripePaymentRuntimeReady: () => mockAssertStripePaymentRuntimeReady(),
}))
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    checkout: { sessions: { retrieve: mockCheckoutRetrieve } },
    paymentIntents: { retrieve: mockPaymentIntentRetrieve },
  })),
}))

import Stripe from 'stripe'
import { NextRequest } from 'next/server'
import { STRIPE_API_VERSION } from '@/lib/stripe/version'
import { DELETE, GET, POST } from '../route'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_GROUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUBSCRIPTION_ID = '33333333-3333-4333-8333-333333333333'
const PAYMENT_INTENT_ID = 'pi_paid_123'
const CHECKOUT_SESSION_ID = 'cs_paid_123'
const PERIOD_END = '2026-08-15T00:00:00.000Z'

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/groups/subscribe', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function rawPostRequest(body: string): NextRequest {
  return new NextRequest('http://localhost/api/groups/subscribe', {
    method: 'POST',
    body,
  })
}

function getRequest(groupId = GROUP_ID): NextRequest {
  return new NextRequest(
    `http://localhost/api/groups/subscribe?group_id=${encodeURIComponent(groupId)}`
  )
}

function deleteRequest(id = SUBSCRIPTION_ID): NextRequest {
  return new NextRequest(`http://localhost/api/groups/subscribe?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

function activationResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'subscribed',
    subscription_id: SUBSCRIPTION_ID,
    tier: 'trial',
    subscription_status: 'trialing',
    expires_at: PERIOD_END,
    price_paid: 0,
    membership_status: 'joined',
    member_count: 8,
    idempotent_replay: false,
    ...overrides,
  }
}

function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_INTENT_ID,
    status: 'succeeded',
    metadata: { user_id: ACTOR_ID, group_id: GROUP_ID, tier: 'monthly' },
    amount: 990,
    amount_received: 990,
    currency: 'usd',
    ...overrides,
  }
}

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: CHECKOUT_SESSION_ID,
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    client_reference_id: ACTOR_ID,
    metadata: { user_id: ACTOR_ID, group_id: GROUP_ID, tier: 'monthly' },
    amount_total: 990,
    currency: 'usd',
    payment_intent: PAYMENT_INTENT_ID,
    ...overrides,
  }
}

function readResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    group: {
      id: GROUP_ID,
      name: 'Paid group',
      is_premium_only: true,
      price_monthly: 9.9,
      price_yearly: 99.9,
      original_price_monthly: null,
      original_price_yearly: null,
      allow_trial: true,
      trial_days: 7,
    },
    subscription: {
      id: SUBSCRIPTION_ID,
      tier: 'monthly',
      status: 'active',
      expires_at: PERIOD_END,
      price_paid: 9.9,
      cancel_at_period_end: false,
    },
    is_subscribed: true,
    ...overrides,
  }
}

describe('/api/groups/subscribe atomic boundary', () => {
  const originalStripeSecret = process.env.STRIPE_SECRET_KEY

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit'
    mockAssertStripePaymentRuntimeReady.mockReturnValue(undefined)
    mockRpc.mockResolvedValue({ data: activationResult(), error: null })
  })

  afterAll(() => {
    if (originalStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY
    else process.env.STRIPE_SECRET_KEY = originalStripeSecret
  })

  it.each([
    { group_id: GROUP_ID, tier: 'trial' },
    {
      group_id: GROUP_ID,
      tier: 'trial',
      payment_intent_id: null,
      checkout_session_id: null,
      payment_provider: null,
      payment_reference: null,
      amount_cents: null,
      currency: null,
    },
  ])('activates a strict trial request through one actor-bound RPC', async (requestBody) => {
    const response = await POST(postRequest(requestBody))

    expect(response.status).toBe(201)
    expect(mockRpc).toHaveBeenCalledWith('activate_group_subscription_atomic', {
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
      p_tier: 'trial',
      p_payment_provider: null,
      p_payment_intent_id: null,
      p_checkout_session_id: null,
      p_amount_cents: 0,
      p_currency: null,
    })
    expect(mockCheckoutRetrieve).not.toHaveBeenCalled()
    expect(mockPaymentIntentRetrieve).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON before payment verification or RPC execution', async () => {
    const response = await POST(rawPostRequest('{'))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockPaymentIntentRetrieve).not.toHaveBeenCalled()
  })

  it.each([
    { group_id: 'not-a-uuid', tier: 'trial' },
    { group_id: GROUP_ID },
    { group_id: GROUP_ID, tier: 'trial', payment_intent_id: PAYMENT_INTENT_ID },
    { group_id: GROUP_ID, tier: 'trial', checkout_session_id: CHECKOUT_SESSION_ID },
    { group_id: GROUP_ID, tier: 'trial', unexpected: null },
    { group_id: GROUP_ID, tier: 'monthly' },
    { group_id: GROUP_ID, tier: 'monthly', payment_intent_id: 'bad' },
    {
      group_id: GROUP_ID,
      tier: 'monthly',
      payment_intent_id: PAYMENT_INTENT_ID,
      checkout_session_id: 'bad',
    },
    {
      group_id: GROUP_ID,
      tier: 'monthly',
      payment_intent_id: PAYMENT_INTENT_ID,
      payment_provider: 'stripe',
    },
    {
      group_id: GROUP_ID,
      tier: 'monthly',
      payment_intent_id: PAYMENT_INTENT_ID,
      payment_reference: null,
    },
    {
      group_id: GROUP_ID,
      tier: 'monthly',
      payment_intent_id: PAYMENT_INTENT_ID,
      amount_cents: 990,
    },
    {
      group_id: GROUP_ID,
      tier: 'monthly',
      payment_intent_id: PAYMENT_INTENT_ID,
      currency: 'usd',
    },
  ])('rejects malformed or client-authoritative activation body %#', async (requestBody) => {
    const response = await POST(postRequest(requestBody))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCheckoutRetrieve).not.toHaveBeenCalled()
    expect(mockPaymentIntentRetrieve).not.toHaveBeenCalled()
  })

  it('refuses paid activation when Stripe is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY

    const response = await POST(
      postRequest({
        group_id: GROUP_ID,
        tier: 'monthly',
        payment_intent_id: PAYMENT_INTENT_ID,
      })
    )

    expect(response.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockPaymentIntentRetrieve).not.toHaveBeenCalled()
  })

  it('refuses paid activation before provider retrieval when Production runtime is unsafe', async () => {
    mockAssertStripePaymentRuntimeReady.mockImplementation(() => {
      throw new Error('Stripe live mode is required for Production payment actions')
    })

    const response = await POST(
      postRequest({
        group_id: GROUP_ID,
        tier: 'monthly',
        payment_intent_id: PAYMENT_INTENT_ID,
      })
    )

    expect(response.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCheckoutRetrieve).not.toHaveBeenCalled()
    expect(mockPaymentIntentRetrieve).not.toHaveBeenCalled()
  })

  it('binds a succeeded PaymentIntent to exact metadata, USD and fully received amount', async () => {
    mockPaymentIntentRetrieve.mockResolvedValue(paymentIntent())
    mockRpc.mockResolvedValue({
      data: activationResult({
        tier: 'monthly',
        subscription_status: 'active',
        price_paid: 9.9,
      }),
      error: null,
    })

    const response = await POST(
      postRequest({
        group_id: GROUP_ID,
        tier: 'monthly',
        payment_intent_id: PAYMENT_INTENT_ID,
        checkout_session_id: null,
      })
    )

    expect(response.status).toBe(201)
    expect(mockPaymentIntentRetrieve).toHaveBeenCalledWith(PAYMENT_INTENT_ID)
    expect(mockRpc).toHaveBeenCalledWith('activate_group_subscription_atomic', {
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
      p_tier: 'monthly',
      p_payment_provider: 'stripe',
      p_payment_intent_id: PAYMENT_INTENT_ID,
      p_checkout_session_id: null,
      p_amount_cents: 990,
      p_currency: 'usd',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('constructs paid verification with the shared pinned Stripe API version', async () => {
    mockPaymentIntentRetrieve.mockResolvedValue(paymentIntent())
    mockRpc.mockResolvedValue({
      data: activationResult({
        tier: 'monthly',
        subscription_status: 'active',
        price_paid: 9.9,
      }),
      error: null,
    })

    const response = await POST(
      postRequest({
        group_id: GROUP_ID,
        tier: 'monthly',
        payment_intent_id: PAYMENT_INTENT_ID,
      })
    )

    expect(response.status).toBe(201)
    expect(STRIPE_API_VERSION).toBe('2026-04-22.dahlia')
    expect(Stripe).toHaveBeenCalledWith('sk_test_unit', {
      apiVersion: '2026-04-22.dahlia',
    })
  })

  it.each([
    ['returned id', { id: 'pi_other' }],
    ['status', { status: 'processing' }],
    ['actor metadata', { metadata: { user_id: 'other', group_id: GROUP_ID, tier: 'monthly' } }],
    [
      'group metadata',
      { metadata: { user_id: ACTOR_ID, group_id: OTHER_GROUP_ID, tier: 'monthly' } },
    ],
    ['tier metadata', { metadata: { user_id: ACTOR_ID, group_id: GROUP_ID, tier: 'yearly' } }],
    [
      'conflicting plan metadata',
      {
        metadata: {
          user_id: ACTOR_ID,
          group_id: GROUP_ID,
          tier: 'monthly',
          plan: 'yearly',
        },
      },
    ],
    ['missing metadata', { metadata: {} }],
    ['currency', { currency: 'eur' }],
    ['zero amount', { amount: 0, amount_received: 0 }],
    ['partially received amount', { amount: 990, amount_received: 989 }],
    ['unsafe amount', { amount: Number.MAX_SAFE_INTEGER + 1, amount_received: 990 }],
  ])('rejects PaymentIntent proof with invalid %s', async (_label, overrides) => {
    mockPaymentIntentRetrieve.mockResolvedValue(paymentIntent(overrides))

    const response = await POST(
      postRequest({
        group_id: GROUP_ID,
        tier: 'monthly',
        payment_intent_id: PAYMENT_INTENT_ID,
      })
    )

    expect(response.status).toBe(402)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('binds Checkout and its canonical PaymentIntent to the same immutable pass', async () => {
    mockCheckoutRetrieve.mockResolvedValue(
      checkoutSession({ payment_intent: { id: PAYMENT_INTENT_ID } })
    )
    mockPaymentIntentRetrieve.mockResolvedValue(paymentIntent())
    mockRpc.mockResolvedValue({
      data: activationResult({
        tier: 'monthly',
        subscription_status: 'active',
        price_paid: 9.9,
      }),
      error: null,
    })

    const response = await POST(
      postRequest({
        group_id: GROUP_ID,
        tier: 'monthly',
        payment_intent_id: PAYMENT_INTENT_ID,
        checkout_session_id: CHECKOUT_SESSION_ID,
      })
    )

    expect(response.status).toBe(201)
    expect(mockCheckoutRetrieve).toHaveBeenCalledWith(CHECKOUT_SESSION_ID, {
      expand: ['payment_intent'],
    })
    expect(mockPaymentIntentRetrieve).toHaveBeenCalledWith(PAYMENT_INTENT_ID)
    expect(mockRpc).toHaveBeenCalledWith(
      'activate_group_subscription_atomic',
      expect.objectContaining({
        p_payment_intent_id: PAYMENT_INTENT_ID,
        p_checkout_session_id: CHECKOUT_SESSION_ID,
        p_amount_cents: 990,
        p_currency: 'usd',
      })
    )
  })

  it.each([
    ['returned id', { id: 'cs_other' }],
    ['mode', { mode: 'subscription' }],
    ['status', { status: 'open' }],
    ['payment status', { payment_status: 'unpaid' }],
    ['client reference', { client_reference_id: 'other' }],
    ['missing client reference', { client_reference_id: null }],
    ['actor metadata', { metadata: { user_id: 'other', group_id: GROUP_ID, tier: 'monthly' } }],
    [
      'group metadata',
      { metadata: { user_id: ACTOR_ID, group_id: OTHER_GROUP_ID, tier: 'monthly' } },
    ],
    ['tier metadata', { metadata: { user_id: ACTOR_ID, group_id: GROUP_ID, tier: 'yearly' } }],
    ['currency', { currency: 'eur' }],
    ['amount', { amount_total: 0 }],
    ['missing payment intent', { payment_intent: null }],
    ['different payment intent', { payment_intent: 'pi_different' }],
  ])('rejects Checkout proof with invalid %s', async (_label, overrides) => {
    mockCheckoutRetrieve.mockResolvedValue(checkoutSession(overrides))
    mockPaymentIntentRetrieve.mockResolvedValue(paymentIntent())

    const response = await POST(
      postRequest({
        group_id: GROUP_ID,
        tier: 'monthly',
        payment_intent_id: PAYMENT_INTENT_ID,
        checkout_session_id: CHECKOUT_SESSION_ID,
      })
    )

    expect(response.status).toBe(402)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects a Checkout amount that differs from the canonical PaymentIntent', async () => {
    mockCheckoutRetrieve.mockResolvedValue(checkoutSession())
    mockPaymentIntentRetrieve.mockResolvedValue(
      paymentIntent({ amount: 991, amount_received: 991 })
    )

    const response = await POST(
      postRequest({
        group_id: GROUP_ID,
        tier: 'monthly',
        payment_intent_id: PAYMENT_INTENT_ID,
        checkout_session_id: CHECKOUT_SESSION_ID,
      })
    )

    expect(response.status).toBe(402)
    expect(mockPaymentIntentRetrieve).toHaveBeenCalledWith(PAYMENT_INTENT_ID)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when Stripe retrieval throws', async () => {
    mockPaymentIntentRetrieve.mockRejectedValue(new Error('provider unavailable'))

    const response = await POST(
      postRequest({
        group_id: GROUP_ID,
        tier: 'yearly',
        payment_intent_id: PAYMENT_INTENT_ID,
      })
    )

    expect(response.status).toBe(402)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    { data: null, error: { code: 'XX000' } },
    { data: null, error: null },
    { data: { status: 'unknown' }, error: null },
    {
      data: activationResult({ unexpected_authority: true }),
      error: null,
    },
    {
      data: { status: 'subscribed', subscription_id: SUBSCRIPTION_ID },
      error: null,
    },
  ])('rejects malformed atomic activation ACK %#', async (rpcResult) => {
    mockRpc.mockResolvedValue(rpcResult)

    const response = await POST(postRequest({ group_id: GROUP_ID, tier: 'trial' }))

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects a structurally valid activation ACK that contradicts the request tier', async () => {
    mockRpc.mockResolvedValue({
      data: activationResult({ status: 'renewed' }),
      error: null,
    })

    const response = await POST(postRequest({ group_id: GROUP_ID, tier: 'trial' }))

    expect(response.status).toBe(500)
  })

  it.each([
    ['banned', 403],
    ['score_too_low', 403],
    ['verified_only', 403],
    ['amount_mismatch', 409],
    ['payment_replayed', 409],
    ['not_found', 404],
    ['invalid_payment', 400],
  ])('maps authoritative activation status %s', async (status, expectedHttpStatus) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })

    const response = await POST(postRequest({ group_id: GROUP_ID, tier: 'trial' }))

    expect(response.status).toBe(expectedHttpStatus)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns 200 when a trial request finds an already-current entitlement', async () => {
    mockRpc.mockResolvedValue({
      data: activationResult({ status: 'already_active', idempotent_replay: true }),
      error: null,
    })

    const response = await POST(postRequest({ group_id: GROUP_ID, tier: 'trial' }))

    expect(response.status).toBe(200)
  })

  it('returns 200 for an exact paid-payment ledger replay', async () => {
    mockPaymentIntentRetrieve.mockResolvedValue(paymentIntent())
    mockRpc.mockResolvedValue({
      data: activationResult({
        tier: 'monthly',
        subscription_status: 'active',
        price_paid: 9.9,
        idempotent_replay: true,
      }),
      error: null,
    })

    const response = await POST(
      postRequest({
        group_id: GROUP_ID,
        tier: 'monthly',
        payment_intent_id: PAYMENT_INTENT_ID,
      })
    )

    expect(response.status).toBe(200)
  })

  it('reads group-pass state through one strict actor-bound RPC', async () => {
    mockRpc.mockResolvedValue({ data: readResult(), error: null })

    const response = await GET(getRequest())
    const responseBody = await response.json()

    expect(response.status).toBe(200)
    expect(responseBody.data.group.id).toBe(GROUP_ID)
    expect(responseBody.data.subscription.id).toBe(SUBSCRIPTION_ID)
    expect(responseBody.data.is_subscribed).toBe(true)
    expect(mockRpc).toHaveBeenCalledWith('read_group_subscription_atomic', {
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects an invalid GET group id before RPC execution', async () => {
    const response = await GET(getRequest('not-a-uuid'))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('maps an authoritative missing group read', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'not_found' }, error: null })

    const response = await GET(getRequest())

    expect(response.status).toBe(404)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { data: null, error: null },
    { data: null, error: { code: 'XX000' } },
    { data: { status: 'unknown' }, error: null },
    { data: readResult({ unexpected_authority: true }), error: null },
    { data: readResult({ is_subscribed: false }), error: null },
    {
      data: readResult({
        group: { ...readResult().group, id: OTHER_GROUP_ID },
      }),
      error: null,
    },
  ])('fails closed for malformed atomic read ACK %#', async (rpcResult) => {
    mockRpc.mockResolvedValue(rpcResult)

    const response = await GET(getRequest())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('schedules cancellation through one strict actor-bound RPC', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'cancellation_scheduled', expires_at: PERIOD_END },
      error: null,
    })

    const response = await DELETE(deleteRequest())
    const responseBody = await response.json()

    expect(response.status).toBe(200)
    expect(responseBody.data.status).toBe('cancellation_scheduled')
    expect(responseBody.data.expires_at).toBe(PERIOD_END)
    expect(mockRpc).toHaveBeenCalledWith('cancel_group_subscription_atomic', {
      p_actor_id: ACTOR_ID,
      p_subscription_id: SUBSCRIPTION_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['not-a-uuid', null, 400],
    [SUBSCRIPTION_ID, { data: { status: 'unknown' }, error: null }, 500],
    [SUBSCRIPTION_ID, { data: null, error: { code: 'XX000' } }, 500],
    [SUBSCRIPTION_ID, { data: { status: 'forbidden' }, error: null }, 403],
    [SUBSCRIPTION_ID, { data: { status: 'not_found' }, error: null }, 404],
    [SUBSCRIPTION_ID, { data: { status: 'expired', extra: true }, error: null }, 500],
  ])('fails closed for cancellation input/result %#', async (id, rpcResult, expectedStatus) => {
    if (rpcResult) mockRpc.mockResolvedValue(rpcResult)

    const response = await DELETE(deleteRequest(id))

    expect(response.status).toBe(expectedStatus)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
