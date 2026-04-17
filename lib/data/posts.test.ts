// Mock sanitize to avoid isomorphic-dompurify → jsdom → undici ESM issue
jest.mock('@/lib/utils/sanitize', () => ({
  sanitizeText: jest.fn((text: string) => text),
  sanitizeHtml: jest.fn((html: string) => html),
}))

import type { SupabaseClient } from "@supabase/supabase-js"
/**
 * Posts Data Layer Tests
 * 测试帖子数据层
 */

import {
  getPosts,
  getPostById,
  createPost,
  updatePost,
  deletePost,
  incrementViewCount,
  getUserPostReaction,
  togglePostReaction,
  getUserPostVote,
  togglePostVote,
  getUserPostReactions,
  getUserPostVotes,
} from './posts'

// Type for mock Supabase resolve callback
type MockResolve<T> = (result: { data: T; error: Error | null }) => void

// Create mock Supabase client
const createMockSupabase = () => ({
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  upsert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  neq: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  range: jest.fn().mockReturnThis(),
  maybeSingle: jest.fn(),
  single: jest.fn(),
  rpc: jest.fn(),
})

describe('getPosts', () => {
  test('should return posts with author avatars', async () => {
    const mockSupabase = createMockSupabase()
    const mockPosts = [
      {
        id: 'post1',
        title: 'Test Post',
        content: 'Test content',
        author_id: 'user1',
        author_handle: 'testUser',
        group_id: null,
        created_at: '2024-01-01T00:00:00Z',
      },
    ]

    mockSupabase.range.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({ data: mockPosts, error: null }),
    })

    mockSupabase.in.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({
        data: [{ handle: 'testUser', avatar_url: 'https://example.com/avatar.png' }],
        error: null,
      }),
    })

    const result = await getPosts(mockSupabase as unknown as SupabaseClient)
    expect(result).toHaveLength(1)
    expect(result[0].author_handle).toBe('testUser')
  })

  test('should return empty array when no posts found', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.range.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({ data: [], error: null }),
    })

    const result = await getPosts(mockSupabase as unknown as SupabaseClient)
    expect(result).toEqual([])
  })

  test('should throw error on database error', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.range.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({ data: null, error: new Error('DB Error') }),
    })

    await expect(getPosts(mockSupabase as unknown as SupabaseClient)).rejects.toThrow()
  })

  test('should filter by group_id when provided', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.range.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({ data: [], error: null }),
    })

    await getPosts(mockSupabase as unknown as SupabaseClient, { group_id: 'group123' })
    expect(mockSupabase.eq).toHaveBeenCalledWith('group_id', 'group123')
  })

  test('should filter by author_handle when provided', async () => {
    const mockSupabase = createMockSupabase()

    // Mock the user profile lookup (first call to supabase)
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { id: 'user123' }, error: null })

    mockSupabase.range.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({ data: [], error: null }),
    })

    await getPosts(mockSupabase as unknown as SupabaseClient, { author_handle: 'testUser' })
    // Should filter by author_id after finding user profile
    expect(mockSupabase.eq).toHaveBeenCalledWith('author_id', 'user123')
  })
})

describe('getPostById', () => {
  test('should return null when post not found', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getPostById(mockSupabase as unknown as SupabaseClient, 'nonexistent')
    expect(result).toBeNull()
  })

  test('should return post with author avatar', async () => {
    const mockSupabase = createMockSupabase()
    const mockPost = {
      id: 'post1',
      title: 'Test Post',
      content: 'Test content',
      author_id: 'user1',
      author_handle: 'testUser',
      group_id: null,
      created_at: '2024-01-01T00:00:00Z',
      original_post_id: null,
    }

    const mockProfile = {
      id: 'user1',
      handle: 'testUser',
      avatar_url: 'https://example.com/avatar.png',
      subscription_tier: null,
      show_pro_badge: true,
    }

    // First maybeSingle for post, then in() returns profile array
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: mockPost, error: null })
    mockSupabase.in.mockImplementationOnce(() => ({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({ data: [mockProfile], error: null }),
    }))

    const result = await getPostById(mockSupabase as unknown as SupabaseClient, 'post1')
    expect(result).not.toBeNull()
    expect(result?.id).toBe('post1')
    expect(result?.author_avatar_url).toBe('https://example.com/avatar.png')
  })

  test('should throw error on database error', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: new Error('DB Error') })

    await expect(getPostById(mockSupabase as unknown as SupabaseClient, 'post1')).rejects.toThrow()
  })
})

describe('createPost', () => {
  test('should create a new post', async () => {
    const mockSupabase = createMockSupabase()
    const mockPost = {
      id: 'newpost1',
      title: 'New Post',
      content: 'New content',
      author_id: 'user1',
      author_handle: 'testUser',
    }

    mockSupabase.single.mockResolvedValueOnce({ data: mockPost, error: null })

    const result = await createPost(mockSupabase as unknown as SupabaseClient, 'user1', 'testUser', {
      title: 'New Post',
      content: 'New content',
    })

    expect(result.title).toBe('New Post')
    expect(mockSupabase.insert).toHaveBeenCalled()
  })

  test('should throw error on creation failure', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.single.mockResolvedValueOnce({ data: null, error: new Error('Creation failed') })

    await expect(
      createPost(mockSupabase as unknown as SupabaseClient, 'user1', 'testUser', { title: 'Test', content: 'Test' })
    ).rejects.toThrow()
  })
})

