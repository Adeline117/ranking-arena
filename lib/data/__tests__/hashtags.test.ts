/**
 * hashtags — 标签提取/同步/热门/按标签取帖。
 * 回归锁:HASHTAG_REGEX 曾是 \w(ASCII-only),#比特币 等 CJK 标签被静默丢弃
 * (与 search-sanitize CJK 盲区同款 footgun)。现为 \p{L}\p{N}_ Unicode-aware。
 */

jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }))

import { extractHashtags, getTrendingHashtags, getPostsByHashtag } from '../hashtags'
import type { SupabaseClient } from '@supabase/supabase-js'

describe('extractHashtags', () => {
  it('英文标签提取 + 小写归一 + 去重', () => {
    expect(extractHashtags('Buy #BTC now! #btc #ETH')).toEqual(['btc', 'eth'])
  })

  it('CJK 标签(回归锁:修复前 \\w 提取不到)', () => {
    expect(extractHashtags('看好 #比特币 和 #以太坊')).toEqual(['比特币', '以太坊'])
    expect(extractHashtags('#ビットコイン いいね')).toEqual(['ビットコイン'])
    expect(extractHashtags('#비트코인 좋아요')).toEqual(['비트코인'])
  })

  it('混合中英数字下划线', () => {
    expect(extractHashtags('#BTC合约 #alpha_2026')).toEqual(['btc合约', 'alpha_2026'])
  })

  it('小写后落出持久化字母表的 Unicode token 不进入同步队列', () => {
    expect(extractHashtags('#İ')).toEqual([])
  })

  it('空文本/无标签 → []', () => {
    expect(extractHashtags('')).toEqual([])
    expect(extractHashtags('no tags here')).toEqual([])
  })

  it('超 30 字符的 token 整体拒绝而不是伪造截断标签', () => {
    const long = 'x'.repeat(35)
    expect(extractHashtags(`#${long}`)).toEqual([])
    expect(extractHashtags(`#${'x'.repeat(30)} ok`)).toEqual(['x'.repeat(30)])
  })

  it('# 后跟标点/空格 → 不是标签', () => {
    expect(extractHashtags('# not-a-tag #!bang')).toEqual([])
  })
})

const HASHTAG_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const AUTHOR_ID = '33333333-3333-4333-8333-333333333333'
const ARENA_BOT_ID = '00000000-0000-0000-0000-000000000001'

function rpcClient(result: { data?: unknown; error?: unknown }) {
  const rpc = jest
    .fn()
    .mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  const from = jest.fn(() => {
    throw new Error('hashtag reads must not query raw tables')
  })
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc }
}

function pagePost(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    title: 'Public post',
    content: '#btc',
    author_id: AUTHOR_ID,
    author_handle: 'alice',
    author_avatar_url: null,
    author_is_verified: false,
    group_id: null,
    poll_enabled: false,
    poll_id: null,
    poll_bull: 0,
    poll_bear: 0,
    poll_wait: 0,
    like_count: 2,
    dislike_count: 0,
    comment_count: 1,
    bookmark_count: 0,
    repost_count: 0,
    view_count: 4,
    hot_score: 2.5,
    is_pinned: false,
    images: null,
    created_at: '2026-08-03T20:00:00.000Z',
    updated_at: '2026-08-03T20:00:00.000Z',
    original_post_id: null,
    visibility: 'public',
    is_sensitive: false,
    content_warning: null,
    language: 'en',
    user_reaction: null,
    user_vote: null,
    ...overrides,
  }
}

function pageAcknowledgement(
  overrides: Record<string, unknown> = {},
  requestOverrides: Record<string, unknown> = {}
) {
  return {
    contract: 'hashtag_posts_page_v1',
    viewer_state: 'anonymous',
    request: {
      viewer_id: null,
      tag: 'btc',
      limit: 20,
      offset: 0,
      sort_by: 'created_at',
      ...requestOverrides,
    },
    posts: [pagePost()],
    total: 1,
    has_more: false,
    next_cursor: null,
    ...overrides,
  }
}

