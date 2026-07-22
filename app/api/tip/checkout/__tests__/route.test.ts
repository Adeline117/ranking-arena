jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number

    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const USER_ID = '10000000-0000-4000-8000-000000000001'
const POST_ID = '20000000-0000-4000-8000-000000000002'
const RECIPIENT_ID = '30000000-0000-4000-8000-000000000003'
const TIP_ID = '40000000-0000-4000-8000-000000000004'
const EXPIRES_AT = '2030-01-01T00:00:00.000Z'
const EXPIRES_AT_SECONDS = Date.parse(EXPIRES_AT) / 1000

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockAuthenticatedPost = jest.fn()
const mockUser = { id: USER_ID, email: 'tipper@example.com' }

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: (context: unknown) => unknown) => (request: unknown) => {
    mockAuthenticatedPost(request)
    return handler({
      user: mockUser,
      supabase: { rpc: mockRpc, from: mockFrom },
      request,
    })
  },
}))

jest.mock('@/lib/api/response', () => {
  const response = (error: string, status: number) => {
    const { NextResponse } = require('next/server')
    return NextResponse.json({ error }, { status })
  }
  return {
    badRequest: (message: string) => response(message, 400),
    notFound: (message: string) => response(message, 404),
  }
})

const mockCreateOneTimePaymentSession = jest.fn()
const mockGetOrCreateStripeCustomer = jest.fn()
const mockRetrieveSession = jest.fn()
const mockListLineItems = jest.fn()
const mockExpireSession = jest.fn()

jest.mock('@/lib/stripe', () => ({
  createOneTimePaymentSession: (...args: unknown[]) => mockCreateOneTimePaymentSession(...args),
  getOrCreateStripeCustomer: (...args: unknown[]) => mockGetOrCreateStripeCustomer(...args),
  getStripe: () => ({
    checkout: {
      sessions: {
        retrieve: mockRetrieveSession,
        listLineItems: mockListLineItems,
        expire: mockExpireSession,
      },
    },
  }),
}))

jest.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://arena.example' },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

jest.mock('@/lib/utils/sanitize', () => ({
  sanitizeInput: (value: string) => `safe:${value}`,
}))

function makeQuery(result: { data: unknown; error: unknown }) {
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        return jest.fn(() => proxy)
      },
    }
  )
  return proxy
}

function requestWith(body: Record<string, unknown>) {
  return { json: jest.fn().mockResolvedValue(body) }
}

function reservation(
  status: 'reserved' | 'reservation_exists' | 'reservation_expiring' | 'already_bound' = 'reserved'
) {
  return {
    status,
    tip_id: TIP_ID,
    post_id: POST_ID,
    to_user_id: RECIPIENT_ID,
    checkout_expires_at: EXPIRES_AT,
    ...(status === 'already_bound' ? { checkout_session_id: 'cs_tip_atomic' } : {}),
  }
}

function metadata() {
  return {
    type: 'tip',
    tip_id: TIP_ID,
    user_id: USER_ID,
    from_user_id: USER_ID,
    post_id: POST_ID,
    to_user_id: RECIPIENT_ID,
    amount_cents: '500',
  }
}

function freshSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_tip_atomic',
    object: 'checkout.session',
    url: 'https://checkout.stripe.com/c/pay/cs_tip_atomic',
    customer: 'cus_tip_atomic',
    client_reference_id: TIP_ID,
    metadata: metadata(),
    expires_at: EXPIRES_AT_SECONDS,
    mode: 'payment',
    status: 'open',
    payment_status: 'unpaid',
    subscription: null,
    invoice: null,
    after_expiration: null,
    currency: 'usd',
    amount_subtotal: 500,
    amount_total: 500,
    total_details: { amount_discount: 0, amount_tax: 0 },
    allow_promotion_codes: false,
    automatic_tax: { enabled: false },
    adaptive_pricing: { enabled: false },
    livemode: true,
    discounts: [],
    shipping_cost: null,
    ...overrides,
  }
}

function freshLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'li_tip_atomic',
    object: 'item',
    quantity: 1,
    currency: 'usd',
    amount_subtotal: 500,
    amount_total: 500,
    amount_discount: 0,
    amount_tax: 0,
    discounts: [],
    taxes: [],
    price: {
      id: 'price_tip_atomic',
      object: 'price',
      currency: 'usd',
      unit_amount: 500,
      type: 'one_time',
      recurring: null,
      livemode: true,
      product: {
        id: 'prod_tip_atomic',
        object: 'product',
        name: 'Arena creator tip',
        description: 'Support a creator on Arena.',
        livemode: true,
      },
    },
    ...overrides,
  }
}

function useRpcStatus(
  options: {
    customerBind?: { data: unknown; error: unknown }
    reserve?: { data: unknown; error: unknown }
    tipBind?: { data: unknown; error: unknown }
  } = {}
) {
  mockRpc.mockImplementation((name: string) => {
    if (name === 'bind_stripe_customer_owner_atomic') {
      return Promise.resolve(options.customerBind ?? { data: { status: 'bound' }, error: null })
    }
    if (name === 'reserve_tip_checkout_atomic') {
      return Promise.resolve(options.reserve ?? { data: reservation(), error: null })
    }
    if (name === 'bind_tip_checkout_session_atomic') {
      return Promise.resolve(options.tipBind ?? { data: { status: 'bound' }, error: null })
    }
    throw new Error(`Unexpected RPC: ${name}`)
  })
}

import { POST } from '../route'

