import type { SupabaseClient } from "@supabase/supabase-js"
/**
 * Comments Data Layer Tests
 * 测试评论数据层
 */

import {
  getPostComments,
  getCommentById,
  createComment,
  updateComment,
  deleteComment,
  getCommentCount,
} from './comments'

// Create mock Supabase client with proper chaining
const createMockSupabase = () => {
  const mockClient: Record<string, jest.Mock> = {
    from: jest.fn(),
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    eq: jest.fn(),
    is: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    range: jest.fn(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
  }

  // Chain all methods to return the client by default
  Object.keys(mockClient).forEach(key => {
    mockClient[key].mockReturnValue(mockClient)
  })

  return mockClient
}

describe('getPostComments', () => {
  test('should return empty array when no comments found', async () => {
    const mockSupabase = createMockSupabase()
    // The query chain is: from().select().eq().is().order().limit()
    // limit() is the terminal call that returns the result
    mockSupabase.limit.mockResolvedValueOnce({ data: [], error: null })

    const result = await getPostComments(mockSupabase as unknown as SupabaseClient, 'post1')
    expect(result).toEqual([])
  })

  test('should throw error on database error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.limit.mockResolvedValueOnce({ data: null, error: new Error('DB Error') })

    await expect(getPostComments(mockSupabase as unknown as SupabaseClient, 'post1')).rejects.toThrow()
  })

  test('should query correct table with correct filters', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.limit.mockResolvedValueOnce({ data: [], error: null })

    await getPostComments(mockSupabase as unknown as SupabaseClient, 'post123')

    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.eq).toHaveBeenCalledWith('post_id', 'post123')
    expect(mockSupabase.is).toHaveBeenCalledWith('parent_id', null)
  })

  test('should handle comments with replies and profiles', async () => {
    const mockSupabase = createMockSupabase()
    const mockComments = [
      { id: 'c1', post_id: 'post1', user_id: 'u1', content: 'Comment 1', like_count: 2, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
    ]

    // Mock the chain: from().select().eq().is().order().limit() — limit() is terminal
    mockSupabase.limit.mockResolvedValueOnce({ data: mockComments, error: null })
    // Mock chain for replies: from().select().in().order() — order() returns data
    mockSupabase.order.mockResolvedValueOnce({ data: [], error: null })
    // Mock chain for profiles: from().select().in() — in() returns data
    mockSupabase.in.mockResolvedValueOnce({ data: [], error: null })

    const result = await getPostComments(mockSupabase as unknown as SupabaseClient, 'post1')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c1')
  })
})

describe('getCommentById', () => {
  test('should return null when comment not found', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getCommentById(mockSupabase as unknown as SupabaseClient, 'nonexistent')
    expect(result).toBeNull()
  })

  test('should query correct table', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    await getCommentById(mockSupabase as unknown as SupabaseClient, 'comment123')

    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.eq).toHaveBeenCalledWith('id', 'comment123')
  })

  test('should return null on database error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: new Error('DB Error') })

    // getCommentById returns null on error, doesn't throw
    const result = await getCommentById(mockSupabase as unknown as SupabaseClient, 'comment1')
    expect(result).toBeNull()
  })
})

describe('createComment', () => {
  test('should insert comment with correct data', async () => {
    const mockSupabase = createMockSupabase()
    const mockComment = {
      id: 'new-comment',
      post_id: 'post1',
      user_id: 'user1',
      content: 'New comment',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }

    mockSupabase.single.mockResolvedValueOnce({ data: mockComment, error: null })
    // Mock profile lookup
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { handle: 'testUser' }, error: null })

    const result = await createComment(mockSupabase as unknown as SupabaseClient, 'user1', {
      post_id: 'post1',
      content: 'New comment',
    })

    expect(result.content).toBe('New comment')
    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.insert).toHaveBeenCalled()
  })

  test('should throw error on database error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.single.mockResolvedValueOnce({ data: null, error: new Error('DB Error') })

    await expect(
      createComment(mockSupabase as unknown as SupabaseClient, 'user1', { post_id: 'post1', content: 'Test' })
    ).rejects.toThrow()
  })
})

describe('updateComment', () => {
  test('should update comment content', async () => {
    const mockSupabase = createMockSupabase()
    const updatedComment = {
      id: 'comment1',
      content: 'Updated content',
      updated_at: '2024-01-02T00:00:00Z',
    }

    mockSupabase.single.mockResolvedValueOnce({ data: updatedComment, error: null })

    const result = await updateComment(mockSupabase as unknown as SupabaseClient, 'comment1', 'user1', 'Updated content')

    expect(result.content).toBe('Updated content')
    expect(mockSupabase.update).toHaveBeenCalled()
  })

  test('should throw error when update fails', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.single.mockResolvedValueOnce({ data: null, error: new Error('Update failed') })

    await expect(
      updateComment(mockSupabase as unknown as SupabaseClient, 'comment1', 'user1', 'Updated')
    ).rejects.toThrow()
  })
})

describe('deleteComment', () => {
  test('should call delete with correct parameters', async () => {
    const mockSupabase = createMockSupabase()
    // .eq() is called twice: .eq('id', commentId).eq('user_id', userId)
    // First .eq() returns mockClient, second .eq() returns the result
    mockSupabase.eq
      .mockReturnValueOnce(mockSupabase) // First .eq() returns chain
      .mockResolvedValueOnce({ error: null }) // Second .eq() returns result

    await deleteComment(mockSupabase as unknown as SupabaseClient, 'comment1', 'user1')

    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.delete).toHaveBeenCalled()
    expect(mockSupabase.eq).toHaveBeenCalledWith('id', 'comment1')
    expect(mockSupabase.eq).toHaveBeenCalledWith('user_id', 'user1')
  })

  test('should throw error when delete fails', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.eq
      .mockReturnValueOnce(mockSupabase) // First .eq() returns chain
      .mockResolvedValueOnce({ error: new Error('Delete failed') }) // Second .eq() returns error

    await expect(
      deleteComment(mockSupabase as unknown as SupabaseClient, 'comment1', 'user1')
    ).rejects.toThrow()
  })
})

describe('getCommentCount', () => {
  test('should return comment count for a post', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.eq.mockResolvedValueOnce({ count: 10, error: null })

    const result = await getCommentCount(mockSupabase as unknown as SupabaseClient, 'post1')
    expect(result).toBe(10)
  })

  test('should return 0 when count is null', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.eq.mockResolvedValueOnce({ count: null, error: null })

    const result = await getCommentCount(mockSupabase as unknown as SupabaseClient, 'post1')
    expect(result).toBe(0)
  })

  test('should return 0 on error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.eq.mockResolvedValueOnce({ count: null, error: new Error('Error') })

    const result = await getCommentCount(mockSupabase as unknown as SupabaseClient, 'post1')
    expect(result).toBe(0)
  })
})