describe('updatePost', () => {
  test('should update an existing post', async () => {
    const mockSupabase = createMockSupabase()
    const mockPost = {
      id: 'post1',
      title: 'Updated Title',
      content: 'Updated content',
    }

    mockSupabase.single.mockResolvedValueOnce({ data: mockPost, error: null })

    const result = await updatePost(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', {
      title: 'Updated Title',
    })

    expect(result.title).toBe('Updated Title')
  })

  test('should throw error on update failure', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.single.mockResolvedValueOnce({ data: null, error: new Error('Update failed') })

    await expect(
      updatePost(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', { title: 'Test' })
    ).rejects.toThrow()
  })
})

describe('deletePost', () => {
  test('should delete a post', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.eq.mockReturnValueOnce({
      ...mockSupabase,
      eq: jest.fn().mockReturnValue({ then: (resolve: MockResolve<unknown>) => resolve({ error: null }) }),
    })

    await expect(deletePost(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')).resolves.toBeUndefined()
  })

  test('should throw error on deletion failure', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.eq.mockReturnValueOnce({
      ...mockSupabase,
      eq: jest.fn().mockReturnValue({ then: (resolve: MockResolve<unknown>) => resolve({ error: new Error('Delete failed') }) }),
    })

    await expect(deletePost(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')).rejects.toThrow()
  })
})

describe('incrementViewCount', () => {
  test('should call rpc to increment view count', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.rpc.mockResolvedValueOnce({ error: null })

    await incrementViewCount(mockSupabase as unknown as SupabaseClient, 'post1')
    expect(mockSupabase.rpc).toHaveBeenCalledWith('increment_post_view', { post_id: 'post1' })
  })
})

describe('getUserPostReaction', () => {
  test('should return null when no reaction found', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getUserPostReaction(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    expect(result).toBeNull()
  })

  test('should return reaction type when found', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { reaction_type: 'up' }, error: null })

    const result = await getUserPostReaction(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    expect(result).toBe('up')
  })
})

describe('togglePostReaction', () => {
  test('should add new reaction', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })
    mockSupabase.insert.mockReturnValueOnce({
      then: (resolve: MockResolve<unknown>) => resolve({ error: null }),
    })

    const result = await togglePostReaction(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'up')
    expect(result.action).toBe('added')
    expect(result.reaction).toBe('up')
  })

  test('should remove existing same reaction', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { id: 'reaction1', reaction_type: 'up' }, error: null })
    mockSupabase.eq.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({ error: null }),
    })

    const result = await togglePostReaction(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'up')
    expect(result.action).toBe('removed')
    expect(result.reaction).toBeNull()
  })

  test('should change reaction type', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { id: 'reaction1', reaction_type: 'up' }, error: null })
    mockSupabase.eq.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({ error: null }),
    })

    const result = await togglePostReaction(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'down')
    expect(result.action).toBe('changed')
    expect(result.reaction).toBe('down')
  })
})

describe('getUserPostVote', () => {
  test('should return null when no vote found', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getUserPostVote(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    expect(result).toBeNull()
  })

  test('should return vote choice when found', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { choice: 'bull' }, error: null })

    const result = await getUserPostVote(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    expect(result).toBe('bull')
  })
})

describe('togglePostVote', () => {
  test('should add new vote', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })
    mockSupabase.insert.mockReturnValueOnce({
      then: (resolve: MockResolve<unknown>) => resolve({ error: null }),
    })

    const result = await togglePostVote(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'bull')
    expect(result.action).toBe('added')
    expect(result.vote).toBe('bull')
  })

  test('should remove existing same vote', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { id: 'vote1', choice: 'bull' }, error: null })
    mockSupabase.eq.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({ error: null }),
    })

    const result = await togglePostVote(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'bull')
    expect(result.action).toBe('removed')
    expect(result.vote).toBeNull()
  })
})

describe('getUserPostReactions', () => {
  test('should return map of user reactions', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.eq.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({
        data: [
          { post_id: 'post1', reaction_type: 'up' },
          { post_id: 'post2', reaction_type: 'down' },
        ],
        error: null,
      }),
    })

    const result = await getUserPostReactions(mockSupabase as unknown as SupabaseClient, ['post1', 'post2'], 'user1')
    expect(result.get('post1')).toBe('up')
    expect(result.get('post2')).toBe('down')
  })
})

describe('getUserPostVotes', () => {
  test('should return map of user votes', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.eq.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) => resolve({
        data: [
          { post_id: 'post1', choice: 'bull' },
          { post_id: 'post2', choice: 'bear' },
        ],
        error: null,
      }),
    })

    const result = await getUserPostVotes(mockSupabase as unknown as SupabaseClient, ['post1', 'post2'], 'user1')
    expect(result.get('post1')).toBe('bull')
    expect(result.get('post2')).toBe('bear')
  })
})
