/** @jest-environment node */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const REQUEST_ID = 'a'.repeat(32)
const mockSetPostVoteDesiredState = jest.fn()
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
    setPostVoteDesiredState: (...args: unknown[]) => mockSetPostVoteDesiredState(...args),
  }
})
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))

import { PostInteractionMutationError } from '@/lib/data/posts'
import { POST } from '../route'

function request(body: unknown, postId = POST_ID, raw = false) {
  return {
    url: `https://www.arenafi.org/api/posts/${postId}/vote`,
    json: async () => {
      if (raw) throw new SyntaxError('Invalid JSON')
      return body
    },
  }
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'set_vote',
    request_id: REQUEST_ID,
    desired_choice: 'bull',
    ...overrides,
  }
}

describe('POST /api/posts/[id]/vote exact desired-state receipt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSetPostVoteDesiredState.mockResolvedValue({
      action: 'added',
      vote: 'bull',
      poll: { bull: 2, bear: 1, wait: 0 },
    })
  })

  it('returns an actor/post/request/choice-bound absolute-count receipt', async () => {
    const response = await POST(request(body()) as never)

    expect(mockSetPostVoteDesiredState).toHaveBeenCalledWith(mockSupabase, POST_ID, USER_ID, 'bull')
    await expect(response.json()).resolves.toEqual({
      actor_id: USER_ID,
      post_id: POST_ID,
      request_id: REQUEST_ID,
      operation: 'set_vote',
      desired_choice: 'bull',
      action: 'added',
      vote: 'bull',
      poll: { bull: 2, bear: 1, wait: 0 },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('accepts explicit absence and echoes an unchanged replay', async () => {
    mockSetPostVoteDesiredState.mockResolvedValue({
      action: 'unchanged',
      vote: null,
      poll: { bull: 2, bear: 1, wait: 0 },
    })

    const response = await POST(request(body({ desired_choice: null })) as never)

    expect(mockSetPostVoteDesiredState).toHaveBeenCalledWith(mockSupabase, POST_ID, USER_ID, null)
    await expect(response.json()).resolves.toMatchObject({
      request_id: REQUEST_ID,
      operation: 'set_vote',
      desired_choice: null,
      action: 'unchanged',
      vote: null,
    })
  })

  it.each([
    ['an extra field', { invented: true }],
    ['the legacy toggle operation', { operation: 'toggle' }],
    ['a malformed nonce', { request_id: 'not-a-request-id' }],
    ['the legacy choice field', { desired_choice: undefined, choice: 'bull' }],
    ['an unknown choice', { desired_choice: 'moon' }],
  ])('rejects %s before mutating', async (_name, overrides) => {
    const response = await POST(request(body(overrides)) as never)

    expect(response.status).toBe(400)
    expect(mockSetPostVoteDesiredState).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('rejects non-JSON before mutating', async () => {
    const response = await POST(request('{broken', POST_ID, true) as never)

    expect(response.status).toBe(400)
    expect(mockSetPostVoteDesiredState).not.toHaveBeenCalled()
  })

  it('rejects an invalid post identity before mutating', async () => {
    const response = await POST(request(body(), 'not-a-post') as never)

    expect(response.status).toBe(400)
    expect(mockSetPostVoteDesiredState).not.toHaveBeenCalled()
  })

  it.each([
    ['not_found', 404, 'Post not found'],
    ['invalid', 400, 'Invalid vote request'],
  ] as const)('maps an atomic %s result without a success receipt', async (kind, status, error) => {
    mockSetPostVoteDesiredState.mockRejectedValue(new PostInteractionMutationError(kind))

    const response = await POST(request(body()) as never)

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error })
  })
})