describe('POST /api/tip/checkout', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.STRIPE_TIP_CHECKOUT_ENABLED = 'true'
    delete process.env.VERCEL_ENV
    process.env.STRIPE_SECRET_KEY = 'sk_live_tip'
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_live_tip'

    mockFrom.mockReturnValue(
      makeQuery({ data: { stripe_customer_id: 'cus_tip_atomic' }, error: null })
    )
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_tip_atomic')
    mockCreateOneTimePaymentSession.mockResolvedValue({ id: 'cs_tip_atomic' })
    mockRetrieveSession.mockResolvedValue(freshSession())
    mockListLineItems.mockResolvedValue({ data: [freshLine()], has_more: false })
    mockExpireSession.mockResolvedValue({ id: 'cs_tip_atomic', status: 'expired' })
    useRpcStatus()
  })

  afterAll(() => {
    delete process.env.STRIPE_TIP_CHECKOUT_ENABLED
    delete process.env.VERCEL_ENV
    delete process.env.STRIPE_SECRET_KEY
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  })

  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['non-exact uppercase value', 'TRUE'],
  ])(
    'fails closed before auth and payment work in every runtime when the gate is %s',
    async (_, value) => {
      if (value === undefined) delete process.env.STRIPE_TIP_CHECKOUT_ENABLED
      else process.env.STRIPE_TIP_CHECKOUT_ENABLED = value

      const response = await POST({} as never)

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: 'Tip checkout is temporarily unavailable.',
        code: 'TIP_CHECKOUT_UNAVAILABLE',
      })
      expect(mockAuthenticatedPost).not.toHaveBeenCalled()
      expect(mockRpc).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
      expect(mockCreateOneTimePaymentSession).not.toHaveBeenCalled()
    }
  )

  it('fails before auth when the flag is true but Stripe is test mode and VERCEL_ENV is absent', async () => {
    delete process.env.VERCEL_ENV
    process.env.STRIPE_SECRET_KEY = 'sk_test_tip'
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_tip'

    const response = await POST({} as never)

    expect(response.status).toBe(503)
    expect(mockAuthenticatedPost).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockCreateOneTimePaymentSession).not.toHaveBeenCalled()
  })

  it('delegates in Production only when the server gate is exactly true', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.STRIPE_TIP_CHECKOUT_ENABLED = 'true'
    const request = requestWith({ post_id: 'invalid' })

    const response = await POST(request as never)

    expect(response.status).toBe(400)
    expect(mockAuthenticatedPost).toHaveBeenCalledWith(request)
  })

  it('rejects fractional cents before Customer or DB work', async () => {
    const response = await POST(requestWith({ post_id: POST_ID, amount_cents: 100.5 }) as never)

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('establishes Customer ownership, reserves, verifies, binds, then returns the exact URL', async () => {
    const response = await POST(
      requestWith({
        post_id: POST_ID,
        amount_cents: 500,
        message: '  <b>thanks</b>  ',
      }) as never
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      sessionId: 'cs_tip_atomic',
      url: 'https://checkout.stripe.com/c/pay/cs_tip_atomic',
    })
    expect(mockGetOrCreateStripeCustomer).toHaveBeenCalledWith(
      USER_ID,
      'tipper@example.com',
      undefined,
      'cus_tip_atomic'
    )
    expect(mockRpc).toHaveBeenCalledWith('reserve_tip_checkout_atomic', {
      p_from_user_id: USER_ID,
      p_post_id: POST_ID,
      p_amount_cents: 500,
      p_message: 'safe:<b>thanks</b>',
      p_checkout_ttl_seconds: 3600,
    })
    expect(mockCreateOneTimePaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_tip_atomic',
        userId: USER_ID,
        idempotencyKey: `checkout_tip_v1_${TIP_ID}`,
        clientReferenceId: TIP_ID,
        expiresAt: EXPIRES_AT_SECONDS,
        metadata: metadata(),
        lineItems: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'Arena creator tip',
                description: 'Support a creator on Arena.',
              },
              unit_amount: 500,
            },
            quantity: 1,
          },
        ],
      })
    )
    expect(mockRpc).toHaveBeenCalledWith('bind_tip_checkout_session_atomic', {
      p_tip_id: TIP_ID,
      p_from_user_id: USER_ID,
      p_checkout_session_id: 'cs_tip_atomic',
      p_checkout_expires_at: EXPIRES_AT,
    })

    const customerBindOrder = mockRpc.mock.invocationCallOrder[0]
    const reserveOrder = mockRpc.mock.invocationCallOrder[1]
    const createOrder = mockCreateOneTimePaymentSession.mock.invocationCallOrder[0]
    const retrieveOrder = mockRetrieveSession.mock.invocationCallOrder[0]
    const tipBindOrder = mockRpc.mock.invocationCallOrder[2]
    expect(customerBindOrder).toBeLessThan(reserveOrder)
    expect(reserveOrder).toBeLessThan(createOrder)
    expect(createOrder).toBeLessThan(retrieveOrder)
    expect(retrieveOrder).toBeLessThan(tipBindOrder)
  })

  it('recovers an unbound reservation with the same durable Stripe identity', async () => {
    useRpcStatus({ reserve: { data: reservation('reservation_exists'), error: null } })

    const response = await POST(requestWith({ post_id: POST_ID, amount_cents: 500 }) as never)

    expect(response.status).toBe(200)
    expect(mockCreateOneTimePaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `checkout_tip_v1_${TIP_ID}` })
    )
  })

  it('canonicalizes an uppercase UUID before reserving durable identity', async () => {
    const response = await POST(
      requestWith({ post_id: POST_ID.toUpperCase(), amount_cents: 500 }) as never
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'reserve_tip_checkout_atomic',
      expect.objectContaining({ p_post_id: POST_ID })
    )
  })

  it('recovers a bound reservation by fresh retrieve and never creates a second Session', async () => {
    useRpcStatus({ reserve: { data: reservation('already_bound'), error: null } })

    const response = await POST(requestWith({ post_id: POST_ID, amount_cents: 500 }) as never)

    expect(response.status).toBe(200)
    expect(mockCreateOneTimePaymentSession).not.toHaveBeenCalled()
    expect(mockRetrieveSession).toHaveBeenCalledWith('cs_tip_atomic', {
      expand: ['line_items.data.price.product'],
    })
    expect(mockRpc).not.toHaveBeenCalledWith('bind_tip_checkout_session_atomic', expect.anything())
  })

  it('preserves the reservation when Stripe create is ambiguous', async () => {
    mockCreateOneTimePaymentSession.mockRejectedValue(new Error('connection reset'))

    const response = await POST(requestWith({ post_id: POST_ID, amount_cents: 500 }) as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockRetrieveSession).not.toHaveBeenCalled()
    expect(mockExpireSession).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalledWith('bind_tip_checkout_session_atomic', expect.anything())
  })

  it.each([
    ['amount', { amount_total: 600 }],
    ['metadata snapshot', { metadata: { ...metadata(), to_user_id: USER_ID } }],
    ['expiry', { expires_at: EXPIRES_AT_SECONDS + 1 }],
    ['client reference', { client_reference_id: RECIPIENT_ID }],
    ['customer', { customer: 'cus_other' }],
    ['state', { payment_status: 'paid' }],
    ['livemode', { livemode: false }],
    ['URL', { url: 'http://checkout.stripe.com/c/pay/cs_tip_atomic' }],
  ])('expires a freshly created Session when %s drifts', async (_, drift) => {
    mockRetrieveSession.mockResolvedValue(freshSession(drift))

    const response = await POST(requestWith({ post_id: POST_ID, amount_cents: 500 }) as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockExpireSession).toHaveBeenCalledWith('cs_tip_atomic')
    expect(mockRpc).not.toHaveBeenCalledWith('bind_tip_checkout_session_atomic', expect.anything())
  })

  it('expires and withholds the URL when the DB bind response is rejected or ambiguous', async () => {
    useRpcStatus({
      tipBind: { data: { status: 'identity_conflict' }, error: { message: 'lost ACK' } },
    })

    const response = await POST(requestWith({ post_id: POST_ID, amount_cents: 500 }) as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockExpireSession).toHaveBeenCalledWith('cs_tip_atomic')
  })

  it.each([
    ['not_found', 404],
    ['recipient_unavailable', 404],
    ['self_tip', 400],
  ])('maps reserve status %s without creating Stripe Checkout', async (status, expectedStatus) => {
    useRpcStatus({ reserve: { data: { status }, error: null } })

    const response = await POST(requestWith({ post_id: POST_ID, amount_cents: 500 }) as never)

    expect(response.status).toBe(expectedStatus)
    expect(mockCreateOneTimePaymentSession).not.toHaveBeenCalled()
  })

  it('fails closed on an expiring, malformed, or unknown reservation', async () => {
    useRpcStatus({ reserve: { data: reservation('reservation_expiring'), error: null } })
    const expiring = await POST(requestWith({ post_id: POST_ID, amount_cents: 500 }) as never)
    expect(expiring.status).toBe(503)
    expect(mockCreateOneTimePaymentSession).not.toHaveBeenCalled()

    jest.clearAllMocks()
    mockFrom.mockReturnValue(
      makeQuery({ data: { stripe_customer_id: 'cus_tip_atomic' }, error: null })
    )
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_tip_atomic')
    useRpcStatus({ reserve: { data: { ...reservation(), tip_id: 'not-a-uuid' }, error: null } })
    const malformed = await POST(requestWith({ post_id: POST_ID, amount_cents: 500 }) as never)
    expect(malformed.status).toBe(503)
    expect(mockCreateOneTimePaymentSession).not.toHaveBeenCalled()
  })

  it('fails before reservation when exact Customer ownership cannot bind', async () => {
    useRpcStatus({
      customerBind: { data: { status: 'identity_conflict' }, error: null },
    })

    const response = await POST(requestWith({ post_id: POST_ID, amount_cents: 500 }) as never)

    expect(response.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalledWith('reserve_tip_checkout_atomic', expect.anything())
    expect(mockCreateOneTimePaymentSession).not.toHaveBeenCalled()
  })
})
