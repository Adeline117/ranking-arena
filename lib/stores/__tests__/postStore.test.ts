/**
 * postStore — 帖子/评论的唯一权威缓存。
 * LRU 驱逐、server-ACK-only 更新原则、评论去重/计数联动、分页守卫。
 */

const mockFetchPostCommentsPage = jest.fn()

jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({ 'x-csrf-token': 't' }) }))
jest.mock('@/lib/api/comments-client', () => ({
  fetchPostCommentsPage: (...args: unknown[]) => mockFetchPostCommentsPage(...args),
  isCreatedCommentAcknowledgement: (
    value: Record<string, unknown>,
    expected: { postId: string; content: string }
  ) =>
    value?.post_id === expected.postId &&
    value?.content === expected.content &&
    typeof value?.id === 'string',
  isDefinitiveMutationRejection: ({ ok, status }: { ok: boolean; status: number }) =>
    !ok && status >= 400 && status < 500 && status !== 408,
}))
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }))

import {
  usePostStore,
  loadPostComments,
  loadMorePostComments,
  submitPostComment,
  togglePostReaction,
  type PostData,
  type CommentData,
} from '../postStore'

function post(id: string, overrides: Partial<PostData> = {}): PostData {
  return {
    id,
    title: 't',
    content: 'c',
    author_handle: 'h',
    created_at: '2026-07-03T00:00:00Z',
    like_count: 0,
    dislike_count: 0,
    comment_count: 0,
    view_count: 0,
    hot_score: 0,
    ...overrides,
  }
}

function comment(id: string, overrides: Partial<CommentData> = {}): CommentData {
  return { id, content: 'c', author_handle: 'h', created_at: '2026-07-03T00:00:00Z', ...overrides }
}

const mockFetch = jest.fn()
global.fetch = mockFetch as never

beforeEach(() => {
  usePostStore.getState().clear()
  mockFetch.mockReset()
  mockFetchPostCommentsPage.mockReset()
})

describe('post 缓存 + LRU', () => {
  it('setPost 写入,setPosts 批量', () => {
    usePostStore.getState().setPost(post('a'))
    usePostStore.getState().setPosts([post('b'), post('c')])
    expect(Object.keys(usePostStore.getState().posts)).toEqual(['a', 'b', 'c'])
  })

  it('超过 200 条驱逐最旧(防长会话内存膨胀)', () => {
    const many = Array.from({ length: 205 }, (_, i) => post(`p${i}`))
    usePostStore.getState().setPosts(many)
    const keys = Object.keys(usePostStore.getState().posts)
    expect(keys).toHaveLength(200)
    expect(keys).not.toContain('p0') // 最旧被驱逐
    expect(keys).toContain('p204')
  })

  it('updatePostReaction:存在则用 server 数据覆盖,不存在不崩', () => {
    usePostStore.getState().setPost(post('a', { like_count: 5 }))
    usePostStore
      .getState()
      .updatePostReaction('a', { like_count: 6, dislike_count: 1, reaction: 'up' })
    const p = usePostStore.getState().posts['a']
    expect(p.like_count).toBe(6)
    expect(p.user_reaction).toBe('up')
    // 不存在的 post → no-op
    usePostStore
      .getState()
      .updatePostReaction('ghost', { like_count: 1, dislike_count: 0, reaction: null })
    expect(usePostStore.getState().posts['ghost']).toBeUndefined()
  })

  it('updatePostCommentCount 只接受 server 的非负安全整数绝对值', () => {
    usePostStore.getState().setPost(post('a', { comment_count: 5 }))
    usePostStore.getState().updatePostCommentCount('a', 2)
    expect(usePostStore.getState().posts['a'].comment_count).toBe(2)
    usePostStore.getState().updatePostCommentCount('a', -1)
    usePostStore.getState().updatePostCommentCount('a', 1.5)
    expect(usePostStore.getState().posts['a'].comment_count).toBe(2)
  })
})

