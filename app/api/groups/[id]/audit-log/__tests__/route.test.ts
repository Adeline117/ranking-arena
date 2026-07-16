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
const mockFrom = jest.fn()
let mockViewer: { id: string } | null = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        request: { url: string }
        supabase: { from: typeof mockFrom }
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
      return handler({ user: mockViewer, request, supabase: { from: mockFrom } })
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
const LOG_ID_1 = '30000000-0000-4000-8000-000000000003'
const LOG_ID_2 = '40000000-0000-4000-8000-000000000004'
const LOG_ID_3 = '50000000-0000-4000-8000-000000000005'
const TARGET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function singletonQuery(data: unknown, error: unknown = null) {
  const chain = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error }),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  return chain
}

function pageQuery(data: unknown, error: unknown = null) {
  const chain = {
    select: jest.fn(),
    eq: jest.fn(),
    not: jest.fn(),
    order: jest.fn(),
    or: jest.fn(),
    limit: jest.fn().mockResolvedValue({ data, error }),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  chain.not.mockReturnValue(chain)
  chain.order.mockReturnValue(chain)
  chain.or.mockReturnValue(chain)
  return chain
}

function activeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: VIEWER_ID,
    deleted_at: null,
    banned_at: null,
    is_banned: false,
    ban_expires_at: null,
    ...overrides,
  }
}

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

function request(suffix = '', groupId = GROUP_ID) {
  return { url: `http://localhost/api/groups/${groupId}/audit-log${suffix}` }
}

let profileQuery: ReturnType<typeof singletonQuery>
let groupQuery: ReturnType<typeof singletonQuery>
let membershipQuery: ReturnType<typeof singletonQuery>
let auditQuery: ReturnType<typeof pageQuery>

beforeEach(() => {
  jest.clearAllMocks()
  mockViewer = { id: VIEWER_ID }
  profileQuery = singletonQuery(activeProfile())
  groupQuery = singletonQuery({ id: GROUP_ID, dissolved_at: null })
  membershipQuery = singletonQuery({ role: 'owner' })
  auditQuery = pageQuery([])
  mockFrom.mockImplementation((table: string) => {
    switch (table) {
      case 'user_profiles':
        return profileQuery
      case 'groups':
        return groupQuery
      case 'group_members':
        return membershipQuery
      case 'group_audit_log':
        return auditQuery
      default:
        throw new Error(`Unexpected table: ${table}`)
    }
  })
})

