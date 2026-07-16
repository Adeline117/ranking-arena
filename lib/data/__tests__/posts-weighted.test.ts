/**
 * posts-weighted — feed 作者权重加成重排。
 * 回归锁:旧实现调用 supabase-js 不存在的 .join()(被 @ts-expect-error 压掉),
 * ?enable_weight=true&sort_by=hot_score 必 500。重写为 getPosts+权重重排。
 */

const mockGetPosts = jest.fn()
jest.mock('../posts', () => ({ getPosts: (...a: unknown[]) => mockGetPosts(...a) }))
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }))

import { getWeightedPosts } from '../posts-weighted'
import type { SupabaseClient } from '@supabase/supabase-js'

function post(id: string, hot: number, authorId: string) {
  return { id, hot_score: hot, author_id: authorId, title: id, content: '' } as never
}

function weightsClient(
  weights: Array<{ id: string; weight: number | null }>,
  error: { message: string } | null = null
) {
  const from = jest.fn(() => {
    const obj: Record<string, unknown> = {}
    obj.select = () => obj
    obj.in = () => Promise.resolve({ data: error ? null : weights, error })
    return obj
  })
  return { client: { from } as unknown as SupabaseClient, from }
}

beforeEach(() => mockGetPosts.mockReset())

describe('非加权路径(直通 getPosts)', () => {
  it('enable_weight=false → 原样委托', async () => {
    mockGetPosts.mockResolvedValue([post('a', 10, 'u1')])
    const { client } = weightsClient([])
    const r = await getWeightedPosts(client, { enable_weight: false, sort_by: 'hot_score' })
    expect(r).toHaveLength(1)
    expect(mockGetPosts).toHaveBeenCalledTimes(1)
  })

  it('sort_by 非 hot_score → 即使 enable_weight 也直通', async () => {
    mockGetPosts.mockResolvedValue([])
    const { client, from } = weightsClient([])
    await getWeightedPosts(client, { enable_weight: true, sort_by: 'created_at' })
    expect(from).not.toHaveBeenCalled() // 不查权重
  })
})

describe('加权重排(修复后的活路径)', () => {
  it('forwards viewer ownership into the canonical post reader', async () => {
    mockGetPosts.mockResolvedValue([])
    const { client } = weightsClient([])

    await getWeightedPosts(client, {
      enable_weight: true,
      sort_by: 'hot_score',
      viewer_id: 'viewer-1',
    })

    expect(mockGetPosts).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ viewer_id: 'viewer-1' })
    )
  })

  it('高权重作者的帖子被提升:hot 10×(1+0.3×100/100)=13 > hot 12×1', async () => {
    mockGetPosts.mockResolvedValue([
      post('top-by-hot', 12, 'u-normal'),
      post('boosted', 10, 'u-whale'),
    ])
    const { client } = weightsClient([
      { id: 'u-normal', weight: 0 },
      { id: 'u-whale', weight: 100 },
    ])
    const r = await getWeightedPosts(client, {
      enable_weight: true,
      sort_by: 'hot_score',
      weight_factor: 0.3,
    })
    expect((r[0] as { id: string }).id).toBe('boosted') // 13 > 12
  })

  it('weight_factor=0 → 权重无影响,保持 hot 序', async () => {
    mockGetPosts.mockResolvedValue([post('a', 12, 'u1'), post('b', 10, 'u2')])
    const { client } = weightsClient([
      { id: 'u1', weight: 0 },
      { id: 'u2', weight: 100 },
    ])
    const r = await getWeightedPosts(client, {
      enable_weight: true,
      sort_by: 'hot_score',
      weight_factor: 0,
    })
    expect((r[0] as { id: string }).id).toBe('a')
  })

  it('作者无权重记录 → 按 0 处理', async () => {
    mockGetPosts.mockResolvedValue([post('a', 10, 'u-unknown'), post('b', 11, 'u1')])
    const { client } = weightsClient([{ id: 'u1', weight: null }]) // weight null → 0
    const r = await getWeightedPosts(client, { enable_weight: true, sort_by: 'hot_score' })
    expect((r[0] as { id: string }).id).toBe('b') // 无加成,纯 hot 序
  })

  it('asc 排序生效', async () => {
    mockGetPosts.mockResolvedValue([post('hi', 20, 'u1'), post('lo', 5, 'u1')])
    const { client } = weightsClient([{ id: 'u1', weight: 0 }])
    const r = await getWeightedPosts(client, {
      enable_weight: true,
      sort_by: 'hot_score',
      sort_order: 'asc',
    })
    expect((r[0] as { id: string }).id).toBe('lo')
  })

  it('权重查询失败 → 优雅回退未加权顺序(不 500)', async () => {
    mockGetPosts.mockResolvedValue([post('a', 12, 'u1'), post('b', 10, 'u2')])
    const { client } = weightsClient([], { message: 'db down' })
    const r = await getWeightedPosts(client, { enable_weight: true, sort_by: 'hot_score' })
    expect(r.map((p) => (p as { id: string }).id)).toEqual(['a', 'b']) // 原顺序
  })

  it('空 feed → 空数组,不查权重', async () => {
    mockGetPosts.mockResolvedValue([])
    const { client, from } = weightsClient([])
    const r = await getWeightedPosts(client, { enable_weight: true, sort_by: 'hot_score' })
    expect(r).toEqual([])
    expect(from).not.toHaveBeenCalled()
  })
})
