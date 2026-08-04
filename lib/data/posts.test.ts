// Mock sanitize — these tests cover data-layer logic; sanitize behavior is tested in lib/utils/__tests__/sanitize.test.ts
jest.mock('@/lib/utils/sanitize', () => ({
  sanitizeText: jest.fn((text: string) => text),
  sanitizeHtml: jest.fn((html: string) => html),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
/**
 * Posts Data Layer Tests
 * 测试帖子数据层
 */

import {
  getPosts,
  getPostById,
  updatePost,
  deletePost,
  getUserPostReaction,
  setPostReactionDesiredState,
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
  is: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  range: jest.fn().mockReturnThis(),
  maybeSingle: jest.fn(),
  single: jest.fn(),
  rpc: jest.fn().mockResolvedValue({ data: true, error: null }),
})

function resolveEqQuery(
  mockSupabase: ReturnType<typeof createMockSupabase>,
  data: unknown,
  error: Error | null = null
) {
  mockSupabase.eq.mockReturnValueOnce({
    ...mockSupabase,
    then: (resolve: MockResolve<unknown>) => resolve({ data, error }),
  })
}

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
      then: (resolve: MockResolve<unknown>) =>
        resolve({
          data: [{ handle: 'testUser', avatar_url: 'https://example.com/avatar.png' }],
          error: null,
        }),
    })

    const result = await getPosts(mockSupabase as unknown as SupabaseClient)
    expect(result).toHaveLength(1)
    expect(result[0].author_handle).toBe('testUser')
    expect(mockSupabase.is).toHaveBeenCalledWith('deleted_at', null)
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
      then: (resolve: MockResolve<unknown>) =>
        resolve({ data: null, error: new Error('DB Error') }),
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

  test('should deny the row when canonical audience authorization is not explicit', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'post1',
        title: 'Private post',
        content: 'hidden',
        author_id: 'user1',
        author_handle: 'testUser',
        group_id: null,
        created_at: '2024-01-01T00:00:00Z',
        original_post_id: null,
      },
      error: null,
    })
    mockSupabase.rpc.mockResolvedValueOnce({ data: false, error: null })

    await expect(
      getPostById(mockSupabase as unknown as Parameters<typeof getPostById>[0], 'post1', 'viewer1')
    ).resolves.toBeNull()
    expect(mockSupabase.rpc).toHaveBeenCalledWith('can_service_actor_read_post', {
      p_post_id: 'post1',
      p_actor_id: 'viewer1',
    })
    expect(mockSupabase.in).not.toHaveBeenCalled()
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
  const mockDeleteChain = (result: { data: unknown; error: Error | null }) => {
    const mockSupabase = createMockSupabase()
    mockSupabase.eq.mockReturnValueOnce({
      ...mockSupabase,
      eq: jest.fn().mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({ then: (resolve: MockResolve<unknown>) => resolve(result) }),
      }),
    })
    return mockSupabase
  }

  test('should delete a post and return true', async () => {
    const mockSupabase = mockDeleteChain({ data: [{ id: 'post1' }], error: null })

    await expect(
      deletePost(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    ).resolves.toBe(true)
  })

  test('should return false when no row matched (missing post or wrong author)', async () => {
    const mockSupabase = mockDeleteChain({ data: [], error: null })

    await expect(
      deletePost(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    ).resolves.toBe(false)
  })

  test.each([
    ['null', null],
    ['object', { id: 'post1' }],
    ['wrong id', [{ id: 'post2' }]],
    ['multiple rows', [{ id: 'post1' }, { id: 'post2' }]],
  ])('should fail closed on a %s delete acknowledgement', async (_label, data) => {
    const mockSupabase = mockDeleteChain({ data, error: null })

    await expect(
      deletePost(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    ).resolves.toBe(false)
  })

  test('should throw error on deletion failure', async () => {
    const mockSupabase = mockDeleteChain({ data: null, error: new Error('Delete failed') })

    await expect(
      deletePost(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    ).rejects.toThrow()
  })
})

describe('getUserPostReaction', () => {
  test('should return null when no reaction found', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getUserPostReaction(
      mockSupabase as unknown as SupabaseClient,
      'post1',
      'user1'
    )
    expect(result).toBeNull()
  })

  test('should return reaction type when found', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { reaction_type: 'up' }, error: null })

    const result = await getUserPostReaction(
      mockSupabase as unknown as SupabaseClient,
      'post1',
      'user1'
    )
    expect(result).toBe('up')
  })

  test('should surface a reaction database failure instead of publishing null', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: new Error('reaction read failed'),
    })

    await expect(
      getUserPostReaction(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    ).rejects.toThrow('reaction read failed')
  })

  test.each([
    ['invalid enum', { reaction_type: 'sideways' }],
    ['extra field', { reaction_type: 'up', user_id: 'user1' }],
    ['missing data acknowledgement', undefined],
  ])('should fail closed for %s', async (_label, data) => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data, error: null })

    await expect(
      getUserPostReaction(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    ).rejects.toThrow('invalid data')
  })
})

