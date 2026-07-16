/**
 * postStore — 帖子/评论的唯一权威缓存。
 * LRU 驱逐、server-ACK-only 更新原则、评论去重/计数联动、分页守卫。
 */

const mockFetchPostCommentsPage = jest.fn()
const mockAuthedFetch = jest.fn()

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))
jest.mock('@/lib/api/comments-client', () => ({
  fetchPostCommentsPage: (...args: unknown[]) => mockFetchPostCommentsPage(...args),
  isCreatedCommentAcknowledgement: (value: Record<string, unknown>, expected: { postId: string }) =>
    value?.post_id === expected.postId && typeof value?.id === 'string',
  isDefinitiveMutationRejection: ({ ok, status }: { ok: boolean; status: number }) =>
    !ok && status >= 400 && status < 500 && status !== 408,
}))
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }))

import {
  usePostStore,
  loadPostForViewer,
  loadPostComments,
  loadMorePostComments,
  submitPostComment,
  togglePostReaction,
  type PostData,
  type CommentData,
} from '../postStore'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  __resetViewerScopeForTests()
  usePostStore.getState().clear()
  mockAuthedFetch.mockReset()
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

describe('viewer-scoped cache ownership', () => {
  const scopeA = {
    viewerKey: 'user:user-a',
    sessionGeneration: 1,
    userId: 'user-a',
  }
  const scopeB = {
    viewerKey: 'user:user-b',
    sessionGeneration: 2,
    userId: 'user-b',
  }

  const activateA = () => synchronizeViewerScope(true, 'user-a')
  const activateBFromPending = () => {
    synchronizeViewerScope(true, null)
    return synchronizeViewerScope(true, 'user-b')
  }

  it('inherits the live viewer when the store module is imported after authentication', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolatedViewerScope =
        require('@/lib/auth/viewer-scope') as typeof import('@/lib/auth/viewer-scope')
      isolatedViewerScope.__resetViewerScopeForTests()
      const liveScope = isolatedViewerScope.synchronizeViewerScope(true, 'late-user')

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolatedPostStore = require('../postStore') as typeof import('../postStore')

      expect(isolatedPostStore.usePostStore.getState()).toMatchObject({
        viewerKey: liveScope.viewerKey,
        sessionGeneration: liveScope.sessionGeneration,
      })
    })
  })

  it('atomically clears posts, comments, and pagination when A changes to B', () => {
    const store = usePostStore.getState()
    activateA()
    store.setPost(post('p1', { user_reaction: 'up' }))
    store.setComments('p1', [comment('a-private', { user_liked: true })])
    store.setCommentsPagination('p1', { offset: 1 })

    synchronizeViewerScope(true, 'user-b')

    expect(usePostStore.getState()).toMatchObject({
      viewerKey: scopeB.viewerKey,
      sessionGeneration: scopeB.sessionGeneration,
      posts: {},
      postsRevision: {},
      comments: {},
      commentsPagination: {},
      commentsRevision: {},
    })
  })

  it('does not let an A GET overwrite a same-post B reload', async () => {
    const requests = new Map<string, (value: unknown) => void>()
    mockFetchPostCommentsPage.mockImplementation(
      (_postId: string, token: string) =>
        new Promise((resolve) => {
          requests.set(token, resolve)
        })
    )
    activateA()
    const loadA = loadPostComments('p1', 'token-a', scopeA)

    synchronizeViewerScope(true, 'user-b')
    const loadB = loadPostComments('p1', 'token-b', scopeB)
    requests.get('token-b')?.({
      ok: true,
      status: 200,
      comments: [comment('comment-b')],
      commentCount: 1,
      hasMore: false,
    })
    await loadB
    requests.get('token-a')?.({
      ok: true,
      status: 200,
      comments: [comment('comment-a')],
      commentCount: 1,
      hasMore: false,
    })
    await loadA

    expect(usePostStore.getState().comments.p1.map((item) => item.id)).toEqual(['comment-b'])
  })

  it('clears A synchronously at transition start and rejects its pre-effect response', async () => {
    activateA()
    usePostStore.getState().setComments('p1', [comment('a-private')])
    const response = deferred<unknown>()
    mockFetchPostCommentsPage.mockReturnValue(response.promise)
    const loading = loadPostComments('p1', 'token-a', scopeA)

    beginViewerTransition('user-b')

    expect(usePostStore.getState()).toMatchObject({
      viewerKey: 'pending',
      comments: {},
      posts: {},
    })
    response.resolve({
      ok: true,
      status: 200,
      comments: [comment('late-a')],
      commentCount: 1,
      hasMore: false,
    })
    await loading
    expect(usePostStore.getState().comments).toEqual({})
  })

  it('rehydrates the same post ID after a scope clear', async () => {
    activateBFromPending()
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: { post: post('p1', { title: 'B post', user_reaction: 'down' }) },
      },
    })

    await expect(loadPostForViewer('p1', 'token-b', scopeB)).resolves.toBe(true)

    expect(usePostStore.getState().posts.p1).toMatchObject({
      title: 'B post',
      user_reaction: 'down',
    })
  })

  it('does not let an older post hydration overwrite a newer mutation revision', async () => {
    activateA()
    const hydration = deferred<unknown>()
    mockAuthedFetch.mockReturnValueOnce(hydration.promise)
    const loading = loadPostForViewer('p1', 'token-a', scopeA)

    usePostStore.getState().setPost(post('p1', { like_count: 9, user_reaction: 'up' }))
    hydration.resolve({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: { post: post('p1', { like_count: 1, user_reaction: null }) },
      },
    })

    await expect(loading).resolves.toBe(false)
    expect(usePostStore.getState().posts.p1).toMatchObject({
      like_count: 9,
      user_reaction: 'up',
    })
  })

  it('preserves the same-A tree when a refreshed-token read fails', async () => {
    activateA()
    usePostStore.getState().setComments('p1', [comment('existing-a')])
    mockFetchPostCommentsPage.mockResolvedValue({
      ok: false,
      status: 503,
      comments: [],
      commentCount: 0,
      hasMore: false,
    })

    await loadPostComments('p1', 'token-a2', scopeA)

    expect(usePostStore.getState().comments.p1.map((item) => item.id)).toEqual(['existing-a'])
  })

  it('ignores an A create ACK after logout clears the store', async () => {
    activateA()
    let resolveSubmit!: (value: unknown) => void
    mockAuthedFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve
      })
    )
    const submission = submitPostComment('p1', 'hello', 'token-a', scopeA)

    synchronizeViewerScope(true, null)
    resolveSubmit({
      ok: true,
      status: 201,
      data: {
        success: true,
        data: {
          comment: {
            ...comment('comment-a', { content: 'hello', user_id: 'user-a' }),
            post_id: 'p1',
          },
        },
      },
    })

    await expect(submission).resolves.toEqual({ error: 'STALE_AUTH_SCOPE' })
    expect(usePostStore.getState().comments).toEqual({})
  })

  it('does not append an ACK when a newer tree revision wins reconciliation', async () => {
    activateA()
    usePostStore.getState().setComments('p1', [comment('before')])
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        success: true,
        data: {
          comment: {
            ...comment('created', { user_id: 'user-a' }),
            post_id: 'p1',
          },
        },
      },
    })
    const firstCanonical = deferred<unknown>()
    mockFetchPostCommentsPage.mockReturnValueOnce(firstCanonical.promise).mockResolvedValueOnce({
      ok: true,
      status: 200,
      comments: [comment('newer-realtime')],
      commentCount: 1,
      hasMore: false,
    })

    const submission = submitPostComment('p1', 'hello', 'token-a', scopeA)
    while (mockFetchPostCommentsPage.mock.calls.length < 1) await Promise.resolve()
    usePostStore.getState().setComments('p1', [comment('newer-realtime')])
    firstCanonical.resolve({
      ok: true,
      status: 200,
      comments: [comment('created')],
      commentCount: 1,
      hasMore: false,
    })

    await submission

    expect(usePostStore.getState().comments.p1.map((item) => item.id)).toEqual(['newer-realtime'])
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

  it('bounds repeated revision conflicts to the initial read plus one retry', async () => {
    let mutation = 0
    mockFetchPostCommentsPage.mockImplementation(async () => {
      mutation += 1
      usePostStore.getState().setComments('p1', [comment(`newer-${mutation}`)])
      return {
        ok: true,
        status: 200,
        comments: [comment(`stale-${mutation}`)],
        commentCount: mutation,
        hasMore: false,
      }
    })

    await loadPostComments('p1')

    expect(mockFetchPostCommentsPage).toHaveBeenCalledTimes(2)
    expect(usePostStore.getState().comments.p1.map((item) => item.id)).toEqual(['newer-2'])
    expect(usePostStore.getState().commentsPagination.p1.loading).toBe(false)
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
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        success: true,
        data: {
          comment: {
            ...comment('new1', { content: 'hello', user_id: 'user-1' }),
            post_id: 'p1',
            updated_at: '2026-07-03T00:00:00Z',
            dislike_count: 0,
          },
        },
      },
    })
    const r = await submitPostComment('p1', 'hello', 'tok-123')
    expect('comment' in r).toBe(true)
    expect(usePostStore.getState().comments['p1'].map((c) => c.id)).toContain('new1')
    expect(usePostStore.getState().posts['p1'].comment_count).toBe(1)
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/posts/p1/comments',
      'POST',
      'tok-123',
      { content: 'hello' },
      15_000,
      { expectedUserId: null, expectedSessionGeneration: 0 }
    )
  })

  it('提交失败 → 返回 error,store 不动', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status: 400,
      data: { error: 'nope' },
    })
    const r = await submitPostComment('p1', 'hello', 'tok')
    expect(r).toEqual({ error: 'nope' })
    expect(usePostStore.getState().comments['p1']).toBeUndefined()
  })

  it('response lost → authenticated canonical GET reconciles a committed comment and count', async () => {
    usePostStore.getState().setPost(post('p1', { comment_count: 2 }))
    mockAuthedFetch.mockRejectedValue(new Error('lost'))
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
      viewerScope: { expectedUserId: null, expectedSessionGeneration: 0 },
    })
    expect(usePostStore.getState().comments['p1'][0].id).toBe('committed')
    expect(usePostStore.getState().posts['p1'].comment_count).toBe(3)
  })

  it('reaction 成功 → 用 server 确认的计数更新(非乐观)', async () => {
    usePostStore.getState().setPost(post('p1', { like_count: 5 }))
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: { like_count: 6, dislike_count: 0, reaction: 'up' },
      },
    })
    const r = await togglePostReaction('p1', 'up', 'tok')
    expect(r.success).toBe(true)
    expect(usePostStore.getState().posts['p1'].like_count).toBe(6)
  })

  it('reaction 网络抛错 → success:false,不外抛', async () => {
    mockAuthedFetch.mockRejectedValue(new Error('offline'))
    const r = await togglePostReaction('p1', 'up', 'tok')
    expect(r.success).toBe(false)
  })
})