describe('getTrendingHashtags', () => {
  it('只消费匿名可读 RPC 的精确 ACK', async () => {
    const queried = rpcClient({
      data: {
        contract: 'hashtag_trending_v1',
        viewer_id: null,
        limit: 20,
        hashtags: [{ id: HASHTAG_ID, tag: 'btc', post_count: 5 }],
      },
    })

    await expect(getTrendingHashtags(queried.client)).resolves.toEqual([
      { id: HASHTAG_ID, tag: 'btc', post_count: 5 },
    ])
    expect(queried.rpc).toHaveBeenCalledWith('get_trending_hashtags_public', { p_limit: 20 })
    expect(queried.from).not.toHaveBeenCalled()
  })

  it('RPC 失败或 ACK 漂移时失败关闭', async () => {
    const failed = rpcClient({ error: { message: 'database unavailable' } })
    await expect(getTrendingHashtags(failed.client)).rejects.toEqual({
      message: 'database unavailable',
    })

    const mismatched = rpcClient({
      data: {
        contract: 'hashtag_trending_v1',
        viewer_id: 'not-anonymous',
        limit: 20,
        hashtags: [],
      },
    })
    await expect(getTrendingHashtags(mismatched.client)).rejects.toThrow(
      'Invalid trending hashtag acknowledgement'
    )
  })

  it('拒绝 raw 计数为零、重复标签或额外内部字段', async () => {
    for (const hashtags of [
      [{ id: HASHTAG_ID, tag: 'btc', post_count: 0 }],
      [
        { id: HASHTAG_ID, tag: 'btc', post_count: 1 },
        { id: '44444444-4444-4444-8444-444444444444', tag: 'btc', post_count: 1 },
      ],
      [{ id: HASHTAG_ID, tag: 'btc', post_count: 1, raw_post_count: 99 }],
    ]) {
      const queried = rpcClient({
        data: {
          contract: 'hashtag_trending_v1',
          viewer_id: null,
          limit: 20,
          hashtags,
        },
      })
      await expect(getTrendingHashtags(queried.client)).rejects.toThrow(
        'Invalid trending hashtag row'
      )
    }
  })

  it('拒绝超过 limit 或不符合 count/tag/id 全序的 ACK', async () => {
    const tooMany = rpcClient({
      data: {
        contract: 'hashtag_trending_v1',
        viewer_id: null,
        limit: 1,
        hashtags: [
          { id: HASHTAG_ID, tag: 'btc', post_count: 2 },
          { id: '44444444-4444-4444-8444-444444444444', tag: 'eth', post_count: 1 },
        ],
      },
    })
    await expect(getTrendingHashtags(tooMany.client, 1)).rejects.toThrow(
      'Invalid trending hashtag acknowledgement'
    )

    const reversed = rpcClient({
      data: {
        contract: 'hashtag_trending_v1',
        viewer_id: null,
        limit: 20,
        hashtags: [
          { id: HASHTAG_ID, tag: 'btc', post_count: 1 },
          { id: '44444444-4444-4444-8444-444444444444', tag: 'ada', post_count: 1 },
        ],
      },
    })
    await expect(getTrendingHashtags(reversed.client)).rejects.toThrow(
      'Invalid trending hashtag ordering'
    )
  })
})

