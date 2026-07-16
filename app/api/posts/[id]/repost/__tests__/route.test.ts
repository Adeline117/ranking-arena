/** @jest-environment node */

const mockFrom = jest.fn()
const mockSendNotification = jest.fn()
const mockCanServiceActorReadPost = jest.fn()
const mockUser = { id: 'viewer-1', email: 'viewer@example.com' }
const mockSupabase = { from: (...args: unknown[]) => mockFrom(...args) }
const REQUESTED_POST_ID = '00000000-0000-4000-8000-000000000001'
const ROOT_POST_ID = '00000000-0000-4000-8000-000000000002'

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: Function) =>
    async (request: Request): Promise<Response> =>
      handler({ user: mockUser, supabase: mockSupabase, request }),
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

jest.mock('@/lib/data/service-post-audience', () => ({
  canServiceActorReadPost: (...args: unknown[]) => mockCanServiceActorReadPost(...args),
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/utils/sanitize', () => ({
  sanitizeText: (value: string) => value.replaceAll('<', '').replaceAll('>', ''),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { POST } from '../route'

type Builder = Record<string, jest.Mock>

function queryResult(
  terminal: 'maybeSingle' | 'single',
  data: unknown,
  error: unknown = null
): Builder {
  const builder: Builder = {}
  for (const method of ['select', 'eq', 'is']) {
    builder[method] = jest.fn(() => builder)
  }
  builder[terminal] = jest.fn().mockResolvedValue({ data, error })
  return builder
}

function insertResult(data: unknown, error: unknown = null): Builder {
  const builder: Builder = {}
  builder.insert = jest.fn(() => builder)
  builder.select = jest.fn(() => builder)
  builder.single = jest.fn().mockResolvedValue({ data, error })
  return builder
}

function request(body: unknown): Request {
  return {
    url: `https://www.arenafi.org/api/posts/${REQUESTED_POST_ID}/repost`,
    json: async () => body,
  } as Request
}

function queueSuccessfulQueries(options?: {
  requestedOriginalId?: string | null
  rootAuthorId?: string
  existingRepost?: { id: string } | null
  insertError?: unknown
  refreshedCount?: number
}) {
  const requested = queryResult('maybeSingle', {
    id: REQUESTED_POST_ID,
    original_post_id: options?.requestedOriginalId ?? ROOT_POST_ID,
  })
  const root = queryResult('maybeSingle', {
    id: ROOT_POST_ID,
    title: 'Root title',
    author_id: options?.rootAuthorId ?? 'root-author',
    repost_count: 3,
    original_post_id: null,
    visibility: 'public',
    group_id: null,
    is_sensitive: true,
    content_warning: 'Market risk',
  })
  const duplicate = queryResult('maybeSingle', options?.existingRepost ?? null)
  const profile = queryResult('maybeSingle', { handle: 'viewer' })
  const insert = insertResult(
    options?.insertError ? null : { id: 'new-repost' },
    options?.insertError ?? null
  )
  const refreshed = queryResult('single', {
    repost_count: options?.refreshedCount ?? 4,
  })
  const queue = mockFrom
    .mockReturnValueOnce(requested)
    .mockReturnValueOnce(root)
    .mockReturnValueOnce(duplicate)
    .mockReturnValueOnce(profile)
    .mockReturnValueOnce(insert)
  if (!options?.insertError) queue.mockReturnValueOnce(refreshed)
  return { insert }
}

describe('POST /api/posts/[id]/repost', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockCanServiceActorReadPost.mockResolvedValue(true)
  })

  it('creates one canonical root repost and returns the trigger-maintained count', async () => {
    const { insert } = queueSuccessfulQueries({ refreshedCount: 4 })

    const response = await POST(request({ comment: '<great>' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      post_id: 'new-repost',
      root_post_id: ROOT_POST_ID,
      repost_count: 4,
    })
    expect(insert.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        author_id: 'viewer-1',
        original_post_id: ROOT_POST_ID,
        content: 'great',
        is_sensitive: true,
        content_warning: 'Market risk',
      })
    )
    expect(mockSendNotification).toHaveBeenCalledTimes(1)
  })

  it('rejects reposting the canonical root author own post', async () => {
    queueSuccessfulQueries({ rootAuthorId: 'viewer-1' })

    const response = await POST(request({ comment: '' }))

    expect(response.status).toBe(403)
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('returns a stable conflict for an existing active repost', async () => {
    queueSuccessfulQueries({ existingRepost: { id: 'existing-repost' } })

    const response = await POST(request({ comment: '' }))
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toMatchObject({
      code: 'already_reposted',
      post_id: 'existing-repost',
      root_post_id: ROOT_POST_ID,
    })
    expect(mockFrom).toHaveBeenCalledTimes(3)
  })

  it('maps the race-safe unique-index violation to the same conflict', async () => {
    const insertError = {
      code: '23505',
      message: 'duplicate key violates uniq_posts_active_repost_author_root',
    }
    queueSuccessfulQueries({ insertError })
    mockFrom
      .mockReturnValueOnce(queryResult('maybeSingle', { id: 'existing-repost' }))
      .mockReturnValueOnce(queryResult('maybeSingle', { repost_count: 4 }))

    const response = await POST(request({ comment: '' }))
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toMatchObject({
      code: 'already_reposted',
      post_id: 'existing-repost',
      root_post_id: ROOT_POST_ID,
      repost_count: 4,
    })
    expect(mockFrom).toHaveBeenCalledTimes(7)
  })

  it('fails closed instead of widening a follower-only root audience', async () => {
    const requested = queryResult('maybeSingle', {
      id: REQUESTED_POST_ID,
      original_post_id: ROOT_POST_ID,
    })
    const privateRoot = queryResult('maybeSingle', {
      id: ROOT_POST_ID,
      title: 'Private root',
      author_id: 'root-author',
      repost_count: 0,
      original_post_id: null,
      visibility: 'followers',
      group_id: null,
      is_sensitive: false,
      content_warning: null,
    })
    mockFrom.mockReturnValueOnce(requested).mockReturnValueOnce(privateRoot)

    const response = await POST(request({ comment: '' }))

    expect(response.status).toBe(404)
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('fails before reading the requested wrapper when canonical audience denies', async () => {
    mockCanServiceActorReadPost.mockResolvedValue(false)

    const response = await POST(request({ comment: '' }))

    expect(response.status).toBe(404)
    expect(mockCanServiceActorReadPost).toHaveBeenCalledWith(
      mockSupabase,
      REQUESTED_POST_ID,
      mockUser.id
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects comments longer than the UI contract before touching the database', async () => {
    const response = await POST(request({ comment: 'x'.repeat(281) }))

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects malformed post IDs before querying UUID columns', async () => {
    const malformedRequest = {
      url: 'https://www.arenafi.org/api/posts/not-a-uuid/repost',
      json: async () => ({}),
    } as Request

    const response = await POST(malformedRequest)

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('treats a null JSON body as an empty repost comment', async () => {
    queueSuccessfulQueries()

    const response = await POST(request(null))

    expect(response.status).toBe(200)
  })
})