describe('评论缓存', () => {
  it('appendComments 按 id 去重', () => {
    usePostStore.getState().setComments('p1', [comment('c1'), comment('c2')])
    usePostStore.getState().appendComments('p1', [comment('c2'), comment('c3')])
    expect(usePostStore.getState().comments['p1'].map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('addComment 去重但不猜测 server-owned comment_count', () => {
    usePostStore.getState().setPost(post('p1', { comment_count: 2 }))
    usePostStore.getState().addComment('p1', comment('c1'))
    expect(usePostStore.getState().posts['p1'].comment_count).toBe(2)
    // 重复 add 同 id → no-op
    usePostStore.getState().addComment('p1', comment('c1'))
    expect(usePostStore.getState().comments['p1']).toHaveLength(1)
  })

  it('setCommentsPagination 与默认值合并', () => {
    usePostStore.getState().setCommentsPagination('p1', { loading: true })
    expect(usePostStore.getState().commentsPagination['p1']).toEqual({
      offset: 0,
      hasMore: true,
      loading: true,
      loadingMore: false,
    })
  })

  it('triggerFeedRefresh 递增计数器', () => {
    const before = usePostStore.getState().feedRefreshTrigger
    usePostStore.getState().triggerFeedRefresh()
    expect(usePostStore.getState().feedRefreshTrigger).toBe(before + 1)
  })
})

describe('loadPostComments', () => {
  it('成功 → 带鉴权读取 canonical envelope 后写入评论 + 分页推进', async () => {
    mockFetchPostCommentsPage.mockResolvedValue({
      ok: true,
      status: 200,
      comments: [comment('c1')],
      commentCount: 7,
      hasMore: true,
    })
    await loadPostComments('p1', 'tok-read')
    expect(mockFetchPostCommentsPage).toHaveBeenCalledWith('p1', 'tok-read', {
      limit: 10,
      offset: 0,
    })
    expect(usePostStore.getState().comments['p1']).toHaveLength(1)
    const pg = usePostStore.getState().commentsPagination['p1']
    expect(pg).toMatchObject({ loading: false, offset: 1, hasMore: true })
    expect(usePostStore.getState().posts['p1']).toBeUndefined()
  })

  it('HTTP 失败 → 保留当前评论且只解除 loading', async () => {
    usePostStore.getState().setComments('p1', [comment('existing')])
    mockFetchPostCommentsPage.mockResolvedValue({
      ok: false,
      status: 403,
      comments: [],
      commentCount: 0,
      hasMore: false,
    })
    await loadPostComments('p1')
    expect(mockFetchPostCommentsPage).toHaveBeenCalledWith('p1', null, {
      limit: 10,
      offset: 0,
    })
    expect(usePostStore.getState().comments['p1'].map((item) => item.id)).toEqual(['existing'])
    expect(usePostStore.getState().commentsPagination['p1'].loading).toBe(false)
  })

  it('网络抛错 → 保留当前分页真值并解除 loading', async () => {
    usePostStore.getState().setCommentsPagination('p1', { hasMore: true })
    mockFetchPostCommentsPage.mockRejectedValue(new Error('offline'))
    await expect(loadPostComments('p1')).resolves.toBeUndefined()
    expect(usePostStore.getState().commentsPagination['p1'].hasMore).toBe(true)
    expect(usePostStore.getState().commentsPagination['p1'].loading).toBe(false)
  })
})

describe('loadMorePostComments 守卫', () => {
  it('hasMore=false → 不发请求', async () => {
    usePostStore.getState().setCommentsPagination('p1', { hasMore: false })
    await loadMorePostComments('p1')
    expect(mockFetchPostCommentsPage).not.toHaveBeenCalled()
  })

  it('loadingMore=true(进行中)→ 不重复请求', async () => {
    usePostStore.getState().setCommentsPagination('p1', { loadingMore: true, hasMore: true })
    await loadMorePostComments('p1')
    expect(mockFetchPostCommentsPage).not.toHaveBeenCalled()
  })

  it('正常 → offset 用当前值发请求并推进', async () => {
    usePostStore.getState().setCommentsPagination('p1', { offset: 10, hasMore: true })
    mockFetchPostCommentsPage.mockResolvedValue({
      ok: true,
      status: 200,
      comments: [comment('c9')],
      commentCount: 11,
      hasMore: false,
    })
    await loadMorePostComments('p1', 'tok-more')
    expect(mockFetchPostCommentsPage).toHaveBeenCalledWith('p1', 'tok-more', {
      limit: 10,
      offset: 10,
    })
    expect(usePostStore.getState().commentsPagination['p1']).toMatchObject({
      offset: 11,
      hasMore: false,
    })
  })
})

describe('submitPostComment / togglePostReaction — server-ACK-only', () => {
  it('提交成功 → ACK 后才入 store,带 Bearer + CSRF 头', async () => {
    usePostStore.getState().setPost(post('p1', { comment_count: 0 }))
    mockFetchPostCommentsPage.mockResolvedValue({
      ok: true,
      status: 200,
      comments: [comment('new1', { content: 'hello', user_id: 'user-1' })],
      commentCount: 1,
      hasMore: false,
    })
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            comment: {
              ...comment('new1', { content: 'hello', user_id: 'user-1' }),
              post_id: 'p1',
              updated_at: '2026-07-03T00:00:00Z',
              dislike_count: 0,
            },
          },
        }),
    })
    const r = await submitPostComment('p1', 'hello', 'tok-123')
    expect('comment' in r).toBe(true)
    expect(usePostStore.getState().comments['p1'].map((c) => c.id)).toContain('new1')
    expect(usePostStore.getState().posts['p1'].comment_count).toBe(1)
    const headers = mockFetch.mock.calls[0][1].headers
    expect(headers.Authorization).toBe('Bearer tok-123')
    expect(headers['x-csrf-token']).toBe('t')
  })

  it('提交失败 → 返回 error,store 不动', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'nope' }),
    })
    const r = await submitPostComment('p1', 'hello', 'tok')
    expect(r).toEqual({ error: 'nope' })
    expect(usePostStore.getState().comments['p1']).toBeUndefined()
  })

  it('response lost → authenticated canonical GET reconciles a committed comment and count', async () => {
    usePostStore.getState().setPost(post('p1', { comment_count: 2 }))
    mockFetch.mockRejectedValue(new Error('lost'))
    mockFetchPostCommentsPage.mockResolvedValue({
      ok: true,
      status: 200,
      comments: [comment('committed')],
      commentCount: 3,
      hasMore: false,
    })

    await submitPostComment('p1', 'hello', 'tok')

    expect(mockFetchPostCommentsPage).toHaveBeenCalledWith('p1', 'tok', {
      limit: 10,
      offset: 0,
    })
    expect(usePostStore.getState().comments['p1'][0].id).toBe('committed')
    expect(usePostStore.getState().posts['p1'].comment_count).toBe(3)
  })

  it('reaction 成功 → 用 server 确认的计数更新(非乐观)', async () => {
    usePostStore.getState().setPost(post('p1', { like_count: 5 }))
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { like_count: 6, dislike_count: 0, reaction: 'up' },
        }),
    })
    const r = await togglePostReaction('p1', 'up', 'tok')
    expect(r.success).toBe(true)
    expect(usePostStore.getState().posts['p1'].like_count).toBe(6)
  })

  it('reaction 网络抛错 → success:false,不外抛', async () => {
    mockFetch.mockRejectedValue(new Error('offline'))
    const r = await togglePostReaction('p1', 'up', 'tok')
    expect(r.success).toBe(false)
  })
})