describe('togglePostReaction', () => {
  test('should add new reaction via RPC', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.rpc.mockResolvedValueOnce({
      data: {
        status: 'added',
        action: 'added',
        reaction: 'up',
        like_count: 1,
        dislike_count: 0,
      },
      error: null,
    })

    const result = await togglePostReaction(
      mockSupabase as unknown as SupabaseClient,
      'post1',
      'user1',
      'up'
    )
    expect(mockSupabase.rpc).toHaveBeenCalledWith('toggle_post_reaction', {
      p_post_id: 'post1',
      p_user_id: 'user1',
      p_reaction_type: 'up',
    })
    expect(result.action).toBe('added')
    expect(result.reaction).toBe('up')
  })

  test('should remove existing same reaction via RPC', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.rpc.mockResolvedValueOnce({
      data: {
        status: 'removed',
        action: 'removed',
        reaction: null,
        like_count: 0,
        dislike_count: 0,
      },
      error: null,
    })

    const result = await togglePostReaction(
      mockSupabase as unknown as SupabaseClient,
      'post1',
      'user1',
      'up'
    )
    expect(result.action).toBe('removed')
    expect(result.reaction).toBeNull()
  })

  test('should change reaction type via RPC', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.rpc.mockResolvedValueOnce({
      data: {
        status: 'changed',
        action: 'changed',
        reaction: 'down',
        like_count: 0,
        dislike_count: 1,
      },
      error: null,
    })

    const result = await togglePostReaction(
      mockSupabase as unknown as SupabaseClient,
      'post1',
      'user1',
      'down'
    )
    expect(result.action).toBe('changed')
    expect(result.reaction).toBe('down')
  })

  test('should throw on RPC error', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.rpc.mockResolvedValueOnce({
      data: null,
      error: new Error('RPC failed'),
    })

    await expect(
      togglePostReaction(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'up')
    ).rejects.toThrow('RPC failed')
  })

  test.each([
    null,
    { status: 'unexpected' },
    { status: 'added', action: 'added', reaction: 'down', like_count: 1, dislike_count: 0 },
    { status: 'added', action: 'added', reaction: 'up', like_count: -1, dislike_count: 0 },
    {
      status: 'added',
      action: 'added',
      reaction: 'up',
      like_count: 1,
      dislike_count: 0,
      actor_id: 'user1',
    },
  ])('fails closed for malformed reaction acknowledgement %#', async (data) => {
    const mockSupabase = createMockSupabase()
    mockSupabase.rpc.mockResolvedValueOnce({ data, error: null })

    await expect(
      togglePostReaction(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'up')
    ).rejects.toThrow('invalid acknowledgement')
  })

  test('surfaces a canonical audience denial without accepting an acknowledgement', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.rpc.mockResolvedValueOnce({ data: { status: 'not_found' }, error: null })

    await expect(
      togglePostReaction(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'up')
    ).rejects.toMatchObject({ kind: 'not_found' })
  })
})

