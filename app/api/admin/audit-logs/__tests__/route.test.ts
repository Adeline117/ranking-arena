jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private readonly headerValues = new Map<string, string>()
    headers = {
      set: jest.fn((name: string, value: string) => this.headerValues.set(name, value)),
      get: jest.fn((name: string) => this.headerValues.get(name) ?? null),
    }

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      for (const [name, value] of Object.entries(init.headers ?? {})) {
        this.headerValues.set(name, value)
      }
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockFrom = jest.fn()
const mockSupabase = { from: mockFrom }

jest.mock('@/lib/api/with-admin-auth', () => ({
  withAdminAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) =>
    async (request: unknown) => {
      const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      try {
        return await handler({
          admin: { id: 'admin-id', email: 'admin@example.test' },
          supabase: mockSupabase,
          request,
        })
      } catch (error) {
        return NextResponse.json(
          { success: false, error: 'Database error' },
          { status: (error as { statusCode?: number }).statusCode ?? 500 }
        )
      }
    },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { GET } from '../route'

function request(query = 'page=1&limit=20') {
  return {
    url: `http://localhost/api/admin/audit-logs?${query}`,
    method: 'GET',
  } as never
}

function rangedQuery(result: { data: unknown; count?: number | null; error: unknown }) {
  const chain: Record<string, jest.Mock> = {}
  chain.select = jest.fn(() => chain)
  chain.eq = jest.fn(() => chain)
  chain.gte = jest.fn(() => chain)
  chain.lte = jest.fn(() => chain)
  chain.order = jest.fn(() => chain)
  chain.range = jest.fn().mockResolvedValue({
    ...result,
    count: Object.prototype.hasOwnProperty.call(result, 'count')
      ? result.count
      : Array.isArray(result.data)
        ? result.data.length
        : 0,
  })
  return chain
}

function inQuery(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> = {}
  chain.select = jest.fn(() => chain)
  chain.in = jest.fn().mockResolvedValue(result)
  return chain
}

describe('GET /api/admin/audit-logs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('builds one stable global page across both audit sources without skipping entries', async () => {
    const adminRows = [
      {
        id: 'admin-03',
        admin_id: 'actor-admin-1',
        action: 'ban_user',
        target_type: 'user',
        target_id: 'user-1',
        details: { reason: 'spam' },
        created_at: '2026-08-17T10:00:00.000Z',
      },
      {
        id: 'admin-02',
        admin_id: 'actor-admin-2',
        action: 'issue_warning',
        target_type: 'user',
        target_id: 'user-2',
        details: { reason: 'abuse' },
        created_at: '2026-08-17T08:00:00.000Z',
      },
      {
        id: 'admin-01',
        admin_id: 'actor-admin-3',
        action: 'dismiss_report',
        target_type: 'post',
        target_id: 'post-1',
        details: null,
        created_at: '2026-08-17T06:00:00.000Z',
      },
    ]
    const groupRows = [
      {
        id: 'group-03',
        group_id: 'group-1',
        actor_id: 'actor-group-1',
        action: 'kick',
        target_id: 'member-1',
        details: { reason: 'raid' },
        created_at: '2026-08-17T09:00:00.000Z',
      },
      {
        id: 'group-02',
        group_id: 'group-2',
        actor_id: 'actor-group-2',
        action: 'mute',
        target_id: 'member-2',
        details: { seconds: 30 },
        created_at: '2026-08-17T07:00:00.000Z',
      },
      {
        id: 'group-01',
        group_id: 'group-3',
        actor_id: 'actor-group-3',
        action: 'ban',
        target_id: 'member-3',
        details: { reason: 'repeat abuse' },
        created_at: '2026-08-17T05:00:00.000Z',
      },
    ]
    const adminQueryPage1 = rangedQuery({ data: adminRows, count: 3, error: null })
    const groupQueryPage1 = rangedQuery({ data: groupRows, count: 3, error: null })
    const actorsPage1 = inQuery({
      data: [
        { id: 'actor-admin-1', handle: 'admin-one' },
        { id: 'actor-group-1', handle: 'group-one' },
      ],
      error: null,
    })
    const groupsPage1 = inQuery({
      data: [{ id: 'group-1', name: 'Alpha' }],
      error: null,
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'admin_logs') return adminQueryPage1
      if (table === 'group_audit_log') return groupQueryPage1
      if (table === 'user_profiles') return actorsPage1
      if (table === 'groups') return groupsPage1
      throw new Error(`Unexpected table: ${table}`)
    })

    const page1Response = await GET(request('page=1&limit=2'))
    const page1Body = await page1Response.json()

    expect(page1Response.status).toBe(200)
    expect(adminQueryPage1.range).toHaveBeenCalledWith(0, 1)
    expect(groupQueryPage1.range).toHaveBeenCalledWith(0, 1)
    expect(page1Body.data.total).toBe(6)
    expect(
      page1Body.data.logs.map((log: { source: string; id: string }) => `${log.source}:${log.id}`)
    ).toEqual(['admin:admin-03', 'group:group-03'])
    expect(page1Response.headers.get('Cache-Control')).toBe('private, no-store')

    const adminQueryPage2 = rangedQuery({ data: adminRows, count: 3, error: null })
    const groupQueryPage2 = rangedQuery({ data: groupRows, count: 3, error: null })
    const actorsPage2 = inQuery({
      data: [
        { id: 'actor-admin-2', handle: 'admin-two' },
        { id: 'actor-group-2', handle: 'group-two' },
      ],
      error: null,
    })
    const groupsPage2 = inQuery({
      data: [{ id: 'group-2', name: 'Beta' }],
      error: null,
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'admin_logs') return adminQueryPage2
      if (table === 'group_audit_log') return groupQueryPage2
      if (table === 'user_profiles') return actorsPage2
      if (table === 'groups') return groupsPage2
      throw new Error(`Unexpected table: ${table}`)
    })

    const page2Response = await GET(request('page=2&limit=2'))
    const page2Body = await page2Response.json()

    expect(page2Response.status).toBe(200)
    expect(adminQueryPage2.range).toHaveBeenCalledWith(0, 3)
    expect(groupQueryPage2.range).toHaveBeenCalledWith(0, 3)
    expect(
      page2Body.data.logs.map((log: { source: string; id: string }) => `${log.source}:${log.id}`)
    ).toEqual(['admin:admin-02', 'group:group-02'])
  })

  it('uses created_at then source and id as a deterministic tie-break for equal timestamps', async () => {
    const sharedTimestamp = '2026-08-17T10:00:00.000Z'
    const adminQuery = rangedQuery({
      data: [
        {
          id: 'admin-01',
          admin_id: 'actor-admin-1',
          action: 'issue_warning',
          target_type: 'user',
          target_id: 'user-1',
          details: null,
          created_at: sharedTimestamp,
        },
        {
          id: 'admin-02',
          admin_id: 'actor-admin-2',
          action: 'ban_user',
          target_type: 'user',
          target_id: 'user-2',
          details: null,
          created_at: sharedTimestamp,
        },
      ],
      count: 2,
      error: null,
    })
    const groupQuery = rangedQuery({
      data: [
        {
          id: 'group-01',
          group_id: 'group-1',
          actor_id: 'actor-group-1',
          action: 'mute',
          target_id: 'member-1',
          details: null,
          created_at: sharedTimestamp,
        },
        {
          id: 'group-02',
          group_id: 'group-2',
          actor_id: 'actor-group-2',
          action: 'kick',
          target_id: 'member-2',
          details: null,
          created_at: sharedTimestamp,
        },
      ],
      count: 2,
      error: null,
    })
    const actors = inQuery({
      data: [
        { id: 'actor-admin-2', handle: 'admin-two' },
        { id: 'actor-admin-1', handle: 'admin-one' },
        { id: 'actor-group-2', handle: 'group-two' },
        { id: 'actor-group-1', handle: 'group-one' },
      ],
      error: null,
    })
    const groups = inQuery({
      data: [
        { id: 'group-2', name: 'Beta' },
        { id: 'group-1', name: 'Alpha' },
      ],
      error: null,
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'admin_logs') return adminQuery
      if (table === 'group_audit_log') return groupQuery
      if (table === 'user_profiles') return actors
      if (table === 'groups') return groups
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await GET(request('page=1&limit=10'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(adminQuery.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false })
    expect(adminQuery.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false })
    expect(groupQuery.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false })
    expect(groupQuery.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false })
    expect(
      body.data.logs.map((log: { source: string; id: string }) => `${log.source}:${log.id}`)
    ).toEqual(['admin:admin-02', 'admin:admin-01', 'group:group-02', 'group:group-01'])
  })

  it('rejects pages whose prefix fetch would exceed the hard cap before querying Supabase', async () => {
    const response = await GET(request('page=101&limit=100'))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.success).toBe(false)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed when either audit source query errors', async () => {
    const adminQuery = rangedQuery({
      data: null,
      count: null,
      error: { message: 'admin_logs unavailable' },
    })
    const groupQuery = rangedQuery({
      data: [
        {
          id: 'group-01',
          group_id: 'group-1',
          actor_id: 'actor-group-1',
          action: 'kick',
          target_id: 'member-1',
          details: null,
          created_at: '2026-08-17T10:00:00.000Z',
        },
      ],
      count: 1,
      error: null,
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'admin_logs') return adminQuery
      if (table === 'group_audit_log') return groupQuery
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await GET(request('page=1&limit=20'))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.success).toBe(false)
    expect(mockFrom).not.toHaveBeenCalledWith('user_profiles')
    expect(mockFrom).not.toHaveBeenCalledWith('groups')
  })
})
