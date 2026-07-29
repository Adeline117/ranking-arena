import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
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

function listedApplication(overrides: Record<string, unknown> = {}) {
  return {
    ...application(),
    reject_reason: null,
    reviewed_at: null,
    ...overrides,
  }
}

function listSuccess(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    actor_id: ACTOR_ID,
    group_id: GROUP_ID,
    applications: [],
    has_more: false,
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

function getRequest(suffix = '', groupId = GROUP_ID): NextRequest {
  return new NextRequest(`http://localhost/api/groups/${groupId}/edit-apply${suffix}`, {
    method: 'GET',
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

  it('rejects NUL/lone surrogates before RPC while accepting 50 astral code points', async () => {
    const fiftyEmoji = '😀'.repeat(50)
    mockRpc.mockResolvedValue({
      data: {
        status: 'submitted',
        operation_id: OPERATION_ID,
        application: application({ name: fiftyEmoji }),
        applied: true,
      },
      error: null,
    })

    const accepted = await POST(request(validBody({ name: fiftyEmoji })))
    const rejected = await Promise.all([
      POST(request(validBody({ name: 'nul\u0000byte' }))),
      POST(request(validBody({ description: '\ud800' }))),
      POST(request(validBody({ rules_json: [{ zh: 'valid', en: '\udc00' }] }))),
    ])

    expect(accepted.status).toBe(200)
    expect(rejected.map((response) => response.status)).toEqual([400, 400, 400])
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith(
      'submit_group_edit_application_atomic',
      expect.objectContaining({ p_name: fiftyEmoji })
    )
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

describe('GET /api/groups/[id]/edit-apply atomic owner read', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: listSuccess(), error: null })
  })

  it('validates the group path before RPC', async () => {
    const response = await GET(getRequest('', 'not-a-uuid'))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns an owner-authorized page through one actor/group-bound RPC', async () => {
    const applications = [listedApplication()]
    mockRpc.mockResolvedValue({ data: listSuccess({ applications }), error: null })

    const response = await GET(getRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      applications,
      pagination: { limit: 50, has_more: false, next_cursor: null },
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('get_group_edit_applications_page_atomic', {
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
      p_before_created_at: null,
      p_before_id: null,
      p_limit: 50,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('uses a stable bounded created_at/id cursor', async () => {
    const olderId = '22222222-3333-4333-8333-333333333333'
    const applications = [
      listedApplication({ id: APPLICATION_ID, created_at: '2026-07-16T20:00:00.000002Z' }),
      listedApplication({ id: olderId, created_at: '2026-07-16T19:00:00.000001Z' }),
    ]
    mockRpc.mockResolvedValueOnce({
      data: listSuccess({ applications, has_more: true }),
      error: null,
    })

    const first = await GET(getRequest('?limit=2'))
    const firstBody = await first.json()
    expect(first.status).toBe(200)
    const cursor = firstBody.pagination.next_cursor as string
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
      created_at: '2026-07-16T19:00:00.000001Z',
      id: olderId,
    })

    mockRpc.mockResolvedValueOnce({ data: listSuccess(), error: null })
    expect((await GET(getRequest(`?limit=2&cursor=${cursor}`))).status).toBe(200)
    expect(mockRpc).toHaveBeenLastCalledWith('get_group_edit_applications_page_atomic', {
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
      p_before_created_at: '2026-07-16T19:00:00.000001Z',
      p_before_id: olderId,
      p_limit: 2,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID', 400, 'Invalid edit application request'],
    ['ACTOR_UNAVAILABLE', 403, 'Permission denied'],
    ['PERMISSION_DENIED', 403, 'Permission denied'],
    ['GROUP_NOT_FOUND', 404, 'Group not found'],
    ['GROUP_DISSOLVED', 409, 'The group has been dissolved'],
  ])('maps canonical %s without a follow-up table query', async (reason, status, error) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await GET(getRequest())

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=01',
    '?limit=2&limit=3',
    '?offset=1',
    '?cursor=not_base64!',
    `?cursor=${Buffer.from(
      JSON.stringify({ created_at: '2026-07-16T20:00:00.1234567Z', id: APPLICATION_ID }),
      'utf8'
    ).toString('base64url')}`,
  ])('rejects malformed or ambiguous list input before RPC: %s', async (suffix) => {
    const response = await GET(getRequest(suffix))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { data: null, error: { code: 'XX001' } },
    { data: null, error: null },
    { data: { success: true }, error: null },
    { data: { success: false, reason: 'UNKNOWN' }, error: null },
    { data: { success: false, reason: 'PERMISSION_DENIED', leaked: true }, error: null },
    { data: listSuccess({ actor_id: APPLICATION_ID }), error: null },
    { data: listSuccess({ group_id: APPLICATION_ID }), error: null },
    {
      data: listSuccess({
        applications: [listedApplication({ group_id: APPLICATION_ID })],
      }),
      error: null,
    },
    {
      data: listSuccess({
        applications: [listedApplication(), listedApplication()],
      }),
      error: null,
    },
    {
      data: listSuccess({ applications: [], has_more: true }),
      error: null,
    },
    {
      data: listSuccess({
        applications: [listedApplication({ reviewed_by: ACTOR_ID })],
      }),
      error: null,
    },
  ])('fails closed for RPC failure, malformed, or mismatched evidence %#', async (rpcResult) => {
    mockRpc.mockResolvedValue(rpcResult)

    const response = await GET(getRequest())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Fetch failed' })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps the GET boundary RPC-only', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/groups/[id]/edit-apply/route.ts'),
      'utf8'
    )
    const getSource = source.split('// 获取小组的修改申请列表')[1]
    expect(getSource).toContain("'get_group_edit_applications_page_atomic'")
    expect(getSource).not.toContain(".from('")
    expect(getSource).not.toContain('.insert(')
    expect(getSource).not.toContain('.update(')
    expect(getSource).not.toContain('.delete(')
  })
})
