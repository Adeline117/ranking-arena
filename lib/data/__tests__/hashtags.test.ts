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
    expect(await getPostsByHashtag(client, 'ghost')).toEqual({ posts: [], total: 0 })
  })

  it('输入标签被 lowercase 后查询(与提取归一一致)', async () => {
    const { client } = queueClient({
      hashtags: [{ data: { id: 'h1' } }],
      post_hashtags: [{ data: [{ post_id: 'p1' }], count: 1 }],
      posts: [{ data: [{ id: 'p1', author_id: 'u1', title: 't' }] }],
      user_profiles: [{ data: [{ id: 'u1', handle: 'alice', avatar_url: null }] }],
    })
    const r = await getPostsByHashtag(client, 'BTC')
    expect(r.total).toBe(1)
    expect((r.posts[0] as { author: { handle: string } }).author.handle).toBe('alice')
  })

  it('作者 profile 缺失 → author null 不崩', async () => {
    const { client } = queueClient({
      hashtags: [{ data: { id: 'h1' } }],
      post_hashtags: [{ data: [{ post_id: 'p1' }], count: 1 }],
      posts: [{ data: [{ id: 'p1', author_id: 'u-ghost' }] }],
      user_profiles: [{ data: [] }],
    })
    const r = await getPostsByHashtag(client, 'btc')
    expect((r.posts[0] as { author: unknown }).author).toBeNull()
  })

  it('service audience 拒绝时不返回帖子或查询作者资料', async () => {
    const queued = queueClient({
      hashtags: [{ data: { id: 'h1' } }],
      post_hashtags: [{ data: [{ post_id: 'private-post' }], count: 1 }],
      posts: [{ data: [{ id: 'private-post', author_id: 'private-author' }] }],
    })
    queued.rpc.mockResolvedValue({ data: false, error: null })

    const result = await getPostsByHashtag(queued.client, 'btc')

    expect(result.posts).toEqual([])
    expect(queued.from).not.toHaveBeenCalledWith('user_profiles')
    expect(queued.rpc).toHaveBeenCalledWith('can_service_actor_read_post', {
      p_post_id: 'private-post',
      p_actor_id: null,
    })
  })
})
