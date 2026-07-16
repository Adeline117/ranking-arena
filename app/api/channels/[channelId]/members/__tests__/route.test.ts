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
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

import { DELETE, PATCH, POST } from '../route'

type QueryResult = { data?: unknown; error?: unknown; count?: number | null }

function queuedClient(results: QueryResult[]) {
  const queries: Array<{
    table: string
    selects: unknown[][]
    equals: Array<[string, unknown]>
    inCalls: Array<[string, readonly unknown[]]>
    inserts: unknown[]
    updates: unknown[]
    deletes: number
    upserts: unknown[]
  }> = []
  let resultIndex = 0
  mockFrom.mockImplementation((table: string) => {
    const result = results[resultIndex++]
    if (!result) throw new Error(`Unexpected query for ${table}`)
    const calls = {
      table,
      selects: [] as unknown[][],
      equals: [] as Array<[string, unknown]>,
      inCalls: [] as Array<[string, readonly unknown[]]>,
      inserts: [] as unknown[],
      updates: [] as unknown[],
      deletes: 0,
      upserts: [] as unknown[],
    }
    queries.push(calls)
    const query = {
      select: (...args: unknown[]) => {
        calls.selects.push(args)
        return query
      },
      eq: (column: string, value: unknown) => {
        calls.equals.push([column, value])
        return query
      },
      in: (column: string, values: readonly unknown[]) => {
        calls.inCalls.push([column, [...values]])
        return query
      },
      insert: (value: unknown) => {
        calls.inserts.push(value)
        return query
      },
      update: (value: unknown) => {
        calls.updates.push(value)
        return query
      },
      delete: () => {
        calls.deletes += 1
        return query
      },
      upsert: (value: unknown) => {
        calls.upserts.push(value)
        return query
      },
      maybeSingle: () => Promise.resolve(result),
      then: (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    }
    return query
  })
  return queries
}

const actorId = '11111111-1111-4111-8111-111111111111'
const channelId = '22222222-2222-4222-8222-222222222222'
const existingAdminId = '33333333-3333-4333-8333-333333333333'
const newMemberId = '44444444-4444-4444-8444-444444444444'

function fullRoster(size: number) {
  return [
    { user_id: actorId, role: 'owner' },
    ...Array.from({ length: size - 1 }, (_, index) => ({
      user_id: `${(index + 10).toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`,
      role: 'member',
    })),
  ]
}

function request(body: unknown, malformed = false) {
  return {
    json: jest.fn(
      malformed ? () => Promise.reject(new Error('invalid json')) : () => Promise.resolve(body)
    ),
  }
}

function context(id = channelId) {
  return { params: Promise.resolve({ channelId: id }) }
}

describe('channel member write boundaries', () => {
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
    ['bad-channel', { userIds: [newMemberId] }],
    [channelId, { userIds: [] }],
    [channelId, { userIds: ['not-a-uuid'] }],
    [channelId, { userIds: [newMemberId], role: 'owner' }],
  ])('rejects malformed add-member authority before database access %#', async (id, body) => {
    const response = await POST(request(body) as never, context(id))

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockFilterChannelAddableUsers).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before database access', async () => {
    const response = await POST(request({}, true) as never, context())

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed when actor membership cannot be verified', async () => {
    queuedClient([
      { data: null, error: { code: 'XX001' } },
      { data: { type: 'group' }, error: null },
    ])

    const response = await POST(request({ userIds: [newMemberId] }) as never, context())

    expect(response.status).toBe(500)
    expect(mockFilterChannelAddableUsers).not.toHaveBeenCalled()
  })

  it('does not run group member writes against a direct-message channel', async () => {
    queuedClient([
      { data: { role: 'owner' }, error: null },
      { data: { type: 'direct' }, error: null },
    ])

    const response = await POST(request({ userIds: [newMemberId] }) as never, context())

    expect(response.status).toBe(400)
    expect(mockFilterChannelAddableUsers).not.toHaveBeenCalled()
  })

  it('rejects the entire addition when any candidate privacy check denies it', async () => {
    queuedClient([
      { data: { role: 'owner' }, error: null },
      { data: { type: 'group' }, error: null },
      { data: null, error: null, count: 1 },
      { data: [{ user_id: actorId, role: 'owner' }], error: null },
    ])
    mockFilterChannelAddableUsers.mockResolvedValue({
      allowed: [newMemberId],
      blocked: [existingAdminId],
    })

    const response = await POST(
      request({ userIds: [newMemberId, existingAdminId] }) as never,
      context()
    )

    expect(response.status).toBe(400)
    expect(mockFrom).toHaveBeenCalledTimes(4)
  })

  it('inserts only new members and never demotes an existing admin through upsert', async () => {
    const queries = queuedClient([
      { data: { role: 'owner' }, error: null },
      { data: { type: 'group' }, error: null },
      { data: null, error: null, count: 2 },
      {
        data: [
          { user_id: actorId, role: 'owner' },
          { user_id: existingAdminId, role: 'admin' },
        ],
        error: null,
      },
      { data: null, error: null },
    ])

    const response = await POST(
      request({ userIds: [existingAdminId, newMemberId] }) as never,
      context()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, added: 1 })
    expect(queries[4].inserts).toEqual([
      [{ channel_id: channelId, user_id: newMemberId, role: 'member' }],
    ])
    expect(mockFilterChannelAddableUsers).toHaveBeenCalledWith(
      { from: mockFrom },
      actorId,
      [newMemberId],
      [actorId, existingAdminId]
    )
    expect(queries.every(({ upserts }) => upserts.length === 0)).toBe(true)
  })

  it.each([
    [
      [
        { data: { role: 'owner' }, error: null },
        { data: { type: 'group' }, error: null },
        { data: null, error: { code: 'XX001' }, count: null },
        { data: [{ user_id: actorId, role: 'owner' }], error: null },
      ],
      500,
    ],
    [
      [
        { data: { role: 'owner' }, error: null },
        { data: { type: 'group' }, error: null },
        { data: null, error: null, count: null },
        { data: [{ user_id: actorId, role: 'owner' }], error: null },
      ],
      500,
    ],
    [
      [
        { data: { role: 'owner' }, error: null },
        { data: { type: 'group' }, error: null },
        { data: null, error: null, count: 50 },
        { data: fullRoster(50), error: null },
      ],
      400,
    ],
  ])(
    'does not write when the exact capacity proof is unavailable or full %#',
    async (results, status) => {
      const queries = queuedClient(results)

      const response = await POST(request({ userIds: [newMemberId] }) as never, context())

      expect(response.status).toBe(status)
      expect(queries.every(({ inserts }) => inserts.length === 0)).toBe(true)
    }
  )

  it('does not rewrite an already-present member', async () => {
    const queries = queuedClient([
      { data: { role: 'owner' }, error: null },
      { data: { type: 'group' }, error: null },
      { data: null, error: null, count: 2 },
      {
        data: [
          { user_id: actorId, role: 'owner' },
          { user_id: existingAdminId, role: 'admin' },
        ],
        error: null,
      },
    ])

    const response = await POST(request({ userIds: [existingAdminId] }) as never, context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, added: 0 })
    expect(queries.every(({ inserts, updates }) => inserts.length + updates.length === 0)).toBe(
      true
    )
    expect(mockFilterChannelAddableUsers).not.toHaveBeenCalled()
  })

  it('prevents the owner from demoting themselves', async () => {
    const queries = queuedClient([
      { data: { type: 'group' }, error: null },
      { data: { role: 'owner' }, error: null },
      { data: { role: 'owner' }, error: null },
    ])

    const response = await PATCH(request({ userId: actorId, role: 'member' }) as never, context())

    expect(response.status).toBe(400)
    expect(queries.every(({ updates }) => updates.length === 0)).toBe(true)
  })

  it('fails role changes closed and distinguishes a missing target', async () => {
    const failedQueries = queuedClient([
      { data: { type: 'group' }, error: null },
      { data: { role: 'owner' }, error: null },
      { data: { role: 'member' }, error: null },
      { data: null, error: { code: 'XX001' } },
    ])
    const failed = await PATCH(request({ userId: newMemberId, role: 'admin' }) as never, context())
    expect(failed.status).toBe(500)
    expect(failedQueries[3].updates).toEqual([{ role: 'admin' }])

    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: actorId })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    queuedClient([
      { data: { type: 'group' }, error: null },
      { data: { role: 'owner' }, error: null },
      { data: null, error: null },
    ])
    const missingResponse = await PATCH(
      request({ userId: newMemberId, role: 'admin' }) as never,
      context()
    )
    expect(missingResponse.status).toBe(404)
  })

  it('fails member removal closed when authorization or deletion fails', async () => {
    queuedClient([
      { data: { type: 'group' }, error: null },
      { data: null, error: { code: 'XX001' } },
      { data: { role: 'member' }, error: null },
    ])
    const authorizationFailure = await DELETE(request({ userId: newMemberId }) as never, context())
    expect(authorizationFailure.status).toBe(500)

    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: actorId })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    queuedClient([
      { data: { type: 'group' }, error: null },
      { data: { role: 'member' }, error: null },
      { data: null, error: { code: 'XX001' } },
    ])
    const leaveFailure = await DELETE(request({ userId: actorId }) as never, context())
    expect(leaveFailure.status).toBe(500)
  })
})
