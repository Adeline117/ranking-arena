/** @jest-environment node */

const mockGetAuthUser = jest.fn()
const mockGetPostById = jest.fn()
const mockGetUserPostReaction = jest.fn()
const mockGetUserPostVote = jest.fn()
const mockUpdateCount = jest.fn()
const mockSupabase = {}

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockSupabase,
}))
jest.mock('@/lib/data/posts', () => ({
  getPostById: (...args: unknown[]) => mockGetPostById(...args),
  getUserPostReaction: (...args: unknown[]) => mockGetUserPostReaction(...args),
  getUserPostVote: (...args: unknown[]) => mockGetUserPostVote(...args),
  deletePost: jest.fn(),
}))
jest.mock('@/lib/services/counters', () => ({
  updateCount: (...args: unknown[]) => mockUpdateCount(...args),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/posts/post-edit-server', () => ({ handleAtomicPostEditHttp: jest.fn() }))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const POST_ID = '10000000-0000-4000-8000-000000000001'
const context = { params: Promise.resolve({ id: POST_ID }) }

describe('GET /api/posts/[id] optional viewer boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    mockGetPostById.mockResolvedValue({ id: POST_ID, title: 'Post' })
    mockGetUserPostReaction.mockResolvedValue(null)
    mockGetUserPostVote.mockResolvedValue(null)
  })

  it('rejects an invalid bearer before reading or incrementing the post', async () => {
    const response = await GET(
      new NextRequest(`https://arena.test/api/posts/${POST_ID}`, {
        headers: { authorization: 'Bearer expired-token' },
      }),
      context
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('Vary')).toContain('Authorization')
    expect(mockGetPostById).not.toHaveBeenCalled()
    expect(mockUpdateCount).not.toHaveBeenCalled()
  })

  it('still serves an anonymous request when no credentials were supplied', async () => {
    const response = await GET(new NextRequest(`https://arena.test/api/posts/${POST_ID}`), context)

    expect(response.status).toBe(200)
    expect(mockGetAuthUser).not.toHaveBeenCalled()
    expect(mockGetPostById).toHaveBeenCalledWith(mockSupabase, POST_ID, undefined)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it('fails closed when authenticated interaction truth cannot be read', async () => {
    mockGetAuthUser.mockResolvedValue({ id: 'user-a' })
    mockGetUserPostReaction.mockRejectedValue(new Error('reaction read failed'))

    const response = await GET(
      new NextRequest(`https://arena.test/api/posts/${POST_ID}`, {
        headers: { authorization: 'Bearer valid-token' },
      }),
      context
    )

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vary')).toContain('Authorization')
  })
})
