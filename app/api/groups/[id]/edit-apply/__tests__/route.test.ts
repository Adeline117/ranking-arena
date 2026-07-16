import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    private readonly rawBody: string

    constructor(url: string, init: { method?: string; body?: string } = {}) {
      this.url = url
      this.method = init.method ?? 'POST'
      this.rawBody = init.body ?? ''
    }

    async json() {
      if (!this.rawBody) throw new Error('missing body')
      return JSON.parse(this.rawBody)
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
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { GET, POST } from '../route'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_ID = '22222222-2222-4222-8222-222222222222'
const APPLICATION_ID = '33333333-3333-4333-8333-333333333333'
const OPERATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CREATED_AT = '2026-07-16T17:00:00.000Z'

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: OPERATION_ID,
    name: 'Atomic Group',
    name_en: 'Atomic Group',
    description: 'Description',
    description_en: null,
    avatar_url: 'https://example.com/avatar.png',
    role_names: {
      admin: { zh: '管理员', en: 'Admin' },
      member: { zh: '成员', en: 'Member' },
    },
    rules_json: [{ zh: '友善', en: 'Be kind' }],
    rules: 'Be kind',
    is_premium_only: false,
    ...overrides,
  }
}

function application(overrides: Record<string, unknown> = {}) {
  const input = validBody()
  return {
    id: APPLICATION_ID,
    group_id: GROUP_ID,
    applicant_id: ACTOR_ID,
    name: input.name,
    name_en: input.name_en,
    description: input.description,
    description_en: input.description_en,
    avatar_url: input.avatar_url,
    role_names: input.role_names,
    rules_json: input.rules_json,
    rules: input.rules,
    is_premium_only: input.is_premium_only,
    status: 'pending',
    created_at: CREATED_AT,
    ...overrides,
  }
}

