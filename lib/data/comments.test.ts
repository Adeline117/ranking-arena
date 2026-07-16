import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
/**
 * Comments Data Layer Tests
 * 测试评论数据层
 */

const mockUpdateOwnCommentWithRollout = jest.fn()
const mockDeleteOwnCommentWithRollout = jest.fn()

jest.mock('@/lib/data/comment-mutation-rollout', () => ({
  CommentMutationRolloutError: class MockCommentMutationRolloutError extends Error {
    constructor(
      public readonly kind: string,
      public readonly databaseCode?: string,
      public readonly stage?: string
    ) {
      super(`Comment mutation failed: ${kind}`)
    }
  },
  updateOwnCommentWithRollout: (...args: unknown[]) => mockUpdateOwnCommentWithRollout(...args),
  deleteOwnCommentWithRollout: (...args: unknown[]) => mockDeleteOwnCommentWithRollout(...args),
}))

import {
  getPostComments,
  getCommentById,
  createComment,
  updateComment,
  deleteComment,
  getCommentCount,
} from './comments'

// Mock sanitize — these tests cover data-layer logic; sanitize behavior is tested in lib/utils/__tests__/sanitize.test.ts
jest.mock('@/lib/utils/sanitize', () => ({
  sanitizeText: jest.fn((text: string) => text),
  sanitizeHtml: jest.fn((html: string) => html),
}))

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
    not: jest.fn(),
    or: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    range: jest.fn(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
  }

  // Chain all methods to return the client by default
  Object.keys(mockClient).forEach((key) => {
    mockClient[key].mockReturnValue(mockClient)
  })

  return mockClient
}

