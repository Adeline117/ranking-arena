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
  throw new Error('group comment delete route must not access tables directly')
})
const mockAdmin = { rpc: mockRpc, from: mockFrom }
const mockGetSupabaseAdmin = jest.fn(() => mockAdmin)

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: (context: { user: { id: string } }) => unknown) => async () =>
    handler({ user: { id: '10000000-0000-4000-8000-000000000001' } }),
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
const COMMENT_ID = '30000000-0000-4000-8000-000000000003'
const POST_ID = '40000000-0000-4000-8000-000000000004'
const AUDIT_ID = '50000000-0000-4000-8000-000000000005'
const OTHER_ID = '60000000-0000-4000-8000-000000000006'

function request() {
  return {}
}

function context(groupId = GROUP_ID, commentId = COMMENT_ID) {
  return { params: Promise.resolve({ id: groupId, commentId }) }
}

function successAcknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    actor_id: ACTOR_ID,
    affected_count: 2,
    audit_id: AUDIT_ID,
    comment_count: 4,
    comment_id: COMMENT_ID,
    group_id: GROUP_ID,
    post_id: POST_ID,
    ...overrides,
  }
}

describe('POST group comment delete atomic route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('hard-deletes through exactly one service-only RPC and no table access', async () => {
    mockRpc.mockResolvedValue({ data: successAcknowledgement(), error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      affected_count: 2,
      comment_count: 4,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('moderate_group_comment_atomic', {
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
      p_comment_id: COMMENT_ID,
      p_reason: 'Deleted by group administrator',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('normalizes uppercase request and acknowledgement IDs', async () => {
    mockRpc.mockResolvedValue({
      data: successAcknowledgement({
        group_id: GROUP_ID.toUpperCase(),
        comment_id: COMMENT_ID.toUpperCase(),
        post_id: POST_ID.toUpperCase(),
        audit_id: AUDIT_ID.toUpperCase(),
      }),
      error: null,
    })

    const response = await POST(
      request() as never,
      context(GROUP_ID.toUpperCase(), COMMENT_ID.toUpperCase())
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'moderate_group_comment_atomic',
      expect.objectContaining({ p_group_id: GROUP_ID, p_comment_id: COMMENT_ID })
    )
  })

  it.each([
    ['group ID', context('not-a-uuid', COMMENT_ID)],
    ['comment ID', context(GROUP_ID, 'not-a-uuid')],
  ])('rejects an invalid %s before obtaining service authority', async (_label, routeContext) => {
    const response = await POST(request() as never, routeContext)

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID', 400],
    ['ACTOR_UNAVAILABLE', 403],
    ['GROUP_NOT_FOUND', 404],
    ['GROUP_DISSOLVED', 409],
    ['PERMISSION_DENIED', 403],
    ['COMMENT_NOT_FOUND', 404],
    ['POST_NOT_FOUND', 404],
    ['COMMENT_NOT_IN_GROUP', 400],
  ])('maps exact atomic denial %s to HTTP %i', async (reason, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(expectedStatus)
    expect(mockRpc).toHaveBeenCalledTimes(1)
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
  ])('maps database error %s to HTTP %i', async (code, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'failed' } })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(expectedStatus)
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
    ['bad comment ID', successAcknowledgement({ comment_id: 'bad' })],
    ['bad group ID', successAcknowledgement({ group_id: 'bad' })],
    ['bad post ID', successAcknowledgement({ post_id: 'bad' })],
    ['negative affected count', successAcknowledgement({ affected_count: -1 })],
    ['fractional affected count', successAcknowledgement({ affected_count: 1.5 })],
    ['negative comment count', successAcknowledgement({ comment_count: -1 })],
    ['string comment count', successAcknowledgement({ comment_count: '4' })],
  ])('fails closed on malformed acknowledgement: %s', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['actor', { actor_id: OTHER_ID }],
    ['group', { group_id: OTHER_ID }],
    ['comment', { comment_id: OTHER_ID }],
  ])(
    'fails closed when the acknowledgement contradicts the requested %s',
    async (_label, override) => {
      mockRpc.mockResolvedValue({ data: successAcknowledgement(override), error: null })

      const response = await POST(request() as never, context())

      expect(response.status).toBe(500)
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )
})
