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
const mockRpc = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
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
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom, rpc: mockRpc })
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
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before database access', async () => {
    const response = await POST(request({}, true) as never, context())

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when the atomic RPC fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await POST(request({ userIds: [newMemberId] }) as never, context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('passes only normalized distinct non-actor candidates to the atomic RPC', async () => {
    mockRpc.mockResolvedValue({
      data: { success: true, channel_id: channelId, added: 2 },
      error: null,
    })

    const response = await POST(
      request({ userIds: [actorId, existingAdminId, newMemberId, existingAdminId] }) as never,
      context()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, added: 2 })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('add_channel_members_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
      p_candidate_ids: [existingAdminId, newMemberId],
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['CHANNEL_NOT_FOUND', 404],
    ['CHANNEL_NOT_GROUP', 400],
    ['PERMISSION_DENIED', 403],
    ['CAPACITY_EXCEEDED', 400],
    ['CANDIDATE_UNAVAILABLE', 400],
    ['PRIVACY_DENIED', 400],
  ])('maps the exact atomic denial %s without a fallback write', async (reason, status) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await POST(request({ userIds: [newMemberId] }) as never, context())

    expect(response.status).toBe(status)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    { success: true, channel_id: channelId, added: 1, extra: true },
    { success: true, channel_id: 'not-a-uuid', added: 1 },
    { success: true, channel_id: channelId, added: -1 },
    { success: true, channel_id: channelId, added: 1.5 },
    { success: false, reason: 'UNKNOWN' },
    { success: false, reason: 'PRIVACY_DENIED', extra: true },
  ])('fails closed on a malformed atomic acknowledgement %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request({ userIds: [newMemberId] }) as never, context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { success: true, channel_id: existingAdminId, added: 1 },
    { success: true, channel_id: channelId, added: 2 },
  ])('rejects a valid-shaped acknowledgement that does not match the request %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request({ userIds: [newMemberId] }) as never, context())

    expect(response.status).toBe(500)
  })

  it('accepts an exact idempotent acknowledgement without a client-side rewrite', async () => {
    mockRpc.mockResolvedValue({
      data: { success: true, channel_id: channelId, added: 0 },
      error: null,
    })

    const response = await POST(request({ userIds: [existingAdminId] }) as never, context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, added: 0 })
    expect(mockFrom).not.toHaveBeenCalled()
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
