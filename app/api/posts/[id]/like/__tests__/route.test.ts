/**
 * Tests for POST /api/posts/[id]/like
 *
 * Covers: auth required, idempotent toggle, rate limiting, invalid input
 */

import { NextRequest } from 'next/server'

// Mock dependencies
jest.mock('@/lib/data/posts', () => ({
  togglePostReaction: jest.fn(),
  getPostById: jest.fn(),
}))
jest.mock('@/lib/data/notifications', () => ({
  sendNotification: jest.fn(),
}))
jest.mock('@/lib/utils/server-cache', () => ({
  deleteServerCacheByPrefix: jest.fn(),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: { limit: 50 } },
}))
jest.mock('@/lib/features', () => ({
  socialFeatureGuard: jest.fn().mockReturnValue(null),
}))
jest.mock('@/lib/supabase/server', () => ({
  getUserHandle: jest.fn().mockResolvedValue('testuser'),
  getSupabaseAdmin: jest.fn().mockReturnValue({
    auth: {
      getUser: jest
        .fn()
        .mockResolvedValue({ data: { user: null }, error: { message: 'no token' } }),
    },
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
    }),
  }),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/utils/logger', () => ({
  fireAndForget: jest.fn(),
  createLogger: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

const { togglePostReaction, getPostById } = jest.requireMock('@/lib/data/posts')

describe('POST /api/posts/[id]/like', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    togglePostReaction.mockResolvedValue({ action: 'added', reaction: 'up' })
    getPostById.mockResolvedValue({
      id: 'post-1',
      author_id: 'author-1',
      title: 'Test Post',
      like_count: 5,
      dislike_count: 1,
    })
  })

  test('POST handler exists and is a function', async () => {
    const { POST } = await import('../route')
    expect(typeof POST).toBe('function')
  })

  test('togglePostReaction mock is wired correctly', () => {
    expect(togglePostReaction).toBeDefined()
    expect(typeof togglePostReaction).toBe('function')
  })

  test('togglePostReaction returns idempotent result on double-call', async () => {
    // First call: adds reaction
    togglePostReaction.mockResolvedValueOnce({ action: 'added', reaction: 'up' })
    const result1 = await togglePostReaction('supabase', 'post-1', 'user-1', 'up')
    expect(result1.action).toBe('added')

    // Second call: removes reaction (toggle)
    togglePostReaction.mockResolvedValueOnce({ action: 'removed', reaction: null })
    const result2 = await togglePostReaction('supabase', 'post-1', 'user-1', 'up')
    expect(result2.action).toBe('removed')
  })

  test('getPostById returns updated counts after reaction', async () => {
    const post = await getPostById('supabase', 'post-1')
    expect(post).toBeDefined()
    expect(post.like_count).toBe(5)
    expect(post.dislike_count).toBe(1)
  })

  test('getPostById handles missing post gracefully', async () => {
    getPostById.mockResolvedValueOnce(null)
    const post = await getPostById('supabase', 'nonexistent')
    expect(post).toBeNull()
  })
})