describe('getPostsByHashtag', () => {
  it('标签不存在由同快照 ACK 返回空结果', async () => {
    const queried = rpcClient({
      data: pageAcknowledgement({ posts: [], total: 0, has_more: false }),
    })
    await expect(getPostsByHashtag(queried.client, 'BTC')).resolves.toEqual({
      posts: [],
      tag: 'btc',
      total: 0,
      has_more: false,
      next_cursor: null,
    })
  })

  it('回显 viewer/标签/分页身份并提供兼容 author 形状', async () => {
    const queried = rpcClient({
      data: pageAcknowledgement(
        {
          viewer_state: 'active',
          posts: [pagePost({ user_reaction: 'up', user_vote: 'bull' })],
          total: 4,
        },
        {
          viewer_id: AUTHOR_ID,
          tag: 'btc',
          limit: 10,
          offset: 3,
          sort_by: 'hot_score',
        }
      ),
    })
    const result = await getPostsByHashtag(queried.client, ' BTC ', {
      viewer_id: AUTHOR_ID,
      limit: 10,
      offset: 3,
      sort_by: 'hot_score',
    })
    expect(result.posts[0].author).toEqual({
      id: AUTHOR_ID,
      handle: 'alice',
      avatar_url: null,
    })
    expect(result.posts[0]).toMatchObject({ user_reaction: 'up', user_vote: 'bull' })
    expect(queried.rpc).toHaveBeenCalledWith('get_hashtag_posts_page', {
      p_viewer_id: AUTHOR_ID,
      p_tag: 'btc',
      p_limit: 10,
      p_offset: 3,
      p_sort_by: 'hot_score',
    })
    expect(queried.from).not.toHaveBeenCalled()
  })

  it('匿名页明确返回空用户状态且不读取交互表', async () => {
    const queried = rpcClient({ data: pageAcknowledgement() })

    const result = await getPostsByHashtag(queried.client, 'btc')

    expect(result.posts[0]).toMatchObject({ user_reaction: null, user_vote: null })
    expect(queried.from).not.toHaveBeenCalled()
  })

  it('接受 PostgreSQL 合法的固定系统 UUID，而不强加生成版本位', async () => {
    const queried = rpcClient({
      data: pageAcknowledgement({ posts: [pagePost({ author_id: ARENA_BOT_ID })] }),
    })

    await expect(getPostsByHashtag(queried.client, 'btc')).resolves.toMatchObject({
      posts: [{ author_id: ARENA_BOT_ID, author: { id: ARENA_BOT_ID } }],
    })
  })

  it('数据库在同一快照拒绝失效 viewer 时抛出专用身份错误', async () => {
    const queried = rpcClient({
      data: pageAcknowledgement(
        { viewer_state: 'invalid', posts: [], total: 0, has_more: false },
        { viewer_id: AUTHOR_ID }
      ),
    })

    await expect(
      getPostsByHashtag(queried.client, 'btc', { viewer_id: AUTHOR_ID })
    ).rejects.toMatchObject({ name: 'HashtagViewerRejectedError' })
    expect(queried.from).not.toHaveBeenCalled()
  })

  it('RPC 用户状态枚举或字段漂移时失败关闭', async () => {
    for (const post of [
      pagePost({ user_reaction: 'rocket' }),
      pagePost({ user_vote: 'maybe' }),
      pagePost({ user_reaction: null, interaction_internal_id: 'secret' }),
    ]) {
      const queried = rpcClient({ data: pageAcknowledgement({ posts: [post] }) })
      await expect(getPostsByHashtag(queried.client, 'btc')).rejects.toThrow(
        'Invalid hashtag post row'
      )
    }
  })

  it('拒绝错 viewer、矛盾 total/has_more 与内部帖子字段', async () => {
    const newerPostId = '55555555-5555-4555-8555-555555555555'
    const cases = [
      pageAcknowledgement({}, { viewer_id: AUTHOR_ID }),
      pageAcknowledgement({}, { tag: 'eth' }),
      pageAcknowledgement({}, { limit: 19 }),
      pageAcknowledgement({}, { offset: 1 }),
      pageAcknowledgement({}, { sort_by: 'hot_score' }),
      pageAcknowledgement({ viewer_state: 'active' }),
      pageAcknowledgement({ viewer_state: 'invalid', posts: [] }),
      pageAcknowledgement({ total: 2, has_more: false }),
      pageAcknowledgement({ posts: [pagePost({ report_count: 8 })] }),
      pageAcknowledgement({ posts: [pagePost(), pagePost()], total: 2 }),
      pageAcknowledgement({
        posts: [pagePost(), pagePost({ id: newerPostId, created_at: '2026-08-04T20:00:00.000Z' })],
        total: 2,
      }),
    ]
    for (const data of cases) {
      const queried = rpcClient({ data })
      await expect(getPostsByHashtag(queried.client, 'btc')).rejects.toThrow(/Invalid|Inconsistent/)
    }
  })

  it('严格验证 hot_score 的 NULLS LAST 与 created_at/id 全序', async () => {
    const secondPostId = '11111111-1111-4111-8111-111111111112'
    const valid = rpcClient({
      data: pageAcknowledgement(
        {
          posts: [
            pagePost({ hot_score: 1 }),
            pagePost({
              id: secondPostId,
              hot_score: null,
              created_at: '2026-08-03T19:00:00.000Z',
            }),
          ],
          total: 2,
        },
        { limit: 2, sort_by: 'hot_score' }
      ),
    })
    await expect(
      getPostsByHashtag(valid.client, 'btc', { limit: 2, sort_by: 'hot_score' })
    ).resolves.toMatchObject({ posts: [{ hot_score: 1 }, { hot_score: null }] })

    const invalid = rpcClient({
      data: pageAcknowledgement(
        {
          posts: [pagePost({ hot_score: null }), pagePost({ id: secondPostId, hot_score: 1 })],
          total: 2,
        },
        { limit: 2, sort_by: 'hot_score' }
      ),
    })
    await expect(
      getPostsByHashtag(invalid.client, 'btc', { limit: 2, sort_by: 'hot_score' })
    ).rejects.toThrow('Invalid hashtag post ordering')
  })

  it('RPC 失败和非法调用参数均失败关闭', async () => {
    const failed = rpcClient({ error: { message: 'authorization dependency failed' } })
    await expect(getPostsByHashtag(failed.client, 'btc')).rejects.toEqual({
      message: 'authorization dependency failed',
    })
    await expect(getPostsByHashtag(failed.client, 'bad tag!')).rejects.toThrow('Invalid hashtag')
    await expect(
      getPostsByHashtag(failed.client, 'btc', { viewer_id: 'forged-viewer' })
    ).rejects.toThrow('Invalid hashtag viewer identity')
    await expect(getPostsByHashtag(failed.client, 'btc', { offset: 10_001 })).rejects.toThrow(
      'Hashtag offset must be an integer between 0 and 10000'
    )
    expect(failed.rpc).toHaveBeenCalledTimes(1)
  })
})