describe('getPostComments', () => {
  test('should return empty array when no comments found', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.range.mockResolvedValueOnce({ data: [], error: null })

    const result = await getPostComments(
      mockSupabase as unknown as SupabaseClient<Database>,
      'post1'
    )
    expect(result).toEqual([])
  })

  test('should throw error on database error', async () => {
    const mockSupabase = createMockSupabase()
    // range() is now the terminal call (was limit() before SQL-level pagination)
    mockSupabase.range.mockResolvedValueOnce({ data: null, error: new Error('DB Error') })

    await expect(
      getPostComments(mockSupabase as unknown as SupabaseClient<Database>, 'post1')
    ).rejects.toThrow()
  })

  test('should query correct table with correct filters', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.range.mockResolvedValueOnce({ data: [], error: null })

    await getPostComments(mockSupabase as unknown as SupabaseClient<Database>, 'post123')

    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.eq).toHaveBeenCalledWith('post_id', 'post123')
    expect(mockSupabase.is).toHaveBeenCalledWith('parent_id', null)
    expect(mockSupabase.order).toHaveBeenNthCalledWith(1, 'ranking_score', { ascending: false })
    expect(mockSupabase.order).toHaveBeenNthCalledWith(2, 'created_at', { ascending: false })
    expect(mockSupabase.order).toHaveBeenNthCalledWith(3, 'id', { ascending: false })
  })

  test('uses stable database ordering for the time sort', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.range.mockResolvedValueOnce({ data: [], error: null })

    await getPostComments(mockSupabase as unknown as SupabaseClient<Database>, 'post123', {
      sort: 'time',
    })

    expect(mockSupabase.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false })
    expect(mockSupabase.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false })
    expect(mockSupabase.order).not.toHaveBeenCalledWith('ranking_score', expect.anything())
  })

  test('filters blocked authors before range and applies the same filter to replies', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.or.mockResolvedValueOnce({
      data: [{ blocker_id: 'viewer', blocked_id: 'blocked-author' }],
      error: null,
    })
    mockSupabase.range.mockResolvedValueOnce({
      data: [
        {
          id: 'c1',
          post_id: 'post1',
          user_id: 'visible-author',
          content: 'Visible comment',
          like_count: 0,
          dislike_count: 0,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      error: null,
    })

    await getPostComments(mockSupabase as unknown as SupabaseClient<Database>, 'post1', {
      userId: 'viewer',
    })

    expect(mockSupabase.not).toHaveBeenNthCalledWith(1, 'user_id', 'in', '(blocked-author)')
    expect(mockSupabase.not.mock.invocationCallOrder[0]).toBeLessThan(
      mockSupabase.range.mock.invocationCallOrder[0]
    )
    expect(mockSupabase.not).toHaveBeenNthCalledWith(2, 'user_id', 'in', '(blocked-author)')
  })

  test('fails closed when the block relationship lookup fails', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.or.mockResolvedValueOnce({
      data: null,
      error: new Error('block lookup failed'),
    })

    await expect(
      getPostComments(mockSupabase as unknown as SupabaseClient<Database>, 'post1', {
        userId: 'viewer',
      })
    ).rejects.toThrow('block lookup failed')

    expect(mockSupabase.range).not.toHaveBeenCalled()
  })

  test('should handle comments with replies and profiles', async () => {
    const mockSupabase = createMockSupabase()
    const mockComments = [
      {
        id: 'c1',
        post_id: 'post1',
        user_id: 'u1',
        content: 'Comment 1',
        like_count: 2,
        dislike_count: 0,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
    ]

    // 1st query chain: from().select().eq().is().order().range() — range() is terminal
    mockSupabase.range.mockResolvedValueOnce({ data: mockComments, error: null })
    // Subsequent queries for replies + profiles resolve via the default chain
    mockSupabase.order.mockReturnValue(mockSupabase)
    mockSupabase.in
      .mockReturnValueOnce(mockSupabase) // replies: in() chains to order()
      .mockResolvedValueOnce({ data: [], error: null }) // profiles: in() is terminal

    // Promise.all for profiles + likes — both resolve via in()
    mockSupabase.in.mockResolvedValue({ data: null, error: null })

    const result = await getPostComments(
      mockSupabase as unknown as SupabaseClient<Database>,
      'post1'
    )

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c1')
  })

  test('fails closed when the replies query fails', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.range.mockResolvedValueOnce({
      data: [
        {
          id: 'c1',
          post_id: 'post1',
          user_id: 'u1',
          content: 'Comment',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      error: null,
    })
    mockSupabase.order.mockImplementation((field, options) =>
      field === 'id' && options?.ascending === true
        ? Promise.resolve({ data: null, error: new Error('replies failed') })
        : mockSupabase
    )

    await expect(
      getPostComments(mockSupabase as unknown as SupabaseClient<Database>, 'post1')
    ).rejects.toThrow('replies failed')
  })

  test('fails closed when author profile hydration fails', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.range.mockResolvedValueOnce({
      data: [
        {
          id: 'c1',
          post_id: 'post1',
          user_id: 'u1',
          content: 'Comment',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      error: null,
    })
    mockSupabase.order.mockImplementation((field, options) =>
      field === 'id' && options?.ascending === true
        ? Promise.resolve({ data: [], error: null })
        : mockSupabase
    )
    mockSupabase.in.mockImplementation((field) =>
      field === 'id'
        ? Promise.resolve({ data: null, error: new Error('profiles failed') })
        : mockSupabase
    )

    await expect(
      getPostComments(mockSupabase as unknown as SupabaseClient<Database>, 'post1')
    ).rejects.toThrow('profiles failed')
  })

  test('fails closed when viewer reaction hydration fails', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.or.mockResolvedValueOnce({ data: [], error: null })
    mockSupabase.range.mockResolvedValueOnce({
      data: [
        {
          id: 'c1',
          post_id: 'post1',
          user_id: 'u1',
          content: 'Comment',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      error: null,
    })
    mockSupabase.order.mockImplementation((field, options) =>
      field === 'id' && options?.ascending === true
        ? Promise.resolve({ data: [], error: null })
        : mockSupabase
    )
    mockSupabase.in.mockImplementation((field) => {
      if (field === 'id') return Promise.resolve({ data: [], error: null })
      if (field === 'comment_id') {
        return Promise.resolve({ data: null, error: new Error('reactions failed') })
      }
      return mockSupabase
    })

    await expect(
      getPostComments(mockSupabase as unknown as SupabaseClient<Database>, 'post1', {
        userId: 'viewer',
      })
    ).rejects.toThrow('reactions failed')
  })
})

describe('getCommentById', () => {
  test('should return null when comment not found', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getCommentById(
      mockSupabase as unknown as SupabaseClient<Database>,
      'nonexistent'
    )
    expect(result).toBeNull()
  })

  test('should query correct table', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    await getCommentById(mockSupabase as unknown as SupabaseClient<Database>, 'comment123')

    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.eq).toHaveBeenCalledWith('id', 'comment123')
  })

  test('should return null on database error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: new Error('DB Error') })

    // getCommentById returns null on error, doesn't throw
    const result = await getCommentById(
      mockSupabase as unknown as SupabaseClient<Database>,
      'comment1'
    )
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

    const result = await createComment(
      mockSupabase as unknown as SupabaseClient<Database>,
      'user1',
      {
        post_id: 'post1',
        content: 'New comment',
      }
    )

    expect(result.content).toBe('New comment')
    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.insert).toHaveBeenCalled()
  })

  test('should throw error on database error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.single.mockResolvedValueOnce({ data: null, error: new Error('DB Error') })

    await expect(
      createComment(mockSupabase as unknown as SupabaseClient<Database>, 'user1', {
        post_id: 'post1',
        content: 'Test',
      })
    ).rejects.toThrow()
  })
})