describe('setPostReactionDesiredState', () => {
  test.each([
    ['adds', 'up', 'added', 'up', 1, 0],
    ['changes', 'down', 'changed', 'down', 0, 1],
    ['removes', null, 'removed', null, 0, 0],
    ['replays without toggling', 'up', 'unchanged', 'up', 2, 0],
    ['replays absence without adding', null, 'unchanged', null, 2, 1],
  ] as const)(
    '%s the absolute reaction state',
    async (_label, desiredReaction, action, reaction, likeCount, dislikeCount) => {
      const mockSupabase = createMockSupabase()
      mockSupabase.rpc.mockResolvedValueOnce({
        data: {
          status: action,
          action,
          reaction,
          like_count: likeCount,
          dislike_count: dislikeCount,
        },
        error: null,
      })

      await expect(
        setPostReactionDesiredState(
          mockSupabase as unknown as SupabaseClient,
          'post1',
          'user1',
          desiredReaction
        )
      ).resolves.toEqual({
        action,
        reaction,
        like_count: likeCount,
        dislike_count: dislikeCount,
      })
      expect(mockSupabase.rpc).toHaveBeenCalledWith('set_post_reaction_desired_state_atomic', {
        p_actor_id: 'user1',
        p_post_id: 'post1',
        p_desired_reaction: desiredReaction,
      })
    }
  )

  test.each([
    null,
    { status: 'not_found', invented: true },
    { status: 'invalid', action: 'unchanged' },
    {
      status: 'removed',
      action: 'removed',
      reaction: 'up',
      like_count: 1,
      dislike_count: 0,
    },
    {
      status: 'added',
      action: 'added',
      reaction: null,
      like_count: 0,
      dislike_count: 0,
    },
    {
      status: 'unchanged',
      action: 'unchanged',
      reaction: 'up',
      like_count: 0,
      dislike_count: 0,
    },
    {
      status: 'unchanged',
      action: 'unchanged',
      reaction: 'up',
      like_count: 1,
      dislike_count: 0,
      actor_id: 'user1',
    },
  ])('fails closed for malformed desired-state acknowledgement %#', async (data) => {
    const mockSupabase = createMockSupabase()
    mockSupabase.rpc.mockResolvedValueOnce({ data, error: null })

    await expect(
      setPostReactionDesiredState(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'up')
    ).rejects.toMatchObject({ kind: 'invalid_ack' })
  })

  test.each(['not_found', 'invalid'] as const)(
    'surfaces the exact %s failure acknowledgement',
    async (status) => {
      const mockSupabase = createMockSupabase()
      mockSupabase.rpc.mockResolvedValueOnce({ data: { status }, error: null })

      await expect(
        setPostReactionDesiredState(
          mockSupabase as unknown as SupabaseClient,
          'post1',
          'user1',
          'up'
        )
      ).rejects.toMatchObject({ kind: status })
    }
  )
})

describe('getUserPostVote', () => {
  test('should return null when no vote found', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getUserPostVote(
      mockSupabase as unknown as SupabaseClient,
      'post1',
      'user1'
    )
    expect(result).toBeNull()
  })

  test('should return vote choice when found', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { choice: 'bull' }, error: null })

    const result = await getUserPostVote(
      mockSupabase as unknown as SupabaseClient,
      'post1',
      'user1'
    )
    expect(result).toBe('bull')
  })

  test('should surface a vote database failure instead of publishing null', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: new Error('vote read failed'),
    })

    await expect(
      getUserPostVote(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    ).rejects.toThrow('vote read failed')
  })

  test.each([
    ['invalid enum', { choice: 'maybe' }],
    ['extra field', { choice: 'bull', user_id: 'user1' }],
    ['missing data acknowledgement', undefined],
  ])('should fail closed for %s', async (_label, data) => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data, error: null })

    await expect(
      getUserPostVote(mockSupabase as unknown as SupabaseClient, 'post1', 'user1')
    ).rejects.toThrow('invalid data')
  })
})

describe('togglePostVote', () => {
  test('should add new vote through the atomic RPC', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.rpc.mockResolvedValueOnce({
      data: {
        status: 'added',
        action: 'added',
        vote: 'bull',
        poll: { bull: 1, bear: 0, wait: 0 },
      },
      error: null,
    })

    const result = await togglePostVote(
      mockSupabase as unknown as SupabaseClient,
      'post1',
      'user1',
      'bull'
    )
    expect(mockSupabase.rpc).toHaveBeenCalledWith('toggle_post_vote_atomic', {
      p_actor_id: 'user1',
      p_post_id: 'post1',
      p_choice: 'bull',
    })
    expect(result.action).toBe('added')
    expect(result.vote).toBe('bull')
    expect(result.poll).toEqual({ bull: 1, bear: 0, wait: 0 })
  })

  test('should remove an existing same vote through the atomic RPC', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.rpc.mockResolvedValueOnce({
      data: {
        status: 'removed',
        action: 'removed',
        vote: null,
        poll: { bull: 0, bear: 0, wait: 0 },
      },
      error: null,
    })

    const result = await togglePostVote(
      mockSupabase as unknown as SupabaseClient,
      'post1',
      'user1',
      'bull'
    )
    expect(result.action).toBe('removed')
    expect(result.vote).toBeNull()
  })

  test.each([
    null,
    { status: 'unexpected' },
    {
      status: 'added',
      action: 'added',
      vote: 'bear',
      poll: { bull: 1, bear: 0, wait: 0 },
    },
    {
      status: 'added',
      action: 'added',
      vote: 'bull',
      poll: { bull: -1, bear: 0, wait: 0 },
    },
  ])('fails closed for malformed vote acknowledgement %#', async (data) => {
    const mockSupabase = createMockSupabase()
    mockSupabase.rpc.mockResolvedValueOnce({ data, error: null })

    await expect(
      togglePostVote(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'bull')
    ).rejects.toThrow('invalid acknowledgement')
  })

  test('surfaces a canonical vote audience denial', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.rpc.mockResolvedValueOnce({ data: { status: 'not_found' }, error: null })

    await expect(
      togglePostVote(mockSupabase as unknown as SupabaseClient, 'post1', 'user1', 'bull')
    ).rejects.toMatchObject({ kind: 'not_found' })
  })
})

