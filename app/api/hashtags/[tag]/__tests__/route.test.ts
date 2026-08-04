/** @jest-environment node */

const mockGetAuthUser = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockGetPostsByHashtag = jest.fn()
const mockGetUserPostReactions = jest.fn()
const mockGetUserPostVotes = jest.fn()
const mockSupabase = { service: true }

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockSupabase,
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { public: {} },
}))

jest.mock('@/lib/data/hashtags', () => ({
  getPostsByHashtag: (...args: unknown[]) => mockGetPostsByHashtag(...args),
}))

jest.mock('@/lib/data/posts', () => ({
  getUserPostReactions: (...args: unknown[]) => mockGetUserPostReactions(...args),
  getUserPostVotes: (...args: unknown[]) => mockGetUserPostVotes(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { NextRequest, NextResponse } from 'next/server'
import { GET } from '../route'

const context = { params: Promise.resolve({ tag: 'BTC' }) }

function expectPrivateNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vary')).toContain('Authorization')
}

describe('GET /api/hashtags/[tag] viewer truth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue(null)
    mockGetPostsByHashtag.mockResolvedValue({
      posts: [{ id: 'post-1', title: 'Post' }],
      total: 1,
      has_more: false,
    })
    mockGetUserPostReactions.mockResolvedValue(new Map())
    mockGetUserPostVotes.mockResolvedValue(new Map())
  })

  it('keeps a request without Authorization anonymous and does not read interaction state', async () => {
    const response = await GET(new NextRequest('https://arena.test/api/hashtags/BTC'), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockGetAuthUser).not.toHaveBeenCalled()
    expect(mockGetPostsByHashtag).toHaveBeenCalledWith(mockSupabase, 'BTC', {
      limit: 20,
      offset: 0,
      sort_by: 'created_at',
      viewer_id: null,
    })
    expect(mockGetUserPostReactions).not.toHaveBeenCalled()
    expect(mockGetUserPostVotes).not.toHaveBeenCalled()
    expect(body.data.posts[0]).toMatchObject({ user_reaction: null, user_vote: null })
    expectPrivateNoStore(response)
  })

  it('rejects a supplied invalid bearer with a private 401 before reading posts', async () => {
    const response = await GET(
      new NextRequest('https://arena.test/api/hashtags/BTC', {
        headers: { authorization: 'Bearer expired-token' },
      }),
      context
    )

    expect(response.status).toBe(401)
    expect(mockGetPostsByHashtag).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('passes the authenticated viewer to audience filtering and hydrates strict interaction truth', async () => {
    mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })
    mockGetUserPostReactions.mockResolvedValue(new Map([['post-1', 'up']]))
    mockGetUserPostVotes.mockResolvedValue(new Map([['post-1', 'bear']]))

    const response = await GET(
      new NextRequest('https://arena.test/api/hashtags/BTC?limit=5&offset=2', {
        headers: { authorization: 'Bearer valid-token' },
      }),
      context
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockGetPostsByHashtag).toHaveBeenCalledWith(mockSupabase, 'BTC', {
      limit: 5,
      offset: 2,
      sort_by: 'created_at',
      viewer_id: 'viewer-1',
    })
    expect(mockGetUserPostReactions).toHaveBeenCalledWith(mockSupabase, ['post-1'], 'viewer-1')
    expect(mockGetUserPostVotes).toHaveBeenCalledWith(mockSupabase, ['post-1'], 'viewer-1')
    expect(body.data.posts[0]).toMatchObject({ user_reaction: 'up', user_vote: 'bear' })
    expectPrivateNoStore(response)
  })

  it('returns a private 500 when either authenticated interaction read fails', async () => {
    mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })
    mockGetUserPostReactions.mockRejectedValue(new Error('reaction read failed'))

    const response = await GET(
      new NextRequest('https://arena.test/api/hashtags/BTC', {
        headers: { authorization: 'Bearer valid-token' },
      }),
      context
    )

    expect(response.status).toBe(500)
    expectPrivateNoStore(response)
  })

  it('returns a private 500 instead of publishing malformed interaction hydration', async () => {
    mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })
    mockGetUserPostVotes.mockResolvedValue({ malformed: true })

    const response = await GET(
      new NextRequest('https://arena.test/api/hashtags/BTC', {
        headers: { authorization: 'Bearer valid-token' },
      }),
      context
    )

    expect(response.status).toBe(500)
    expectPrivateNoStore(response)
  })

  it('uses authorized look-ahead truth for has_more and publishes null while total is unknown', async () => {
    mockGetPostsByHashtag.mockResolvedValue({
      posts: [{ id: 'post-1' }],
      total: null,
      has_more: true,
    })

    const response = await GET(new NextRequest('https://arena.test/api/hashtags/BTC'), context)
    const body = await response.json()

    expect(body.data.total).toBeNull()
    expect(body.meta.pagination.has_more).toBe(true)
    expect(body.meta.pagination).not.toHaveProperty('total')
    expectPrivateNoStore(response)
  })

  it('marks database errors and rate-limit responses private no-store', async () => {
    mockGetPostsByHashtag.mockRejectedValueOnce(new Error('database unavailable'))
    const failed = await GET(new NextRequest('https://arena.test/api/hashtags/BTC'), context)
    expect(failed.status).toBe(500)
    expectPrivateNoStore(failed)

    mockCheckRateLimit.mockResolvedValueOnce(
      NextResponse.json({ success: false, error: 'rate limited' }, { status: 429 })
    )
    const limited = await GET(new NextRequest('https://arena.test/api/hashtags/BTC'), context)
    expect(limited.status).toBe(429)
    expectPrivateNoStore(limited)
  })

  it('also wraps a thrown rate-limit dependency failure in a private 500', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('rate limiter unavailable'))

    const response = await GET(new NextRequest('https://arena.test/api/hashtags/BTC'), context)

    expect(response.status).toBe(500)
    expect(mockGetPostsByHashtag).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })
})
