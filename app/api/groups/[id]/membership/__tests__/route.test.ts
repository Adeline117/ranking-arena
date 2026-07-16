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

  return { NextResponse: MockNextResponse }
})

const mockFrom = jest.fn()
const mockMemberInsert = jest.fn()
const mockMemberDelete = jest.fn()
const mockSendNotification = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        supabase: { from: typeof mockFrom }
        request: unknown
      }) => unknown
    ) =>
    async (request: unknown) => {
      try {
        return await handler({
          user: { id: 'viewer-1' },
          supabase: { from: (...args: unknown[]) => mockFrom(...args) },
          request,
        })
      } catch {
        return {
          status: 500,
          _body: { error: 'Internal server error' },
          async json() {
            return this._body
          },
          headers: new Map(),
        }
      }
    },
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { POST } from '../route'

type DbError = { code: string; message: string }
type DbResult = { data: unknown; error: DbError | null }

const DB_ERROR: DbError = { code: 'XX001', message: 'database failed' }
const GROUP_ID = 'group-1'

let tableQueues: Record<string, unknown[]>

function queueTable(table: string, ...queries: unknown[]) {
  tableQueues[table] = queries
}

function rowQuery(data: unknown, error: DbError | null = null) {
  const result = { data, error }
  const chain: Record<string, jest.Mock> = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue(result),
    single: jest.fn().mockResolvedValue(result),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  return chain
}

function mutationQuery(operation: 'insert' | 'delete', operationSpy: jest.Mock, result: DbResult) {
  const chain: Record<string, jest.Mock> & {
    then?: (
      onFulfilled?: (value: DbResult) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => Promise<unknown>
  } = {
    eq: jest.fn(),
    select: jest.fn(),
  }
  chain.eq.mockReturnValue(chain)
  chain.select.mockReturnValue(chain)
  chain.then = (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected)
  operationSpy.mockReturnValue(chain)
  return { [operation]: operationSpy }
}

function group(overrides: Record<string, unknown> = {}) {
  return {
    id: GROUP_ID,
    created_by: 'group-owner',
    is_premium_only: false,
    min_arena_score: 0,
    is_verified_only: false,
    dissolved_at: null,
    ...overrides,
  }
}

function request(action: 'join' | 'leave') {
  return {
    url: `http://localhost/api/groups/${GROUP_ID}/membership`,
    json: jest.fn().mockResolvedValue({ action }),
  }
}

describe('POST group membership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    tableQueues = {}
    mockFrom.mockImplementation((table: string) => {
      const queue = tableQueues[table]
      if (!queue || queue.length === 0) throw new Error(`Unexpected table access: ${table}`)
      return queue.shift()
    })
  })

  it('returns 500 on a group lookup error and performs no later side effects', async () => {
    queueTable('groups', rowQuery(null, DB_ERROR))

    const response = await POST(request('join') as never)

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockMemberInsert).not.toHaveBeenCalled()
    expect(mockMemberDelete).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('returns 500 on a ban lookup error and does not insert or notify', async () => {
    queueTable('groups', rowQuery(group()))
    queueTable('group_bans', rowQuery(null, DB_ERROR))

    const response = await POST(request('join') as never)

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(2)
    expect(mockMemberInsert).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('returns 500 on an eligibility profile error and does not insert or notify', async () => {
    queueTable('groups', rowQuery(group({ min_arena_score: 10 })))
    queueTable('group_bans', rowQuery(null))
    queueTable('user_profiles', rowQuery(null, DB_ERROR))

    const response = await POST(request('join') as never)

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(3)
    expect(mockMemberInsert).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('returns 500 on an existing-membership lookup error and does not insert or notify', async () => {
    queueTable('groups', rowQuery(group()))
    queueTable('group_bans', rowQuery(null))
    queueTable('group_members', rowQuery(null, DB_ERROR))

    const response = await POST(request('join') as never)

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(3)
    expect(mockMemberInsert).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('joins successfully without a manual member-count mutation', async () => {
    queueTable('groups', rowQuery(group()))
    queueTable('group_bans', rowQuery(null))
    queueTable(
      'group_members',
      rowQuery(null),
      mutationQuery('insert', mockMemberInsert, { data: null, error: null })
    )

    const response = await POST(request('join') as never)

    expect(response.status).toBe(200)
    expect(mockMemberInsert).toHaveBeenCalledWith({
      group_id: GROUP_ID,
      user_id: 'viewer-1',
      role: 'member',
    })
    expect(mockSendNotification).toHaveBeenCalledTimes(1)
  })

  it('leaves successfully without a manual member-count mutation', async () => {
    queueTable('groups', rowQuery(group()))
    queueTable(
      'group_members',
      mutationQuery('delete', mockMemberDelete, {
        data: [{ user_id: 'viewer-1' }],
        error: null,
      })
    )

    const response = await POST(request('leave') as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, action: 'left' })
    expect(mockMemberDelete).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('returns 500 on a leave delete error and performs no notification', async () => {
    queueTable('groups', rowQuery(group()))
    queueTable(
      'group_members',
      mutationQuery('delete', mockMemberDelete, { data: null, error: DB_ERROR })
    )

    const response = await POST(request('leave') as never)

    expect(response.status).toBe(500)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})

describe('group membership count ownership', () => {
  it('keeps all join/leave/ban/kick routes free of manual count RPCs', () => {
    const routePaths = [
      'app/api/groups/[id]/membership/route.ts',
      'app/api/groups/[id]/members/[userId]/ban/route.ts',
      'app/api/groups/[id]/members/[userId]/kick/route.ts',
    ]

    for (const routePath of routePaths) {
      const source = readFileSync(join(process.cwd(), routePath), 'utf8')
      expect(source).not.toMatch(/\bupdateCount\b/)
      expect(source).not.toContain('increment_member_count')
    }
  })
})
