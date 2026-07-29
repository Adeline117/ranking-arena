/**
 * linked-traders — 多账号关联 + 跨账号聚合统计。
 * canonical ownership、|pnl| 加权分、Redis 缓存命中。
 */

const mockCacheStore = new Map<string, unknown>()
jest.mock('@/lib/cache', () => ({
  get: jest.fn((k: string) => Promise.resolve(mockCacheStore.get(k) ?? null)),
  set: jest.fn((k: string, v: unknown) => {
    mockCacheStore.set(k, v)
    return Promise.resolve()
  }),
  del: jest.fn((k: string) => {
    mockCacheStore.delete(k)
    return Promise.resolve()
  }),
}))
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }))

const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

const mockReadPublicProfileAudienceById = jest.fn()
jest.mock('@/lib/profile/public-audience', () => ({
  readPublicProfileAudienceById: (...args: unknown[]) => mockReadPublicProfileAudienceById(...args),
}))

import {
  getLinkedTraders,
  getAggregatedStats,
  findUserByTrader,
  invalidateLinkedTraderCache,
} from '../linked-traders'
import type { SupabaseClient } from '@supabase/supabase-js'

/** 按表路由的队列 mock,thenable + maybeSingle 双终结 */
function queueClient(queues: Record<string, Array<{ data?: unknown; error?: unknown }>>) {
  const from = jest.fn((table: string) => {
    const q = queues[table] ?? []
    const resp = q.length > 1 ? q.shift()! : (q[0] ?? { data: null })
    const p = Promise.resolve({ data: resp.data ?? null, error: resp.error ?? null })
    const obj: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'filter', 'order', 'limit']) obj[m] = () => obj
    obj.maybeSingle = () => p
    obj.then = (...args: Parameters<Promise<unknown>['then']>) => p.then(...args)
    return obj
  })
  return { client: { from } as unknown as SupabaseClient, from }
}

function ultRow(traderId: string, isPrimary = false) {
  return {
    id: `l-${traderId}`,
    user_id: 'u1',
    source: 'bybit',
    trader_id: traderId,
    label: null,
    is_primary: isPrimary,
    verified_at: '2026-07-01T00:00:00Z',
  }
}

function rankRow(traderId: string, roi: number, pnl: number, score: number) {
  return {
    source: 'bybit',
    source_trader_id: traderId,
    roi,
    pnl,
    arena_score: score,
    win_rate: 60,
    max_drawdown: 20,
    rank: 5,
  }
}

beforeEach(() => {
  mockCacheStore.clear()
  mockReadPublicProfileAudienceById.mockResolvedValue({
    status: 'active',
    profile: {
      id: '00000000-0000-4000-8000-000000000001',
      handle: 'active-user',
      deleted_at: null,
      banned_at: null,
      is_banned: false,
      ban_expires_at: null,
    },
  })
  mockReadSealedRankingGeneration.mockImplementation(
    async (
      _supabase: unknown,
      input: { season: '90D'; sources: string[] },
      reader: (publication: {
        state: 'sealed'
        season: '90D'
        scoreCohortId: string
        proofs: unknown[]
      }) => Promise<unknown>
    ) => {
      const scoreCohortId = '11111111-1111-4111-8111-111111111111'
      const publication = {
        state: 'sealed' as const,
        season: input.season,
        scoreCohortId,
        proofs: [...input.sources].sort().map((source) => ({
          season_id: input.season,
          source,
          source_as_of: '2026-07-29T10:00:00.000000Z',
          recorded_at: '2026-07-29T10:01:00.000000Z',
          score_cohort_id: scoreCohortId,
          rank_mutation_seq: 9,
          current_mutation_seq: 9,
          published_rank_count: 1,
          published_identity_sha256: 'a'.repeat(64),
          is_sealed: true,
        })),
      }
      return {
        value: await reader(publication),
        publication,
        publicationIdentity: JSON.stringify(publication),
      }
    }
  )
})