function request(body: unknown = validBody(), groupId = GROUP_ID): NextRequest {
  return new NextRequest(`http://localhost/api/groups/${groupId}/edit-apply`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function rawRequest(rawBody: string, groupId = GROUP_ID): NextRequest {
  return new NextRequest(`http://localhost/api/groups/${groupId}/edit-apply`, {
    method: 'POST',
    body: rawBody,
  })
}

describe('POST /api/groups/[id]/edit-apply atomic boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({
      data: {
        status: 'submitted',
        operation_id: OPERATION_ID,
        application: application(),
        applied: true,
      },
      error: null,
    })
  })

  it('submits through one actor/group/operation-bound RPC with normalized input', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'submitted',
        operation_id: OPERATION_ID,
        application: application({
          name: 'Café',
          name_en: 'Atomic Group',
          description: 'Description',
        }),
        applied: true,
      },
      error: null,
    })
    const response = await POST(
      request(
        validBody({
          operation_id: OPERATION_ID.toUpperCase(),
          name: '  Cafe\u0301  ',
          name_en: '  Atomic Group  ',
          description: '  Description  ',
          role_names: {
            admin: { zh: ' 管理员 ', en: ' Admin ' },
            member: { zh: ' 成员 ', en: ' Member ' },
          },
          rules_json: [{ zh: ' 友善 ', en: ' Be kind ' }],
          rules: ' Be kind ',
        })
      )
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('submit_group_edit_application_atomic', {
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
      p_name: 'Café',
      p_name_en: 'Atomic Group',
      p_description: 'Description',
      p_description_en: null,
      p_avatar_url: 'https://example.com/avatar.png',
      p_role_names: {
        admin: { zh: '管理员', en: 'Admin' },
        member: { zh: '成员', en: 'Member' },
      },
      p_rules_json: [{ zh: '友善', en: 'Be kind' }],
      p_rules: 'Be kind',
      p_is_premium_only: false,
      p_operation_id: OPERATION_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns the exact same public acknowledgement for fresh apply and durable replay', async () => {
    const success = {
      status: 'submitted',
      operation_id: OPERATION_ID,
      application: application(),
    }
    mockRpc
      .mockResolvedValueOnce({ data: { ...success, applied: true }, error: null })
      .mockResolvedValueOnce({ data: { ...success, applied: false }, error: null })

    const fresh = await POST(request())
    const replay = await POST(request())

    expect(fresh.status).toBe(200)
    expect(replay.status).toBe(200)
    const expected = {
      success: true,
      message: 'Edit application submitted, pending admin review',
      operation_id: OPERATION_ID,
      application: application(),
    }
    await expect(fresh.json()).resolves.toEqual(expected)
    await expect(replay.json()).resolves.toEqual(expected)
    expect((await fresh.json()) as Record<string, unknown>).not.toHaveProperty('applied')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid', 400],
    ['account_inactive', 403],
    ['not_found', 404],
    ['dissolved', 403],
    ['forbidden', 403],
    ['premium_change_unsupported', 409],
    ['name_taken', 409],
    ['pending_exists', 409],
    ['operation_conflict', 409],
  ])('maps canonical %s without any compensating table write', async (status, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })

    const response = await POST(request())

    expect(response.status).toBe(expectedStatus)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { data: null, error: { code: 'XX000' } },
    { data: null, error: null },
    { data: { status: 'submitted' }, error: null },
    {
      data: {
        status: 'submitted',
        operation_id: OPERATION_ID,
        application: application(),
        applied: true,
        attacker_field: true,
      },
      error: null,
    },
    {
      data: {
        status: 'submitted',
        operation_id: '55555555-5555-4555-8555-555555555555',
        application: application(),
        applied: true,
      },
      error: null,
    },
    {
      data: {
        status: 'submitted',
        operation_id: OPERATION_ID,
        application: application({ group_id: '55555555-5555-4555-8555-555555555555' }),
        applied: true,
      },
      error: null,
    },
    {
      data: {
        status: 'submitted',
        operation_id: OPERATION_ID,
        application: application({ applicant_id: '55555555-5555-4555-8555-555555555555' }),
        applied: true,
      },
      error: null,
    },
    {
      data: {
        status: 'submitted',
        operation_id: OPERATION_ID,
        application: application({ name: 'Wrong group name' }),
        applied: true,
      },
      error: null,
    },
  ])('fails closed for RPC failure, malformed, or mismatched evidence %#', async (rpcResult) => {
    mockRpc.mockResolvedValue(rpcResult)

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects malformed paths, JSON, incomplete bodies, and authority keys before RPC', async () => {
    const { description: _description, ...incomplete } = validBody()
    const responses = await Promise.all([
      POST(request(validBody(), 'not-a-uuid')),
      POST(rawRequest('{')),
      POST(request(incomplete)),
      POST(request(validBody({ actor_id: ACTOR_ID }))),
      POST(request(validBody({ avatar_url: '/relative.png' }))),
      POST(request(validBody({ name: '😀'.repeat(51) }))),
    ])

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400])
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps the POST write boundary RPC-only', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/groups/[id]/edit-apply/route.ts'),
      'utf8'
    )
    const postSource = source.split('// 获取小组的修改申请列表')[0]
    expect(postSource).toContain("'submit_group_edit_application_atomic'")
    expect(postSource).not.toContain(".from('group_edit_applications')")
    expect(postSource).not.toContain('.insert(')
    expect(postSource).not.toContain('.update(')
    expect(postSource).not.toContain('.delete(')
  })
})

describe('GET /api/groups/[id]/edit-apply owner read', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('validates the group path before reading', async () => {
    const response = await GET(request({}, 'not-a-uuid'))

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('preserves the owner-gated read path', async () => {
    const memberQuery = {
      select: jest.fn(),
      eq: jest.fn(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { role: 'owner' }, error: null }),
    }
    memberQuery.select.mockReturnValue(memberQuery)
    memberQuery.eq.mockReturnValue(memberQuery)
    const applicationQuery = {
      select: jest.fn(),
      eq: jest.fn(),
      order: jest.fn().mockResolvedValue({ data: [application()], error: null }),
    }
    applicationQuery.select.mockReturnValue(applicationQuery)
    applicationQuery.eq.mockReturnValue(applicationQuery)
    mockFrom.mockImplementation((table: string) =>
      table === 'group_members' ? memberQuery : applicationQuery
    )

    const response = await GET(request({}))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ applications: [application()] })
    expect(mockFrom).toHaveBeenCalledWith('group_members')
    expect(mockFrom).toHaveBeenCalledWith('group_edit_applications')
    expect(applicationQuery.eq).toHaveBeenCalledWith('group_id', GROUP_ID)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
