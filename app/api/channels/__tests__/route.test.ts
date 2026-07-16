jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private readonly body: unknown
    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
    async json() {
      return this.body
    }
  }
  return { NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockFrom = jest.fn()
const mockFilterChannelAddableUsers = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))
jest.mock('@/lib/data/channel-permissions', () => ({
  filterChannelAddableUsers: (...args: unknown[]) => mockFilterChannelAddableUsers(...args),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: jest.fn(),
    info: jest.fn(),
  }),
}))

import { POST } from '../route'

type QueryResult = { data?: unknown; error?: { message?: string; code?: string } | null }

function queuedClient(results: QueryResult[]) {
  const queries: Array<{
    table: string
    inserts: unknown[]
    deletes: number
    equals: Array<[string, unknown]>
    selects: unknown[][]
  }> = []
  let resultIndex = 0
  mockFrom.mockImplementation((table: string) => {
    const result = results[resultIndex++]
    if (!result) throw new Error(`Unexpected query for ${table}`)
    const calls = {
      table,
      inserts: [] as unknown[],
      deletes: 0,
      equals: [] as Array<[string, unknown]>,
      selects: [] as unknown[][],
    }
    queries.push(calls)
    const query = {
      insert: (value: unknown) => {
        calls.inserts.push(value)
        return query
      },
      delete: () => {
        calls.deletes += 1
        return query
      },
      eq: (column: string, value: unknown) => {
        calls.equals.push([column, value])
        return query
      },
      select: (...args: unknown[]) => {
        calls.selects.push(args)
        return query
      },
      single: () => Promise.resolve(result),
      then: (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    }
    return query
  })
  return queries
}

const actorId = '11111111-1111-4111-8111-111111111111'
const memberId = '22222222-2222-4222-8222-222222222222'
const blockedId = '33333333-3333-4333-8333-333333333333'
const channelId = '44444444-4444-4444-8444-444444444444'

function request(body: unknown, malformed = false) {
  return {
    json: jest.fn(
      malformed ? () => Promise.reject(new Error('invalid json')) : () => Promise.resolve(body)
    ),
  }
}

describe('POST /api/channels', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: actorId })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    mockFilterChannelAddableUsers.mockImplementation(
      async (_client: unknown, _actor: string, candidates: string[]) => ({
        allowed: candidates,
        blocked: [],
      })
    )
  })

  it.each([
    [{ name: '', memberIds: [memberId] }],
    [{ name: 'Group', memberIds: [] }],
    [{ name: 'Group', memberIds: ['not-a-uuid'] }],
    [{ name: 'Group', memberIds: [memberId], created_by: actorId }],
    [
      {
        name: 'Group',
        memberIds: Array.from(
          { length: 50 },
          (_, index) => `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`
        ),
      },
    ],
  ])('rejects invalid or authority-bearing input before database writes %#', async (body) => {
    const response = await POST(request(body) as never)

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockFilterChannelAddableUsers).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before database writes', async () => {
    const response = await POST(request({}, true) as never)

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects the entire creation when any selected member is unavailable', async () => {
    mockFilterChannelAddableUsers.mockResolvedValue({
      allowed: [memberId],
      blocked: [blockedId],
    })

    const response = await POST(
      request({ name: 'Private group', memberIds: [memberId, blockedId] }) as never
    )

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('normalizes and deduplicates members before inserting one owner roster', async () => {
    const channel = {
      id: channelId,
      name: 'Safe group',
      type: 'group',
      created_by: actorId,
    }
    const queries = queuedClient([
      { data: channel, error: null },
      { data: null, error: null },
    ])

    const response = await POST(
      request({
        name: '  Safe group  ',
        description: '  reviewed  ',
        memberIds: [actorId, memberId.toUpperCase(), memberId],
      }) as never
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ channel })
    expect(mockFilterChannelAddableUsers).toHaveBeenCalledWith({ from: mockFrom }, actorId, [
      memberId,
    ])
    expect(queries[0].inserts).toEqual([
      { name: 'Safe group', type: 'group', created_by: actorId, description: 'reviewed' },
    ])
    expect(queries[1].inserts).toEqual([
      [
        { channel_id: channelId, user_id: actorId, role: 'owner' },
        { channel_id: channelId, user_id: memberId, role: 'member' },
      ],
    ])
  })

  it('does not create a channel when the privacy lookup fails', async () => {
    mockFilterChannelAddableUsers.mockRejectedValue(new Error('privacy unavailable'))

    const response = await POST(request({ name: 'Group', memberIds: [memberId] }) as never)

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('cleans up a channel when its complete owner roster cannot be inserted', async () => {
    const queries = queuedClient([
      { data: { id: channelId }, error: null },
      { data: null, error: { code: 'XX001', message: 'insert failed' } },
      { data: null, error: null },
    ])

    const response = await POST(request({ name: 'Group', memberIds: [memberId] }) as never)

    expect(response.status).toBe(500)
    expect(queries[2]).toMatchObject({
      table: 'chat_channels',
      deletes: 1,
      equals: [['id', channelId]],
    })
  })

  it('reports cleanup failure without treating a partial roster as success', async () => {
    queuedClient([
      { data: { id: channelId }, error: null },
      { data: null, error: { code: 'XX001', message: 'insert failed' } },
      { data: null, error: { code: 'XX002', message: 'cleanup failed' } },
    ])

    const response = await POST(request({ name: 'Group', memberIds: [memberId] }) as never)

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Failed to clean up channel after member insert failure',
      expect.objectContaining({ channelId, error: 'cleanup failed' })
    )
  })
})
