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

const mockRpc = jest.fn()
const mockFrom = jest.fn(() => {
  throw new Error('group post delete route must not access tables directly')
})
const mockAdmin = { rpc: mockRpc, from: mockFrom }
const mockGetSupabaseAdmin = jest.fn(() => mockAdmin)
const mockSendNotification = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: (context: { user: { id: string } }) => unknown) => async () =>
    handler({ user: { id: '10000000-0000-4000-8000-000000000001' } }),
}))
jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

import { POST } from '../route'

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const GROUP_ID = '20000000-0000-4000-8000-000000000002'
const POST_ID = '30000000-0000-4000-8000-000000000003'
const AUTHOR_ID = '40000000-0000-4000-8000-000000000004'
const AUDIT_ID = '50000000-0000-4000-8000-000000000005'
const OTHER_ID = '60000000-0000-4000-8000-000000000006'
const DELETED_AT = '2026-07-29T22:05:00.000Z'

function request() {
  return {}
}

function context(groupId = GROUP_ID, postId = POST_ID) {
  return { params: Promise.resolve({ id: groupId, postId }) }
}

function successAcknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    actor_id: ACTOR_ID,
    audit_id: AUDIT_ID,
    author_id: AUTHOR_ID,
    deleted_at: DELETED_AT,
    group_id: GROUP_ID,
    post_id: POST_ID,
    title: 'Unsafe post',
    ...overrides,
  }
}

describe('POST group post delete atomic route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('soft-deletes through one service RPC and notifies from committed DB identity', async () => {
    mockRpc.mockResolvedValue({ data: successAcknowledgement(), error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('moderate_group_post_atomic', {
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
      p_post_id: POST_ID,
      p_reason: 'Deleted by admin',
    })
    expect(mockSendNotification).toHaveBeenCalledWith(
      mockAdmin,
      {
        user_id: AUTHOR_ID,
        type: 'system',
        title: 'Post deleted',
        message: 'Your post "Unsafe post" was deleted by group admin',
        link: `/groups/${GROUP_ID}`,
        actor_id: ACTOR_ID,
        reference_id: POST_ID,
      },
      'group-post-delete'
    )
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendNotification.mock.invocationCallOrder[0]
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['the actor authored the post', ACTOR_ID],
    ['the author account is absent', null],
  ])('does not notify when %s', async (_label, authorId) => {
    mockRpc.mockResolvedValue({
      data: successAcknowledgement({ author_id: authorId }),
      error: null,
    })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('normalizes uppercase request and acknowledgement IDs', async () => {
    mockRpc.mockResolvedValue({
      data: successAcknowledgement({
        actor_id: ACTOR_ID.toUpperCase(),
        audit_id: AUDIT_ID.toUpperCase(),
        author_id: AUTHOR_ID.toUpperCase(),
        group_id: GROUP_ID.toUpperCase(),
        post_id: POST_ID.toUpperCase(),
      }),
      error: null,
    })

    const response = await POST(
      request() as never,
      context(GROUP_ID.toUpperCase(), POST_ID.toUpperCase())
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'moderate_group_post_atomic',
      expect.objectContaining({ p_group_id: GROUP_ID, p_post_id: POST_ID })
    )
    expect(mockSendNotification).toHaveBeenCalledWith(
      mockAdmin,
      expect.objectContaining({ user_id: AUTHOR_ID, reference_id: POST_ID }),
      'group-post-delete'
    )
  })

  it.each([
    ['group ID', context('not-a-uuid', POST_ID)],
    ['post ID', context(GROUP_ID, 'not-a-uuid')],
  ])('rejects an invalid %s before obtaining service authority', async (_label, routeContext) => {
    const response = await POST(request() as never, routeContext)

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID', 400],
    ['ACTOR_UNAVAILABLE', 403],
    ['GROUP_NOT_FOUND', 404],
    ['GROUP_DISSOLVED', 409],
    ['PERMISSION_DENIED', 403],
    ['POST_NOT_FOUND', 404],
    ['POST_NOT_IN_GROUP', 400],
    ['POST_ALREADY_DELETED', 400],
  ])('maps exact atomic denial %s to HTTP %i without notifying', async (reason, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(expectedStatus)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['22023', 400],
    ['42501', 403],
    ['P0002', 404],
    ['23503', 404],
    ['40001', 409],
    ['40P01', 409],
    ['55P03', 409],
    ['XX001', 500],
  ])('maps database error %s to HTTP %i without notifying', async (code, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'failed' } })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(expectedStatus)
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['array', []],
    ['scalar', 'success'],
    ['unknown denial', { success: false, reason: 'SOMETHING_ELSE' }],
    ['denial with extra field', { success: false, reason: 'INVALID', extra: true }],
    ['missing success', { reason: 'INVALID' }],
    ['success with extra field', successAcknowledgement({ extra: true })],
    ['bad actor ID', successAcknowledgement({ actor_id: 'bad' })],
    ['bad audit ID', successAcknowledgement({ audit_id: 'bad' })],
    ['bad author ID', successAcknowledgement({ author_id: 'bad' })],
    ['bad deletion timestamp', successAcknowledgement({ deleted_at: 'not-a-date' })],
    ['bad group ID', successAcknowledgement({ group_id: 'bad' })],
    ['bad post ID', successAcknowledgement({ post_id: 'bad' })],
    ['numeric title', successAcknowledgement({ title: 7 })],
    ['missing title', { ...successAcknowledgement(), title: undefined }],
  ])('fails closed on malformed acknowledgement: %s', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(500)
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['actor', { actor_id: OTHER_ID }],
    ['group', { group_id: OTHER_ID }],
    ['post', { post_id: OTHER_ID }],
  ])(
    'fails closed when the acknowledgement contradicts the requested %s',
    async (_label, override) => {
      mockRpc.mockResolvedValue({ data: successAcknowledgement(override), error: null })

      const response = await POST(request() as never, context())

      expect(response.status).toBe(500)
      expect(mockSendNotification).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )
})
