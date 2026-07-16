/**
 * linked-traders — 多账号关联 + 跨账号聚合统计。
 * 双表回退(user_linked_traders→trader_links)、|pnl| 加权分、Redis 缓存命中。
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
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) obj[m] = () => obj
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

beforeEach(() => mockCacheStore.clear())

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
  })

  it('主表空 → 回退 trader_links,首个为 primary', async () => {
    const { client } = queueClient({
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
    const links = await getLinkedTraders(client, 'u1')
    expect(links).toHaveLength(2)
    expect(links[0].isPrimary).toBe(true)
    expect(links[1].isPrimary).toBe(false)
    expect(links[0].linkedAt).toBe('2026-06-01') // verified_at null → created_at
  })

  it('两表都空 → []', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [] }],
      trader_links: [{ data: [] }],
    })
    expect(await getLinkedTraders(client, 'u1')).toEqual([])
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
})

describe('findUserByTrader + 缓存失效', () => {
  it('主表命中 → user_id;主表无 → 回退 trader_links;都无 → null', async () => {
    const hit = queueClient({ user_linked_traders: [{ data: { user_id: 'u9' } }] })
    expect(await findUserByTrader(hit.client, 'bybit', 't1')).toBe('u9')

    const fallback = queueClient({
      user_linked_traders: [{ data: null }],
      trader_links: [{ data: { user_id: 'u8' } }],
    })
    expect(await findUserByTrader(fallback.client, 'bybit', 't1')).toBe('u8')

    const none = queueClient({
      user_linked_traders: [{ data: null }],
      trader_links: [{ data: null }],
    })
    expect(await findUserByTrader(none.client, 'bybit', 't1')).toBeNull()
  })

  it('invalidateLinkedTraderCache 清理账号、聚合与路由三层 key', async () => {
    mockCacheStore.set('linked-traders:u1', ['x'])
    mockCacheStore.set('linked-traders-agg:u1', { y: 1 })
    mockCacheStore.set('aggregate:user:u1', { z: 1 })
    await invalidateLinkedTraderCache('u1')
    expect(mockCacheStore.size).toBe(0)
  })
})