describe('getLinkedTraders', () => {
  it('主表有数据 → 映射 + 用 leaderboard_ranks 补 stats', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('t1', true)] }],
      leaderboard_ranks: [{ data: [rankRow('t1', 50, 1000, 80)] }],
    })
    const links = await getLinkedTraders(client, 'u1')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      platform: 'bybit',
      traderKey: 't1',
      isPrimary: true,
      roi: 50,
      pnl: 1000,
    })
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      expect.anything(),
      { season: '90D', sources: ['bybit'] },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(mockCacheStore.get('linked-traders:sealed-v3:u1')).toEqual(
      expect.objectContaining({ contract: 'sealed-ranking-cache@1', season: '90D' })
    )
  })

  it('排行批次查询失败时拒绝部分聚合且不写缓存', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('t1', true)] }],
      leaderboard_ranks: [{ error: { message: 'rank batch unavailable' } }],
    })

    await expect(getLinkedTraders(client, 'u1')).rejects.toThrow(
      'linked trader aggregation query failed: rank batch unavailable'
    )
    expect(mockCacheStore.has('linked-traders:sealed-v3:u1')).toBe(false)
  })

  it('canonical 为空时不从 retired trader_links 复活已解绑身份', async () => {
    const { client, from } = queueClient({
      user_linked_traders: [{ data: [] }],
      trader_links: [
        {
          data: [
            {
              id: 'a',
              user_id: 'u1',
              trader_id: 't1',
              source: 'okx',
              handle: 'h1',
              verified_at: null,
              created_at: '2026-06-01',
            },
            {
              id: 'b',
              user_id: 'u1',
              trader_id: 't2',
              source: 'okx',
              handle: 'h2',
              verified_at: null,
              created_at: '2026-06-02',
            },
          ],
        },
      ],
      leaderboard_ranks: [{ data: [] }],
    })
    await expect(getLinkedTraders(client, 'u1')).resolves.toEqual([])
    expect(from).toHaveBeenCalledTimes(1)
    expect(from).not.toHaveBeenCalledWith('trader_links')
  })

  it('canonical 表空 → []', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [] }],
    })
    expect(await getLinkedTraders(client, 'u1')).toEqual([])
  })

  it('canonical ownership 查询失败时诚实失败而不是降级到退休数据', async () => {
    const { client, from } = queueClient({
      user_linked_traders: [{ error: { message: 'canonical unavailable' } }],
      trader_links: [{ data: [{ user_id: 'stale-owner' }] }],
    })

    await expect(getLinkedTraders(client, 'u1')).rejects.toThrow(
      'canonical linked trader query failed: canonical unavailable'
    )
    expect(from).not.toHaveBeenCalledWith('trader_links')
  })

  it('二次调用命中缓存,不再查 DB', async () => {
    const { client, from } = queueClient({
      user_linked_traders: [{ data: [ultRow('t1')] }],
      leaderboard_ranks: [{ data: [] }],
    })
    await getLinkedTraders(client, 'u1')
    const callsAfterFirst = from.mock.calls.length
    await getLinkedTraders(client, 'u1')
    expect(from.mock.calls.length).toBe(callsAfterFirst) // 缓存命中
  })
})

describe('getAggregatedStats', () => {
  function twoAccountClient() {
    return queueClient({
      user_linked_traders: [{ data: [ultRow('t1', true), ultRow('t2')] }],
      leaderboard_ranks: [{ data: [rankRow('t1', 50, 1000, 80), rankRow('t2', 100, -500, 60)] }],
    })
  }

  it('combinedPnl 求和 + bestRoi 取最大(带来源)', async () => {
    const { client } = twoAccountClient()
    const agg = (await getAggregatedStats(client, 'u1'))!
    expect(agg.combinedPnl).toBe(500) // 1000 + (-500)
    expect(agg.bestRoi).toMatchObject({ value: 100, traderKey: 't2' })
    expect(agg.totalAccounts).toBe(2)
  })

  it('weightedScore 按 |pnl|+1 加权', async () => {
    const { client } = twoAccountClient()
    const agg = (await getAggregatedStats(client, 'u1'))!
    // (80×1001 + 60×501) / (1001+501) = (80080+30060)/1502 ≈ 73.33
    expect(agg.weightedScore).toBeCloseTo(73.33, 1)
  })

  it('单账号 → null(无聚合意义)', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('only')] }],
      leaderboard_ranks: [{ data: [] }],
    })
    expect(await getAggregatedStats(client, 'u1')).toBeNull()
  })

  it('账号已删除或停用时不读取关联账户缓存/数据库', async () => {
    mockReadPublicProfileAudienceById.mockResolvedValueOnce({
      status: 'inactive',
      profile: {
        id: '00000000-0000-4000-8000-000000000001',
        handle: 'gone',
        deleted_at: '2026-07-29T00:00:00.000Z',
        banned_at: null,
        is_banned: false,
        ban_expires_at: null,
      },
    })
    const { client, from } = twoAccountClient()

    expect(await getAggregatedStats(client, 'u1')).toBeNull()
    expect(from).not.toHaveBeenCalled()
  })
})

describe('findUserByTrader + 缓存失效', () => {
  it('只从 canonical composite identity 解析 owner', async () => {
    const hit = queueClient({ user_linked_traders: [{ data: { user_id: 'u9' } }] })
    expect(await findUserByTrader(hit.client, 'bybit', 't1')).toBe('u9')

    const revoked = queueClient({
      user_linked_traders: [{ data: null }],
      trader_links: [{ data: { user_id: 'u8' } }],
    })
    expect(await findUserByTrader(revoked.client, 'bybit', 't1')).toBeNull()
    expect(revoked.from).toHaveBeenCalledTimes(1)
    expect(revoked.from).not.toHaveBeenCalledWith('trader_links')
  })

  it('does not hide canonical identity authority failures behind retired rows', async () => {
    const failed = queueClient({
      user_linked_traders: [{ error: { message: 'canonical unavailable' } }],
      trader_links: [{ data: { user_id: 'stale-owner' } }],
    })

    await expect(findUserByTrader(failed.client, 'bybit', 't1')).rejects.toThrow(
      'canonical linked trader identity query failed: canonical unavailable'
    )
    expect(failed.from).not.toHaveBeenCalledWith('trader_links')
  })

  it('invalidateLinkedTraderCache 清理账号、聚合与路由三层 key', async () => {
    mockCacheStore.set('linked-traders:sealed-v3:u1', ['current'])
    mockCacheStore.set('linked-traders:sealed-v2:u1', ['retired'])
    mockCacheStore.set('linked-traders:u1', ['x'])
    mockCacheStore.set('linked-traders-agg:u1', { y: 1 })
    mockCacheStore.set('aggregate:user:u1', { z: 1 })
    await invalidateLinkedTraderCache('u1')
    expect(mockCacheStore.size).toBe(0)
  })
})
