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
  return { NextResponse: MockNextResponse }
})

const mockLogError = jest.fn()
const mockRpc = jest.fn()
const mockFrom = jest.fn()
let mockViewer: { id: string } | null = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        request: { url: string }
        supabase: { rpc: typeof mockRpc; from: typeof mockFrom }
      }) => unknown
    ) =>
    async (request: { url: string }) => {
      if (!mockViewer) {
        return {
          status: 401,
          headers: new Headers(),
          json: async () => ({ success: false, error: 'Unauthorized' }),
        }
      }
      return handler({
        user: mockViewer,
        request,
        supabase: { rpc: mockRpc, from: mockFrom },
      })
    },
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockLogError(...args) }),
}))

import { GET } from '../route'

const VIEWER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GROUP_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_GROUP_ID = '20000000-0000-4000-8000-000000000002'
const LOG_ID_1 = '50000000-0000-4000-8000-000000000005'
const LOG_ID_2 = '40000000-0000-4000-8000-000000000004'
const LOG_ID_3 = '30000000-0000-4000-8000-000000000003'
const TARGET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function logRow(id: string, createdAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    action: 'member_kicked',
    actor_id: VIEWER_ID,
    target_id: TARGET_ID,
    created_at: createdAt,
    ...overrides,
  }
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    actor_id: VIEWER_ID,
    group_id: GROUP_ID,
    logs: [],
    has_more: false,
    ...overrides,
  }
}

function request(suffix = '', groupId = GROUP_ID) {
  return { url: `http://localhost/api/groups/${groupId}/audit-log${suffix}` }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockViewer = { id: VIEWER_ID }
  mockRpc.mockResolvedValue({ data: successResult(), error: null })
})

