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

  it('空文本/无标签 → []', () => {
    expect(extractHashtags('')).toEqual([])
    expect(extractHashtags('no tags here')).toEqual([])
  })

  it('超 30 字符截断在 30(regex 上限)', () => {
    const long = 'x'.repeat(35)
    const [tag] = extractHashtags(`#${long}`)
    expect(tag).toHaveLength(30)
  })

  it('# 后跟标点/空格 → 不是标签', () => {
    expect(extractHashtags('# not-a-tag #!bang')).toEqual([])
  })
})

/** 队列式 mock(路由按表名) */
function queueClient(
  queues: Record<string, Array<{ data?: unknown; error?: unknown; count?: number }>>
) {
  const rpc = jest.fn((functionName: string) =>
    Promise.resolve({
      data: functionName === 'can_service_actor_read_post' ? true : null,
      error: null,
    })
  )
  const from = jest.fn((table: string) => {
    const q = queues[table] ?? []
    const resp = q.length > 1 ? q.shift()! : (q[0] ?? { data: [] })
    const p = Promise.resolve({
      data: resp.data ?? null,
      error: resp.error ?? null,
      count: resp.count,
    })
    const obj: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'gt', 'order', 'upsert', 'range']) obj[m] = () => obj
    obj.limit = () => p
    obj.maybeSingle = () => p
    obj.then = (...args: Parameters<Promise<unknown>['then']>) => p.then(...args)
    return obj
  })
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc }
}

describe('getTrendingHashtags', () => {
  it('返回数据;error → []', async () => {
    const ok = queueClient({ hashtags: [{ data: [{ id: '1', tag: 'btc', post_count: 5 }] }] })
    expect(await getTrendingHashtags(ok.client)).toHaveLength(1)
    const bad = queueClient({ hashtags: [{ data: null, error: { message: 'x' } }] })
    expect(await getTrendingHashtags(bad.client)).toEqual([])
  })
})

describe('getPostsByHashtag', () => {
  it('标签不存在 → 空结果', async () => {
    const { client } = queueClient({ hashtags: [{ data: null }] })
    expect(await getPostsByHashtag(client, 'ghost')).toEqual({
      posts: [],
      total: 0,
      has_more: false,
    })
  })

  it('输入标签被 lowercase 后查询(与提取归一一致)', async () => {
    const { client } = queueClient({
      hashtags: [{ data: { id: 'h1' } }],
      posts: [
        {
          data: [
            {
              id: 'p1',
              author_id: 'u1',
              title: 't',
              post_hashtags: [{ hashtag_id: 'h1' }],
            },
          ],
        },
      ],
      user_profiles: [{ data: [{ id: 'u1', handle: 'alice', avatar_url: null }] }],
    })
    const r = await getPostsByHashtag(client, 'BTC')
    expect(r.total).toBe(1)
    expect(r.has_more).toBe(false)
    expect((r.posts[0] as { author: { handle: string } }).author.handle).toBe('alice')
  })

  it('作者 profile 缺失 → author null 不崩', async () => {
    const { client } = queueClient({
      hashtags: [{ data: { id: 'h1' } }],
      posts: [
        {
          data: [
            {
              id: 'p1',
              author_id: 'u-ghost',
              post_hashtags: [{ hashtag_id: 'h1' }],
            },
          ],
        },
      ],
      user_profiles: [{ data: [] }],
    })
    const r = await getPostsByHashtag(client, 'btc')
    expect((r.posts[0] as { author: unknown }).author).toBeNull()
  })

  it('把 viewer id 传入 canonical audience，并在过滤后应用 offset', async () => {
    const queued = queueClient({
      hashtags: [{ data: { id: 'h1' } }],
      posts: [
        {
          data: [
            {
              id: 'private-post',
              author_id: 'private-author',
              post_hashtags: [{ hashtag_id: 'h1' }],
            },
            {
              id: 'visible-1',
              author_id: 'author-1',
              post_hashtags: [{ hashtag_id: 'h1' }],
            },
            {
              id: 'visible-2',
              author_id: 'author-2',
              post_hashtags: [{ hashtag_id: 'h1' }],
            },
          ],
        },
      ],
      user_profiles: [{ data: [{ id: 'author-2', handle: 'two', avatar_url: null }] }],
    })
    queued.rpc.mockImplementation((_name: string, args: { p_post_id: string }) =>
      Promise.resolve({ data: args.p_post_id !== 'private-post', error: null })
    )

    const result = await getPostsByHashtag(queued.client, 'btc', {
      offset: 1,
      limit: 1,
      viewer_id: 'viewer-1',
    })

    expect(result.posts).toEqual([
      expect.objectContaining({
        id: 'visible-2',
        author: expect.objectContaining({ handle: 'two' }),
      }),
    ])
    expect(result).toMatchObject({ total: 2, has_more: false })
    expect(queued.rpc).toHaveBeenCalledWith('can_service_actor_read_post', {
      p_post_id: 'private-post',
      p_actor_id: 'viewer-1',
    })
  })

  it('不泄漏 service-role 总数：源未扫描完时 total 为 null，has_more 来自授权后的前瞻行', async () => {
    const candidates = Array.from({ length: 32 }, (_, index) => ({
      id: `p-${index}`,
      post_hashtags: [{ hashtag_id: 'h1' }],
    }))
    const queued = queueClient({
      hashtags: [{ data: { id: 'h1' } }],
      posts: [{ data: candidates, count: 999_999 }],
    })

    const result = await getPostsByHashtag(queued.client, 'btc', { limit: 1 })

    expect(result.posts).toHaveLength(1)
    expect(result.has_more).toBe(true)
    expect(result.total).toBeNull()
    expect(result).not.toHaveProperty('count')
  })

  it.each([
    [
      'hashtag',
      { hashtags: [{ data: null, error: { message: 'hashtag read failed' } }] },
      'hashtag',
    ],
    [
      'joined posts',
      {
        hashtags: [{ data: { id: 'h1' } }],
        posts: [{ data: null, error: { message: 'join/posts read failed' } }],
      },
      'posts',
    ],
    [
      'profile',
      {
        hashtags: [{ data: { id: 'h1' } }],
        posts: [
          {
            data: [
              {
                id: 'p1',
                author_id: 'u1',
                post_hashtags: [{ hashtag_id: 'h1' }],
              },
            ],
          },
        ],
        user_profiles: [{ data: null, error: { message: 'profile read failed' } }],
      },
      'profile',
    ],
  ])('核心 %s 查询错误直接失败，不伪装空结果', async (_label, queues, message) => {
    const { client } = queueClient(
      queues as Record<string, Array<{ data?: unknown; error?: unknown; count?: number }>>
    )
    await expect(getPostsByHashtag(client, 'btc')).rejects.toMatchObject({
      message: expect.stringContaining(message),
    })
  })

  it('canonical audience authority 错误直接失败', async () => {
    const queued = queueClient({
      hashtags: [{ data: { id: 'h1' } }],
      posts: [
        {
          data: [{ id: 'p1', post_hashtags: [{ hashtag_id: 'h1' }] }],
        },
      ],
    })
    queued.rpc.mockResolvedValue({ data: null, error: { code: '08006' } })

    await expect(getPostsByHashtag(queued.client, 'btc')).rejects.toThrow(
      'Canonical post audience authority unavailable'
    )
  })
})