describe('group audit-log read boundary', () => {
  it('returns only the explicit activity allowlist to an owner', async () => {
    auditQuery.limit.mockResolvedValue({
      data: [
        logRow(LOG_ID_1, '2026-07-16T20:00:00.000Z'),
        logRow(LOG_ID_2, '2026-07-16T19:00:00.000Z', {
          action: 'invite_created',
          actor_id: null,
          target_id: null,
        }),
      ],
      error: null,
    })

    const response = await GET(request() as never)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      success: true,
      logs: [
        {
          id: LOG_ID_1,
          action: 'member_kicked',
          actor_id: VIEWER_ID,
          target_id: TARGET_ID,
          created_at: '2026-07-16T20:00:00.000Z',
        },
        {
          id: LOG_ID_2,
          action: 'invite_created',
          actor_id: null,
          target_id: null,
          created_at: '2026-07-16T19:00:00.000Z',
        },
      ],
      pagination: { limit: 50, has_more: false, next_cursor: null },
    })
    expect(profileQuery.eq).toHaveBeenCalledWith('id', VIEWER_ID)
    expect(groupQuery.eq).toHaveBeenCalledWith('id', GROUP_ID)
    expect(membershipQuery.eq).toHaveBeenCalledWith('group_id', GROUP_ID)
    expect(membershipQuery.eq).toHaveBeenCalledWith('user_id', VIEWER_ID)
    expect(auditQuery.select).toHaveBeenCalledWith('id, action, actor_id, target_id, created_at')
    expect(auditQuery.eq).toHaveBeenCalledWith('group_id', GROUP_ID)
    expect(auditQuery.limit).toHaveBeenCalledWith(51)
  })

  it('rejects unauthenticated and inactive application accounts before audit access', async () => {
    mockViewer = null
    expect((await GET(request() as never)).status).toBe(401)
    expect(mockFrom).not.toHaveBeenCalled()

    mockViewer = { id: VIEWER_ID }
    for (const profile of [
      null,
      activeProfile({ deleted_at: '2026-07-16T01:00:00.000Z' }),
      activeProfile({ banned_at: '2026-07-16T01:00:00.000Z' }),
      activeProfile({ is_banned: true, ban_expires_at: null }),
      activeProfile({ is_banned: true, ban_expires_at: '2999-01-01T00:00:00.000Z' }),
    ]) {
      profileQuery.maybeSingle.mockResolvedValueOnce({ data: profile, error: null })
      expect((await GET(request() as never)).status).toBe(403)
    }
    expect(groupQuery.maybeSingle).not.toHaveBeenCalled()
    expect(auditQuery.limit).not.toHaveBeenCalled()
  })

  it('allows an expired temporary-ban flag under the existing account semantics', async () => {
    profileQuery.maybeSingle.mockResolvedValue({
      data: activeProfile({
        is_banned: true,
        ban_expires_at: '2020-01-01T00:00:00.000Z',
      }),
      error: null,
    })

    expect((await GET(request() as never)).status).toBe(200)
    expect(auditQuery.limit).toHaveBeenCalledTimes(1)
  })

  it('rejects ordinary members and cross-group membership', async () => {
    membershipQuery.maybeSingle.mockResolvedValueOnce({ data: { role: 'member' }, error: null })
    expect((await GET(request() as never)).status).toBe(403)

    groupQuery.maybeSingle.mockResolvedValueOnce({
      data: { id: OTHER_GROUP_ID, dissolved_at: null },
      error: null,
    })
    membershipQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null })
    expect((await GET(request('', OTHER_GROUP_ID) as never)).status).toBe(403)

    expect(membershipQuery.eq).toHaveBeenCalledWith('group_id', OTHER_GROUP_ID)
    expect(membershipQuery.eq).toHaveBeenCalledWith('user_id', VIEWER_ID)
    expect(auditQuery.limit).not.toHaveBeenCalled()
  })

  it('distinguishes missing and dissolved groups without reading the log', async () => {
    groupQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null })
    expect((await GET(request() as never)).status).toBe(404)

    groupQuery.maybeSingle.mockResolvedValueOnce({
      data: { id: GROUP_ID, dissolved_at: '2026-07-16T02:00:00.000Z' },
      error: null,
    })
    expect((await GET(request() as never)).status).toBe(409)
    expect(membershipQuery.maybeSingle).not.toHaveBeenCalled()
    expect(auditQuery.limit).not.toHaveBeenCalled()
  })

  it('uses a bounded, stable created_at/id keyset cursor', async () => {
    const rows = [
      logRow(LOG_ID_1, '2026-07-16T20:00:00.000Z'),
      logRow(LOG_ID_2, '2026-07-16T19:00:00.000Z'),
      logRow(LOG_ID_3, '2026-07-16T18:00:00.000Z'),
    ]
    auditQuery.limit.mockResolvedValue({ data: rows, error: null })

    const first = await GET(request('?limit=2') as never)
    const firstBody = await first.json()
    expect(firstBody.logs).toHaveLength(2)
    expect(firstBody.pagination).toEqual({
      limit: 2,
      has_more: true,
      next_cursor: expect.any(String),
    })
    expect(auditQuery.limit).toHaveBeenCalledWith(3)

    const cursor = firstBody.pagination.next_cursor as string
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
      created_at: '2026-07-16T19:00:00.000Z',
      id: LOG_ID_2,
    })

    await GET(request(`?limit=2&cursor=${encodeURIComponent(cursor)}`) as never)
    expect(auditQuery.or).toHaveBeenLastCalledWith(
      `created_at.lt.2026-07-16T19:00:00.000Z,and(created_at.eq.2026-07-16T19:00:00.000Z,id.lt.${LOG_ID_2})`
    )
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
        JSON.stringify({
          created_at: '2026-07-16T20:00:00.000Z',
          id: LOG_ID_1,
          group_id: OTHER_GROUP_ID,
        }),
        'utf8'
      ).toString('base64url')}`,
      GROUP_ID,
    ],
  ])('rejects malformed or ambiguous input before data access', async (suffix, groupId) => {
    expect((await GET(request(suffix, groupId) as never)).status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed on profile, group, membership, and audit query errors', async () => {
    profileQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: { code: 'XX001' } })
    expect((await GET(request() as never)).status).toBe(500)

    groupQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: { code: 'XX002' } })
    expect((await GET(request() as never)).status).toBe(500)

    membershipQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: { code: 'XX003' } })
    expect((await GET(request() as never)).status).toBe(500)

    auditQuery.limit.mockResolvedValueOnce({ data: null, error: { code: 'XX004' } })
    expect((await GET(request() as never)).status).toBe(500)
    expect(mockLogError).toHaveBeenCalled()
  })

  it('fails closed if a database response escapes the exact allowlist', async () => {
    auditQuery.limit.mockResolvedValue({
      data: [
        logRow(LOG_ID_1, '2026-07-16T20:00:00.000Z', {
          details: { operation_id: 'internal' },
        }),
      ],
      error: null,
    })

    const response = await GET(request() as never)
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to load group audit log' })
  })

  it('keeps the route read-only and excludes raw details and redundant group IDs', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/groups/[id]/audit-log/route.ts'),
      'utf8'
    )
    expect(source).toContain(".select('id, action, actor_id, target_id, created_at')")
    expect(source).not.toContain(".select('*')")
    expect(source).not.toContain(".from('notifications')")
    expect(source).not.toContain('.insert(')
    expect(source).not.toContain('.update(')
    expect(source).not.toContain('.delete(')
  })
})