describe('group audit-log atomic read boundary', () => {
  it('returns only the explicit allowlist through one actor/group-bound RPC', async () => {
    const logs = [
      logRow(LOG_ID_1, '2026-07-16T20:00:00.000Z'),
      logRow(LOG_ID_2, '2026-07-16T19:00:00.000Z', {
        action: 'invite_created',
        actor_id: null,
        target_id: null,
      }),
    ]
    mockRpc.mockResolvedValue({ data: successResult({ logs }), error: null })

    const response = await GET(request() as never)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      success: true,
      logs,
      pagination: { limit: 50, has_more: false, next_cursor: null },
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('get_group_audit_log_page_atomic', {
      p_actor_id: VIEWER_ID,
      p_group_id: GROUP_ID,
      p_before_created_at: null,
      p_before_id: null,
      p_limit: 50,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('uses a bounded stable created_at/id keyset cursor', async () => {
    const firstLogs = [
      logRow(LOG_ID_1, '2026-07-16T20:00:00.000Z'),
      logRow(LOG_ID_2, '2026-07-16T19:00:00.000Z'),
    ]
    mockRpc.mockResolvedValueOnce({
      data: successResult({ logs: firstLogs, has_more: true }),
      error: null,
    })

    const first = await GET(request('?limit=2') as never)
    const firstBody = await first.json()
    expect(firstBody.pagination).toEqual({
      limit: 2,
      has_more: true,
      next_cursor: expect.any(String),
    })
    const cursor = firstBody.pagination.next_cursor as string
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
      created_at: '2026-07-16T19:00:00.000Z',
      id: LOG_ID_2,
    })

    mockRpc.mockResolvedValueOnce({
      data: successResult({ logs: [logRow(LOG_ID_3, '2026-07-16T18:00:00.000Z')] }),
      error: null,
    })
    const second = await GET(request(`?limit=2&cursor=${encodeURIComponent(cursor)}`) as never)

    expect(second.status).toBe(200)
    expect(mockRpc).toHaveBeenLastCalledWith('get_group_audit_log_page_atomic', {
      p_actor_id: VIEWER_ID,
      p_group_id: GROUP_ID,
      p_before_created_at: '2026-07-16T19:00:00.000Z',
      p_before_id: LOG_ID_2,
      p_limit: 2,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('preserves PostgreSQL microsecond ordering instead of truncating to milliseconds', async () => {
    mockRpc.mockResolvedValue({
      data: successResult({
        logs: [
          logRow(LOG_ID_3, '2026-07-16T20:00:00.000002Z'),
          logRow(LOG_ID_1, '2026-07-16T20:00:00.000001Z'),
        ],
      }),
      error: null,
    })

    const response = await GET(request() as never)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['INVALID', 400, 'Invalid audit log request'],
    ['ACTOR_UNAVAILABLE', 403, 'Permission denied'],
    ['PERMISSION_DENIED', 403, 'Permission denied'],
    ['GROUP_NOT_FOUND', 404, 'Group not found'],
    ['GROUP_DISSOLVED', 409, 'This group has been dissolved'],
  ])('maps canonical %s without any follow-up table read', async (reason, status, error) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await GET(request() as never)

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated and malformed actor identities before RPC', async () => {
    mockViewer = null
    expect((await GET(request() as never)).status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()

    mockViewer = { id: 'not-a-uuid' }
    expect((await GET(request() as never)).status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'not-a-uuid'],
    ['?limit=0', GROUP_ID],
    ['?limit=101', GROUP_ID],
    ['?limit=01', GROUP_ID],
    ['?limit=1.5', GROUP_ID],
    ['?limit=2&limit=3', GROUP_ID],
    ['?offset=1', GROUP_ID],
    ['?cursor=not_base64!', GROUP_ID],
    [
      `?cursor=${Buffer.from(JSON.stringify({ created_at: 'bad', id: LOG_ID_1 }), 'utf8').toString(
        'base64url'
      )}`,
      GROUP_ID,
    ],
    [
      `?cursor=${Buffer.from(
        JSON.stringify({ created_at: '2026-07-16T20:00:00.1234567Z', id: LOG_ID_1 }),
        'utf8'
      ).toString('base64url')}`,
      GROUP_ID,
    ],
    [
      `?cursor=${Buffer.from(
        JSON.stringify({
          created_at: '2026-07-16T20:00:00.000Z',
          id: LOG_ID_1,
          group_id: OTHER_GROUP_ID,
        }),
        'utf8'
      ).toString('base64url')}`,
      GROUP_ID,
    ],
  ])('rejects malformed or ambiguous input before RPC', async (suffix, groupId) => {
    expect((await GET(request(suffix, groupId) as never)).status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { data: null, error: { code: 'XX001' } },
    { data: null, error: null },
    { data: { success: true }, error: null },
    { data: { success: false, reason: 'UNKNOWN' }, error: null },
    { data: { success: false, reason: 'PERMISSION_DENIED', leaked: true }, error: null },
    {
      data: successResult({ group_id: OTHER_GROUP_ID }),
      error: null,
    },
    {
      data: successResult({ actor_id: TARGET_ID }),
      error: null,
    },
    {
      data: successResult({
        logs: [
          logRow(LOG_ID_2, '2026-07-16T19:00:00.000Z'),
          logRow(LOG_ID_1, '2026-07-16T20:00:00.000Z'),
        ],
      }),
      error: null,
    },
    {
      data: successResult({
        logs: [
          logRow(LOG_ID_1, '2026-07-16T20:00:00.000Z'),
          logRow(LOG_ID_1, '2026-07-16T20:00:00.000Z'),
        ],
      }),
      error: null,
    },
    {
      data: successResult({
        logs: [logRow(LOG_ID_1, '2026-07-16T20:00:00.000Z', { details: { secret: true } })],
      }),
      error: null,
    },
    {
      data: successResult({ logs: [], has_more: true }),
      error: null,
    },
  ])('fails closed for RPC failure, malformed, or mismatched evidence %#', async (rpcResult) => {
    mockRpc.mockResolvedValue(rpcResult)

    const response = await GET(request() as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to load group audit log' })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects rows outside the requested cursor boundary', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ created_at: '2026-07-16T19:00:00.000Z', id: LOG_ID_2 }),
      'utf8'
    ).toString('base64url')
    mockRpc.mockResolvedValue({
      data: successResult({ logs: [logRow(LOG_ID_1, '2026-07-16T20:00:00.000Z')] }),
      error: null,
    })

    const response = await GET(request(`?cursor=${cursor}`) as never)

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps the active route RPC-only and excludes raw audit details', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/groups/[id]/audit-log/route.ts'),
      'utf8'
    )
    expect(source).toContain(".rpc('get_group_audit_log_page_atomic'")
    expect(source).not.toContain(".from('")
    expect(source).not.toContain("'details'")
    expect(source).not.toContain('.insert(')
    expect(source).not.toContain('.update(')
    expect(source).not.toContain('.delete(')
  })
})
