jest.mock('next/server', () => {
  class MockHeaders {
    private readonly values = new Map<string, string>()

    constructor(initial?: Record<string, string>) {
      for (const [key, value] of Object.entries(initial ?? {})) this.set(key, value)
    }

    get(key: string) {
      return this.values.get(key.toLowerCase()) ?? null
    }

    set(key: string, value: string) {
      this.values.set(key.toLowerCase(), value)
    }
  }

  class MockNextResponse {
    _body: unknown
    status: number
    headers: MockHeaders

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new MockHeaders(init.headers)
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

const VIEWER_ID = '10000000-0000-4000-8000-000000000001'
const POST_ID = '20000000-0000-4000-8000-000000000002'
const RECIPIENT_ID = '30000000-0000-4000-8000-000000000003'
const TIP_ID = '40000000-0000-4000-8000-000000000004'
const SESSION_ID = 'cs_tip_atomic'

const mockFrom = jest.fn()
const mockAuthenticatedPost = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: (context: unknown) => unknown) => (request: unknown) => {
    mockAuthenticatedPost(request)
    return handler({
      user: { id: VIEWER_ID, email: 'tipper@example.com' },
      supabase: { from: mockFrom },
      request,
    })
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

type QueryResult = { data: unknown; error: { message: string } | null }

function makeQuery(result: QueryResult) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.maybeSingle.mockResolvedValue(result)
  return query
}

function requestWith(body: unknown) {
  return { json: jest.fn().mockResolvedValue(body) }
}

function tipAuthority(overrides: Record<string, unknown> = {}) {
  return {
    id: TIP_ID,
    from_user_id: VIEWER_ID,
    checkout_post_id: POST_ID,
    checkout_to_user_id: RECIPIENT_ID,
    amount_cents: 500,
    status: 'completed',
    stripe_checkout_session_id: SESSION_ID,
    stripe_payment_intent_id: 'pi_tip_atomic',
    stripe_charge_id: 'ch_tip_atomic',
    stripe_customer_id: 'cus_tip_atomic',
    currency: 'usd',
    completed_at: '2026-08-03T12:00:00+00:00',
    checkout_expires_at: '2026-08-03T13:00:00+00:00',
    ...overrides,
  }
}

function ownership(overrides: Record<string, unknown> = {}) {
  return {
    product_kind: 'tip',
    ledger_id: TIP_ID,
    owner_user_id: VIEWER_ID,
    amount_paid: 500,
    currency: 'usd',
    livemode: true,
    checkout_session_id: SESSION_ID,
    stripe_payment_intent_id: 'pi_tip_atomic',
    stripe_charge_id: 'ch_tip_atomic',
    stripe_customer_id: 'cus_tip_atomic',
    ...overrides,
  }
}

function useAuthority(
  tip: QueryResult = { data: tipAuthority(), error: null },
  paymentOwnership: QueryResult = { data: ownership(), error: null }
) {
  const tipQuery = makeQuery(tip)
  const ownershipQuery = makeQuery(paymentOwnership)
  mockFrom.mockImplementation((table: string) => {
    if (table === 'tips') return tipQuery
    if (table === 'stripe_payment_ownerships') return ownershipQuery
    throw new Error(`Unexpected table: ${table}`)
  })
  return { tipQuery, ownershipQuery }
}

import { POST } from '../route'

describe('POST /api/tip/verify-session', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useAuthority()
  })

  it('returns an exact receipt only for the current viewer and complete durable ownership', async () => {
    const { tipQuery, ownershipQuery } = useAuthority()

    const response = await POST(requestWith({ session_id: SESSION_ID }) as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: {
        tip: {
          tip_id: TIP_ID,
          session_id: SESSION_ID,
          from_user_id: VIEWER_ID,
          post_id: POST_ID,
          to_user_id: RECIPIENT_ID,
          amount_cents: 500,
          currency: 'usd',
          status: 'completed',
          completed_at: '2026-08-03T12:00:00+00:00',
        },
      },
      meta: { timestamp: expect.any(String) },
    })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(tipQuery.eq).toHaveBeenCalledWith('stripe_checkout_session_id', SESSION_ID)
    expect(tipQuery.eq).toHaveBeenCalledWith('from_user_id', VIEWER_ID)
    expect(tipQuery.maybeSingle).toHaveBeenCalledTimes(2)
    expect(ownershipQuery.eq).toHaveBeenCalledWith('product_kind', 'tip')
    expect(ownershipQuery.eq).toHaveBeenCalledWith('ledger_id', TIP_ID)
    expect(mockAuthenticatedPost).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['extra field', { session_id: SESSION_ID, amount_cents: 500 }],
    ['wrong field', { sessionId: SESSION_ID }],
    ['coerced identity', { session_id: 123 }],
    ['invalid Stripe identity', { session_id: 'pi_not_checkout' }],
  ])('rejects a strict-body violation: %s', async (_, body) => {
    const response = await POST(requestWith(body) as never)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      success: false,
      code: 'TIP_PAYMENT_NOT_FOUND',
      error: 'Invalid tip session identity',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['pending', 409, 'TIP_PAYMENT_PENDING'],
    ['failed', 410, 'TIP_PAYMENT_FAILED'],
    ['refunded', 410, 'TIP_PAYMENT_REFUNDED'],
    ['identity_conflict', 409, 'TIP_PAYMENT_IDENTITY_CONFLICT'],
  ])('never projects %s as payment success', async (status, expectedStatus, expectedCode) => {
    useAuthority({ data: tipAuthority({ status }), error: null })

    const response = await POST(requestWith({ session_id: SESSION_ID }) as never)
    const body = await response.json()

    expect(response.status).toBe(expectedStatus)
    expect(body).toEqual(
      expect.objectContaining({ success: false, code: expectedCode, error: expect.any(String) })
    )
    expect(mockFrom).not.toHaveBeenCalledWith('stripe_payment_ownerships')
  })

  it('does not reveal a session owned by another viewer', async () => {
    useAuthority({ data: null, error: null })

    const response = await POST(requestWith({ session_id: SESSION_ID }) as never)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      success: false,
      code: 'TIP_PAYMENT_NOT_FOUND',
      error: 'Tip payment was not found for this account.',
    })
  })

  it('does not project a completed snapshot that becomes refunded before the final read', async () => {
    const { tipQuery } = useAuthority()
    tipQuery.maybeSingle
      .mockResolvedValueOnce({ data: tipAuthority(), error: null })
      .mockResolvedValueOnce({ data: tipAuthority({ status: 'refunded' }), error: null })

    const response = await POST(requestWith({ session_id: SESSION_ID }) as never)

    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({
      success: false,
      code: 'TIP_PAYMENT_REFUNDED',
      error: 'Tip payment has been refunded.',
    })
  })

  it.each([
    ['Tip DB error', { data: null, error: { message: 'db down' } }, undefined],
    [
      'incomplete completed Tip',
      { data: tipAuthority({ stripe_charge_id: null }), error: null },
      undefined,
    ],
    [
      'mismatched ownership',
      { data: tipAuthority(), error: null },
      { data: ownership({ amount_paid: 300 }), error: null },
    ],
    [
      'ownership DB error',
      { data: tipAuthority(), error: null },
      { data: null, error: { message: 'ownership down' } },
    ],
  ])('fails closed when authority has %s', async (_, tip, paymentOwnership) => {
    useAuthority(tip as QueryResult, paymentOwnership as QueryResult | undefined)

    const response = await POST(requestWith({ session_id: SESSION_ID }) as never)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      success: false,
      code: 'TIP_PAYMENT_AUTHORITY_UNAVAILABLE',
      error: 'Tip payment authority is unavailable. Please retry.',
    })
  })
})
