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
    private readonly body: unknown
    constructor(url: string, init: { method?: string; body?: string } = {}) {
      this.url = url
      this.method = init.method ?? 'POST'
      this.body = init.body === undefined ? undefined : JSON.parse(init.body)
    }
    async json() {
      if (this.body === undefined) throw new Error('missing body')
      return this.body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn()

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
  logger: { dbError: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import { GET, POST } from '../route'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const APPLICATION_ID = '22222222-2222-4222-8222-222222222222'
const CREATED_AT = '2026-07-15T22:49:00.000Z'

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/groups/apply', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: '  Atomic Group  ',
    name_en: ' Atomic Group ',
    description: ' description ',
    description_en: null,
    avatar_url: ' https://example.com/group.png ',
    role_names: {
      admin: { zh: '群主' },
      member: { en: 'Participant' },
    },
    rules_json: [{ zh: '友善', en: 'Be kind' }],
    rules: ' Be kind ',
    is_premium_only: true,
    ...overrides,
  }
}

describe('POST /api/groups/apply atomic boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({
      data: { status: 'submitted', application_id: APPLICATION_ID, created_at: CREATED_AT },
      error: null,
    })
  })

  it('submits through one actor-bound RPC with normalized input and no table write', async () => {
    const response = await POST(request(validBody()))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.application).toEqual(
      expect.objectContaining({
        id: APPLICATION_ID,
        applicant_id: ACTOR_ID,
        name: 'Atomic Group',
        status: 'pending',
        created_at: CREATED_AT,
      })
    )
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('submit_group_application_atomic', {
      p_actor_id: ACTOR_ID,
      p_name: 'Atomic Group',
      p_name_en: 'Atomic Group',
      p_description: 'description',
      p_description_en: null,
      p_avatar_url: 'https://example.com/group.png',
      p_role_names: {
        admin: { zh: '群主', en: 'Admin' },
        member: { zh: '成员', en: 'Participant' },
      },
      p_rules_json: [{ zh: '友善', en: 'Be kind' }],
      p_rules: 'Be kind',
      p_is_premium_only: true,
      p_promo_unlocked: PRO_FREE_PROMO,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    [{ name: '' }, 400],
    [{ name: 'x', actor_id: ACTOR_ID }, 400],
    [{ name: 'x', is_premium_only: 'yes' }, 400],
    [{ name: 'x', rules_json: [{ zh: '只有一种语言' }] }, 400],
  ])('rejects malformed or authority-bearing input %#', async (body, status) => {
    const response = await POST(request(body))

    expect(response.status).toBe(status)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['pending_exists', 409],
    ['name_taken', 409],
    ['pro_required', 403],
    ['account_inactive', 403],
    ['invalid', 400],
  ])('maps canonical %s without a compensating table write', async (status, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })

    const response = await POST(request(validBody()))

    expect(response.status).toBe(expectedStatus)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { data: null, error: { code: 'XX000' } },
    { data: null, error: null },
    { data: { status: 'submitted', application_id: APPLICATION_ID }, error: null },
    {
      data: {
        status: 'submitted',
        application_id: APPLICATION_ID,
        created_at: CREATED_AT,
        attacker_field: true,
      },
      error: null,
    },
  ])('fails closed for RPC failure or malformed output %#', async (rpcResult) => {
    mockRpc.mockResolvedValue(rpcResult)

    const response = await POST(request(validBody()))

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})

describe('GET /api/groups/apply private read boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses the server read path and returns only the applicant-safe allowlist', async () => {
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      order: jest.fn().mockResolvedValue({
        data: [
          {
            id: APPLICATION_ID,
            applicant_id: ACTOR_ID,
            name: 'Atomic Group',
            name_en: 'Internal extra field',
            status: 'rejected',
            reject_reason: 'canonical reason',
            group_id: null,
            reviewed_at: CREATED_AT,
            reviewed_by: '44444444-4444-4444-8444-444444444444',
            created_at: CREATED_AT,
          },
        ],
        error: null,
      }),
    }
    query.select.mockReturnValue(query)
    query.eq.mockReturnValue(query)
    mockFrom.mockReturnValue(query)

    const response = await GET(request({}))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      applications: [
        {
          id: APPLICATION_ID,
          name: 'Atomic Group',
          status: 'rejected',
          reject_reason: 'canonical reason',
          group_id: null,
          created_at: CREATED_AT,
        },
      ],
    })
    expect(query.select).toHaveBeenCalledWith(
      'id, name, status, reject_reason, group_id, created_at'
    )
    expect(query.eq).toHaveBeenCalledWith('applicant_id', ACTOR_ID)
  })
})
