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

// Create mock Supabase client
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

  // Chain all methods to return the client
  Object.keys(mockClient).forEach(key => {
    mockClient[key].mockReturnValue(mockClient)
  })

  return mockClient
}

describe('getPostComments', () => {
  test('should return empty array when no comments found', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.is.mockResolvedValueOnce({ data: [], error: null })

    const result = await getPostComments(mockSupabase as any, 'post1')
    expect(result).toEqual([])
  })

  test('should throw error on database error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.is.mockResolvedValueOnce({ data: null, error: new Error('DB Error') })

    await expect(getPostComments(mockSupabase as any, 'post1')).rejects.toThrow()
  })

  test('should query correct table with correct filters', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.is.mockResolvedValueOnce({ data: [], error: null })

    await getPostComments(mockSupabase as any, 'post123')

    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.eq).toHaveBeenCalledWith('post_id', 'post123')
    expect(mockSupabase.is).toHaveBeenCalledWith('parent_id', null)
  })

  test('should sort comments with top 3 by likes first', async () => {
    const mockSupabase = createMockSupabase()
    const mockComments = [
      { id: 'c1', post_id: 'post1', user_id: 'u1', content: 'Comment 1', like_count: 2, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
      { id: 'c2', post_id: 'post1', user_id: 'u2', content: 'Comment 2', like_count: 10, created_at: '2024-01-02T00:00:00Z', updated_at: '2024-01-02T00:00:00Z' },
      { id: 'c3', post_id: 'post1', user_id: 'u3', content: 'Comment 3', like_count: 5, created_at: '2024-01-03T00:00:00Z', updated_at: '2024-01-03T00:00:00Z' },
      { id: 'c4', post_id: 'post1', user_id: 'u4', content: 'Comment 4', like_count: 1, created_at: '2024-01-04T00:00:00Z', updated_at: '2024-01-04T00:00:00Z' },
    ]

    // First call - get top level comments
    mockSupabase.is.mockResolvedValueOnce({ data: mockComments, error: null })
    // Second call - get replies
    mockSupabase.order.mockResolvedValueOnce({ data: [], error: null })
    // Third call - get profiles
    mockSupabase.in.mockResolvedValueOnce({ data: [], error: null })

    const result = await getPostComments(mockSupabase as any, 'post1')

    expect(result).toHaveLength(4)
    // Top 3 by likes first: c2 (10), c3 (5), c1 (2)
    expect(result[0].id).toBe('c2')
    expect(result[1].id).toBe('c3')
    expect(result[2].id).toBe('c1')
    // Then rest by time: c4
    expect(result[3].id).toBe('c4')
  })
})

describe('getCommentById', () => {
  test('should return null when comment not found', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getCommentById(mockSupabase as any, 'nonexistent')
    expect(result).toBeNull()
  })

  test('should query correct table', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    await getCommentById(mockSupabase as any, 'comment123')

    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.eq).toHaveBeenCalledWith('id', 'comment123')
  })

  test('should throw error on database error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: new Error('DB Error') })

    await expect(getCommentById(mockSupabase as any, 'comment1')).rejects.toThrow()
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

    const result = await createComment(mockSupabase as any, 'user1', {
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
      createComment(mockSupabase as any, 'user1', { post_id: 'post1', content: 'Test' })
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

    const result = await updateComment(mockSupabase as any, 'comment1', 'user1', 'Updated content')

    expect(result.content).toBe('Updated content')
    expect(mockSupabase.update).toHaveBeenCalled()
  })

  test('should throw error when update fails', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.single.mockResolvedValueOnce({ data: null, error: new Error('Update failed') })

    await expect(
      updateComment(mockSupabase as any, 'comment1', 'user1', 'Updated')
    ).rejects.toThrow()
  })
})

describe('deleteComment', () => {
  test('should call delete with correct parameters', async () => {
    const mockSupabase = createMockSupabase()
    // Final eq returns the result
    mockSupabase.eq.mockResolvedValueOnce({ error: null })

    await deleteComment(mockSupabase as any, 'comment1', 'user1')

    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.delete).toHaveBeenCalled()
  })

  test('should throw error when delete fails', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.eq.mockResolvedValueOnce({ error: new Error('Delete failed') })

    await expect(
      deleteComment(mockSupabase as any, 'comment1', 'user1')
    ).rejects.toThrow()
  })
})

describe('getCommentCount', () => {
  test('should return comment count for a post', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.eq.mockResolvedValueOnce({ count: 10, error: null })

    const result = await getCommentCount(mockSupabase as any, 'post1')
    expect(result).toBe(10)
  })

  test('should return 0 when count is null', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.eq.mockResolvedValueOnce({ count: null, error: null })

    const result = await getCommentCount(mockSupabase as any, 'post1')
    expect(result).toBe(0)
  })

  test('should return 0 on error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.eq.mockResolvedValueOnce({ count: null, error: new Error('Error') })

    const result = await getCommentCount(mockSupabase as any, 'post1')
    expect(result).toBe(0)
  })
})
