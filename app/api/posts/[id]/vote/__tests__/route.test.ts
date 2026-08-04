/** @jest-environment node */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const REQUEST_ID = 'a'.repeat(32)
const mockTogglePostVote = jest.fn()
const mockSupabase = {}

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<Response>) => (request: unknown) =>
      handler({ user: { id: USER_ID }, supabase: mockSupabase, request }),
}))

jest.mock('@/lib/data/posts', () => {
  class PostInteractionMutationError extends Error {
    constructor(public readonly kind: 'not_found' | 'invalid' | 'invalid_ack') {
      super(kind)
    }
  }
  return {
    PostInteractionMutationError,
    togglePostVote: (...args: unknown[]) => mockTogglePostVote(...args),
  }
})
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))

import { PostInteractionMutationError } from '@/lib/data/posts'
import { POST } from '../route'

function request(body: unknown, postId = POST_ID) {
  return {
    url: `https://www.arenafi.org/api/posts/${postId}/vote`,
    json: async () => body,
  }
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'toggle',
    request_id: REQUEST_ID,
    choice: 'bull',
    ...overrides,
  }
}

describe('POST /api/posts/[id]/vote exact toggle receipt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTogglePostVote.mockResolvedValue({
      action: 'added',
      vote: 'bull',
      poll: { bull: 2, bear: 1, wait: 0 },
    })
  })

  it('returns an actor/post/request/choice-bound absolute-count receipt', async () => {
    const response = await POST(request(body()) as never)

    expect(mockTogglePostVote).toHaveBeenCalledWith(mockSupabase, POST_ID, USER_ID, 'bull')
    await expect(response.json()).resolves.toEqual({
      actor_id: USER_ID,
      post_id: POST_ID,
      request_id: REQUEST_ID,
      operation: 'toggle',
      requested_choice: 'bull',
      action: 'added',
      vote: 'bull',
      poll: { bull: 2, bear: 1, wait: 0 },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it.each([
    ['an extra field', { invented: true }],
    ['another operation', { operation: 'set' }],
    ['a malformed nonce', { request_id: 'not-a-request-id' }],
  ])('rejects %s before mutating', async (_name, overrides) => {
    const response = await POST(request(body(overrides)) as never)

    expect(response.status).toBe(400)
    expect(mockTogglePostVote).not.toHaveBeenCalled()
  })

  it('maps an atomic not-found result without publishing a success receipt', async () => {
    mockTogglePostVote.mockRejectedValue(new PostInteractionMutationError('not_found'))

    const response = await POST(request(body()) as never)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Post not found' })
  })
})
