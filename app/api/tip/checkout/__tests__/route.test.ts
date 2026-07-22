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

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockAuthenticatedPost = jest.fn()
const mockUser = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'tipper@example.com',
}

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
    serverError: (message: string) => response(message, 500),
  }
})

const mockCreateOneTimePaymentSession = jest.fn()

jest.mock('@/lib/stripe', () => ({
  createOneTimePaymentSession: (...args: unknown[]) => mockCreateOneTimePaymentSession(...args),
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

import { POST } from '../route'

describe('POST /api/tip/checkout', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: true, error: null })
    process.env.STRIPE_TIP_CHECKOUT_ENABLED = 'true'
    delete process.env.VERCEL_ENV
  })

  afterAll(() => {
    delete process.env.STRIPE_TIP_CHECKOUT_ENABLED
    delete process.env.VERCEL_ENV
  })

  it.each([
    ['unset without deployment metadata', undefined, undefined],
    ['false in Preview', 'false', 'preview'],
    ['non-exact uppercase value in Production', 'TRUE', 'production'],
  ])('fails closed before auth and payment work when the gate is %s', async (_, value, env) => {
    if (env !== undefined) process.env.VERCEL_ENV = env
    else delete process.env.VERCEL_ENV
    if (value !== undefined) process.env.STRIPE_TIP_CHECKOUT_ENABLED = value
    else delete process.env.STRIPE_TIP_CHECKOUT_ENABLED

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
  })

  it('delegates only when the server gate is exactly true', async () => {
    process.env.STRIPE_TIP_CHECKOUT_ENABLED = 'true'
    const request = requestWith({ post_id: 'invalid' })

    const response = await POST(request as never)

    expect(response.status).toBe(400)
    expect(mockAuthenticatedPost).toHaveBeenCalledWith(request)
  })

  it('fails closed before reading or charging for an unreadable post', async () => {
    mockRpc.mockResolvedValue({ data: false, error: null })

    const response = await POST(
      requestWith({
        post_id: '20000000-0000-4000-8000-000000000002',
        amount_cents: 500,
      }) as never
    )

    expect(response.status).toBe(404)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockCreateOneTimePaymentSession).not.toHaveBeenCalled()
  })

  it('rejects fractional cents before the audience lookup', async () => {
    const response = await POST(
      requestWith({
        post_id: '20000000-0000-4000-8000-000000000002',
        amount_cents: 100.5,
      }) as never
    )

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('creates a checkout only for a current readable post and active recipient', async () => {
    const tableResults: Record<string, Array<{ data: unknown; error: unknown }>> = {
      tips: [
        { data: null, error: null },
        { data: { id: 'tip-1' }, error: null },
        { data: null, error: null },
      ],
      posts: [
        {
          data: {
            id: '20000000-0000-4000-8000-000000000002',
            title: 'Readable post',
            author_id: '30000000-0000-4000-8000-000000000003',
            author_handle: 'creator',
          },
          error: null,
        },
      ],
      public_user_profiles: [{ data: { id: '30000000-0000-4000-8000-000000000003' }, error: null }],
      user_profiles: [{ data: { stripe_customer_id: 'cus_123' }, error: null }],
    }
    mockFrom.mockImplementation((table: string) => {
      const next = tableResults[table]?.shift()
      if (!next) throw new Error(`Unexpected table call: ${table}`)
      return makeQuery(next)
    })
    mockCreateOneTimePaymentSession.mockResolvedValue({
      id: 'cs_123',
      url: 'https://checkout.example/session',
    })

    const response = await POST(
      requestWith({
        post_id: '20000000-0000-4000-8000-000000000002',
        amount_cents: 500,
        message: '  <b>thanks</b>  ',
      }) as never
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ sessionId: 'cs_123', url: 'https://checkout.example/session' })
    expect(mockCreateOneTimePaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_123',
        userId: mockUser.id,
        discriminator: 'tip_20000000-0000-4000-8000-000000000002_500',
        cancelUrl:
          'https://arena.example/post/20000000-0000-4000-8000-000000000002?tip_canceled=true',
        metadata: expect.objectContaining({
          type: 'tip',
          tip_id: 'tip-1',
          to_user_id: '30000000-0000-4000-8000-000000000003',
          amount_cents: '500',
        }),
      })
    )
  })
})
