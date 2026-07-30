/** @jest-environment node */

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private body: unknown

    constructor(body: unknown, init: ResponseInit = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn(() => {
  throw new Error('POST API key creation must not use a table read-then-insert')
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: { json: () => Promise<unknown> }) =>
    handler({
      user: { id: 'user-paid' },
      request,
      supabase: { rpc: mockRpc, from: mockFrom },
    }),
}))

import { POST } from '../route'

function request(body: unknown) {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as never
}

describe('POST /api/user/api-keys', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => ({
      data: {
        id: '10000000-0000-4000-8000-000000000001',
        name: args.p_name,
        key: args.p_key,
        tier: 'pro',
        daily_limit: 0,
        created_at: '2026-07-29T00:00:00.000Z',
      },
      error: null,
    }))
  })

  it('creates through the profile-locked entitlement authority', async () => {
    const response = await POST(request({ name: '  Production  ' }))
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.data).toEqual(
      expect.objectContaining({
        tier: 'pro',
        daily_limit: 0,
      })
    )
    expect(mockRpc).toHaveBeenCalledWith('create_user_api_key_with_current_entitlement', {
      p_user_id: 'user-paid',
      p_key: expect.stringMatching(/^arena_sk_[0-9a-f]{32}$/),
      p_name: 'Production',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('maps the database-serialized active-key limit to the existing 400 response', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'maximum 5 active API keys allowed',
      },
    })

    const response = await POST(request({ name: 'Sixth' }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Maximum 5 active keys allowed',
    })
  })

  it('preserves the collision response without falling back to a direct insert', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    })

    const response = await POST(request({}))

    expect(response.status).toBe(409)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { key: 'arena_sk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    { tier: 'starter', daily_limit: 0 },
    { id: 'not-a-uuid' },
    { unexpected: true },
  ])('fails closed on a malformed creation acknowledgement: %p', async (override) => {
    mockRpc.mockImplementationOnce(async (_name: string, args: Record<string, unknown>) => ({
      data: {
        id: '10000000-0000-4000-8000-000000000001',
        name: args.p_name,
        key: args.p_key,
        tier: 'pro',
        daily_limit: 0,
        created_at: '2026-07-29T00:00:00.000Z',
        ...override,
      },
      error: null,
    }))

    const response = await POST(request({ name: 'Production' }))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to acknowledge API key creation',
    })
  })
})