describe('updateComment', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should update comment content', async () => {
    const mockSupabase = createMockSupabase()
    const updatedComment = {
      id: 'comment1',
      post_id: 'post1',
      user_id: 'user1',
      content: 'Updated content',
      parent_id: null,
      like_count: 0,
      dislike_count: 0,
      deleted_at: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    }

    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: { id: 'comment1', post_id: 'post1', user_id: 'user1', deleted_at: null },
      error: null,
    })
    mockUpdateOwnCommentWithRollout.mockResolvedValue(updatedComment)

    const result = await updateComment(
      mockSupabase as unknown as SupabaseClient<Database>,
      'comment1',
      'user1',
      'Updated content'
    )

    expect(result.content).toBe('Updated content')
    expect(mockUpdateOwnCommentWithRollout).toHaveBeenCalledWith(mockSupabase, {
      commentId: 'comment1',
      postId: 'post1',
      userId: 'user1',
      content: 'Updated content',
    })
    expect(mockSupabase.update).not.toHaveBeenCalled()
  })

  test('should throw error when update fails', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: { id: 'comment1', post_id: 'post1', user_id: 'user1', deleted_at: null },
      error: null,
    })
    mockUpdateOwnCommentWithRollout.mockRejectedValue(new Error('Update failed'))

    await expect(
      updateComment(
        mockSupabase as unknown as SupabaseClient<Database>,
        'comment1',
        'user1',
        'Updated'
      )
    ).rejects.toThrow()
  })

  test('should reject a resource owned by another user before invoking the mutation bridge', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: { id: 'comment1', post_id: 'post1', user_id: 'user2', deleted_at: null },
      error: null,
    })

    await expect(
      updateComment(
        mockSupabase as unknown as SupabaseClient<Database>,
        'comment1',
        'user1',
        'Updated'
      )
    ).rejects.toMatchObject({ kind: 'forbidden', stage: 'data-layer-ownership' })
    expect(mockUpdateOwnCommentWithRollout).not.toHaveBeenCalled()
  })

  test('should classify an ownership pre-read database failure', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX701' },
    })

    await expect(
      updateComment(
        mockSupabase as unknown as SupabaseClient<Database>,
        'comment1',
        'user1',
        'Updated'
      )
    ).rejects.toMatchObject({
      kind: 'database',
      databaseCode: 'XX701',
      stage: 'data-layer-read',
    })
    expect(mockUpdateOwnCommentWithRollout).not.toHaveBeenCalled()
  })

  test('should reject a malformed mutation acknowledgement', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: { id: 'comment1', post_id: 'post1', user_id: 'user1', deleted_at: null },
      error: null,
    })
    mockUpdateOwnCommentWithRollout.mockResolvedValue({
      id: 'comment1',
      post_id: 'post1',
      user_id: 'user1',
      content: 'Updated',
      deleted_at: null,
      updated_at: '2024-01-02T00:00:00Z',
    })

    await expect(
      updateComment(
        mockSupabase as unknown as SupabaseClient<Database>,
        'comment1',
        'user1',
        'Updated'
      )
    ).rejects.toMatchObject({ kind: 'database', stage: 'data-layer-ack' })
  })
})

describe('deleteComment', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should call delete with correct parameters', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: { id: 'comment1', post_id: 'post1', user_id: 'user1', deleted_at: null },
      error: null,
    })
    mockDeleteOwnCommentWithRollout.mockResolvedValue({ deleted_count: 1, comment_count: 2 })

    await deleteComment(mockSupabase as unknown as SupabaseClient<Database>, 'comment1', 'user1')

    expect(mockSupabase.from).toHaveBeenCalledWith('comments')
    expect(mockSupabase.eq).toHaveBeenCalledWith('id', 'comment1')
    expect(mockDeleteOwnCommentWithRollout).toHaveBeenCalledWith(mockSupabase, {
      commentId: 'comment1',
      postId: 'post1',
      userId: 'user1',
    })
    expect(mockSupabase.delete).not.toHaveBeenCalled()
  })

  test('should throw error when delete fails', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: { id: 'comment1', post_id: 'post1', user_id: 'user1', deleted_at: null },
      error: null,
    })
    mockDeleteOwnCommentWithRollout.mockRejectedValue(new Error('Delete failed'))

    await expect(
      deleteComment(mockSupabase as unknown as SupabaseClient<Database>, 'comment1', 'user1')
    ).rejects.toThrow()
  })
})

describe('getCommentCount', () => {
  test('should return comment count for a post', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.is.mockResolvedValueOnce({ count: 10, error: null })

    const result = await getCommentCount(
      mockSupabase as unknown as SupabaseClient<Database>,
      'post1'
    )
    expect(result).toBe(10)
  })

  test('should return 0 when count is null', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.is.mockResolvedValueOnce({ count: null, error: null })

    const result = await getCommentCount(
      mockSupabase as unknown as SupabaseClient<Database>,
      'post1'
    )
    expect(result).toBe(0)
  })

  test('should return 0 on error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.is.mockResolvedValueOnce({ count: null, error: new Error('Error') })

    const result = await getCommentCount(
      mockSupabase as unknown as SupabaseClient<Database>,
      'post1'
    )
    expect(result).toBe(0)
  })
})