describe('getUserPostReactions', () => {
  test('should return map of user reactions', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.eq.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) =>
        resolve({
          data: [
            { post_id: 'post1', reaction_type: 'up' },
            { post_id: 'post2', reaction_type: 'down' },
          ],
          error: null,
        }),
    })

    const result = await getUserPostReactions(
      mockSupabase as unknown as SupabaseClient,
      ['post1', 'post2'],
      'user1'
    )
    expect(result.get('post1')).toBe('up')
    expect(result.get('post2')).toBe('down')
  })

  test('skips the database for an empty post set', async () => {
    const mockSupabase = createMockSupabase()

    await expect(
      getUserPostReactions(mockSupabase as unknown as SupabaseClient, [], 'user1')
    ).resolves.toEqual(new Map())
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  test('surfaces a batch reaction database failure', async () => {
    const mockSupabase = createMockSupabase()
    resolveEqQuery(mockSupabase, null, new Error('batch reaction read failed'))

    await expect(
      getUserPostReactions(mockSupabase as unknown as SupabaseClient, ['post1'], 'user1')
    ).rejects.toThrow('batch reaction read failed')
  })

  test.each([
    ['null data', null],
    ['invalid enum', [{ post_id: 'post1', reaction_type: 'sideways' }]],
    ['unrequested row', [{ post_id: 'post2', reaction_type: 'up' }]],
    [
      'duplicate row',
      [
        { post_id: 'post1', reaction_type: 'up' },
        { post_id: 'post1', reaction_type: 'up' },
      ],
    ],
    ['extra field', [{ post_id: 'post1', reaction_type: 'up', user_id: 'user1' }]],
  ])('fails closed for %s', async (_label, data) => {
    const mockSupabase = createMockSupabase()
    resolveEqQuery(mockSupabase, data)

    await expect(
      getUserPostReactions(mockSupabase as unknown as SupabaseClient, ['post1'], 'user1')
    ).rejects.toThrow('invalid data')
  })
})

describe('getUserPostVotes', () => {
  test('should return map of user votes', async () => {
    const mockSupabase = createMockSupabase()

    mockSupabase.eq.mockReturnValueOnce({
      ...mockSupabase,
      then: (resolve: MockResolve<unknown>) =>
        resolve({
          data: [
            { post_id: 'post1', choice: 'bull' },
            { post_id: 'post2', choice: 'bear' },
          ],
          error: null,
        }),
    })

    const result = await getUserPostVotes(
      mockSupabase as unknown as SupabaseClient,
      ['post1', 'post2'],
      'user1'
    )
    expect(result.get('post1')).toBe('bull')
    expect(result.get('post2')).toBe('bear')
  })

  test('surfaces a batch vote database failure', async () => {
    const mockSupabase = createMockSupabase()
    resolveEqQuery(mockSupabase, null, new Error('batch vote read failed'))

    await expect(
      getUserPostVotes(mockSupabase as unknown as SupabaseClient, ['post1'], 'user1')
    ).rejects.toThrow('batch vote read failed')
  })

  test.each([
    ['null data', null],
    ['invalid enum', [{ post_id: 'post1', choice: 'maybe' }]],
    ['unrequested row', [{ post_id: 'post2', choice: 'bull' }]],
    [
      'duplicate row',
      [
        { post_id: 'post1', choice: 'bull' },
        { post_id: 'post1', choice: 'bull' },
      ],
    ],
    ['extra field', [{ post_id: 'post1', choice: 'bull', user_id: 'user1' }]],
  ])('fails closed for %s', async (_label, data) => {
    const mockSupabase = createMockSupabase()
    resolveEqQuery(mockSupabase, data)

    await expect(
      getUserPostVotes(mockSupabase as unknown as SupabaseClient, ['post1'], 'user1')
    ).rejects.toThrow('invalid data')
  })
})
