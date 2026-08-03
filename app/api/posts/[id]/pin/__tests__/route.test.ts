/** @jest-environment node */

const mockRpc = jest.fn()
const mockUser = { id: '11111111-1111-4111-8111-111111111111' }
const mockSupabase = { rpc: (...args: unknown[]) => mockRpc(...args) }

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: mockUser, supabase: mockSupabase, request }),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}))

import { POST } from '../route'

const POST_ID = '22222222-2222-4222-8222-222222222222'
const AUTHOR_ID = '33333333-3333-4333-8333-333333333333'
const GROUP_ID = '44444444-4444-4444-8444-444444444444'
const context = { params: Promise.resolve({ id: POST_ID }) }

function request(body: unknown = { is_pinned: true }) {
  return new Request(`https://www.arenafi.org/api/posts/${POST_ID}/pin`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function databaseAcknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    actor_id: mockUser.id,
    post_id: POST_ID,
    author_id: AUTHOR_ID,
    group_id: GROUP_ID,
    scope_type: 'group',
    scope_id: GROUP_ID,
    is_pinned: true,
    already_set: false,
    unpinned_count: 1,
    ...overrides,
  }
}

describe('POST /api/posts/[id]/pin atomic set state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('requires an exact explicit desired state before calling the database', async () => {
    const response = await POST(
      request({ is_pinned: true, unexpected: 'toggle' }) as Parameters<typeof POST>[0],
      context
    )

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('binds actor, URL post, and desired state to one atomic RPC and returns an exact ACK', async () => {
    mockRpc.mockResolvedValue({ data: databaseAcknowledgement(), error: null })

    const response = await POST(request() as Parameters<typeof POST>[0], context)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('set_post_pin_state_atomic', {
      p_actor_id: mockUser.id,
      p_post_id: POST_ID,
      p_is_pinned: true,
    })
    expect(await response.json()).toEqual({
      success: true,
      data: {
        post_id: POST_ID,
        author_id: AUTHOR_ID,
        group_id: GROUP_ID,
        scope_type: 'group',
        scope_id: GROUP_ID,
        is_pinned: true,
        already_set: false,
        unpinned_count: 1,
        message: 'Pinned',
      },
    })
  })

  it('preserves already_set so a retry cannot toggle the state back', async () => {
    mockRpc.mockResolvedValue({
      data: databaseAcknowledgement({ already_set: true, unpinned_count: 0 }),
      error: null,
    })

    const response = await POST(request() as Parameters<typeof POST>[0], context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({ is_pinned: true, already_set: true, unpinned_count: 0 })
  })

  it('fails closed on a contradictory or widened database acknowledgement', async () => {
    mockRpc.mockResolvedValue({
      data: databaseAcknowledgement({ is_pinned: false, unexpected: true }),
      error: null,
    })

    const response = await POST(request() as Parameters<typeof POST>[0], context)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      success: false,
      error: 'Failed to update pin state',
    })
  })

  it('maps current permission denial without issuing direct table reads or writes', async () => {
    mockRpc.mockResolvedValue({
      data: { success: false, reason: 'PERMISSION_DENIED' },
      error: null,
    })

    const response = await POST(request() as Parameters<typeof POST>[0], context)

    expect(response.status).toBe(403)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockSupabase).not.toHaveProperty('from')
  })

  it('returns a retryable conflict when scope serialization loses a race', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '40001' } })

    const response = await POST(request() as Parameters<typeof POST>[0], context)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ success: false })
  })
})
