/**
 * linked-traders — 多账号关联 + 跨账号可信统计。
 * 标准关联表、退役表兼容边界、聚合失效关闭与缓存失效。
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
    for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit']) obj[m] = () => obj
    obj.maybeSingle = () => p
    obj.then = (...args: Parameters<Promise<unknown>['then']>) => p.then(...args)
    return obj
  })
  return { client: { from } as unknown as SupabaseClient, from }
}

function ultRow(traderId: string, isPrimary = false, source = 'bybit') {
  return {
    id: `l-${traderId}`,
    user_id: 'u1',
    source,
    trader_id: traderId,
    label: null,
    is_primary: isPrimary,
    verified_at: '2026-07-01T00:00:00Z',
  }
}

function rankRow(
  traderId: string,
  roi: unknown,
  pnl: unknown,
  score: unknown,
  overrides: Record<string, unknown> = {}
) {
  return {
    source: 'bybit',
    source_trader_id: traderId,
    season_id: '90D',
    roi,
    pnl,
    arena_score: score,
    win_rate: 60,
    max_drawdown: 20,
    rank: 5,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => mockCacheStore.clear())

describe('getLinkedTraders', () => {
  it('主表有数据 → 仅用已验证的公开 cohort 补指标', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('t1', true)] }],
      public_ranked_leaderboard: [{ data: [rankRow('t1', 50, 1000, 80)] }],
    })
    const links = await getLinkedTraders(client, 'u1')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      platform: 'bybit',
      traderKey: 't1',
      isPrimary: true,
      roi: 50,
      pnl: null,
      arenaScore: 80,
      winRate: 60,
      maxDrawdown: 20,
      rank: 5,
      rankingVisibility: 'verified',
      rankingVisibilityReason: null,
    })
  })

  it.each([
    ['no win rate', { win_rate: null, score_completeness: 'partial' }, null, 20],
    ['no drawdown', { max_drawdown: null, score_completeness: 'partial' }, 60, null],
    [
      'ROI and PnL only',
      { win_rate: null, max_drawdown: null, score_completeness: 'minimal' },
      null,
      null,
    ],
  ])(
    'keeps a ranked account verified with %s',
    async (_label, overrides, expectedWinRate, expectedMaxDrawdown) => {
      const { client } = queueClient({
        user_linked_traders: [{ data: [ultRow('t1', true)] }],
        public_ranked_leaderboard: [{ data: [rankRow('t1', -12, -300, 4.2, overrides)] }],
      })
      const [link] = await getLinkedTraders(client, 'u1')
      expect(link).toMatchObject({
        roi: -12,
        arenaScore: 4.2,
        winRate: expectedWinRate,
        maxDrawdown: expectedMaxDrawdown,
        rank: 5,
        rankingVisibility: 'verified',
        rankingVisibilityReason: null,
      })
    }
  )

  it('suppresses every performance field when a returned cohort row is estimated', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('t1', true)] }],
      public_ranked_leaderboard: [
        {
          data: [rankRow('t1', 50, 1000, 80, { metrics_estimated: true })],
        },
      ],
    })

    const [link] = await getLinkedTraders(client, 'u1')
    expect(link).toMatchObject({
      roi: null,
      pnl: null,
      winRate: null,
      maxDrawdown: null,
      arenaScore: null,
      rank: null,
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_cohort_unverified',
    })
  })

  it('fails closed for non-finite and physically invalid public-cohort metrics', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('t1', true)] }],
      public_ranked_leaderboard: [
        {
          data: [
            rankRow('t1', Number.NaN, Number.POSITIVE_INFINITY, 101, {
              win_rate: -1,
              max_drawdown: -100.001,
              rank: 0,
            }),
          ],
        },
      ],
    })

    const [link] = await getLinkedTraders(client, 'u1')
    expect(link).toMatchObject({
      roi: null,
      pnl: null,
      arenaScore: null,
      winRate: null,
      maxDrawdown: null,
      rank: null,
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_cohort_unverified',
    })
  })

  it('accepts the persisted ROI bounds and rejects values beyond them', async () => {
    const { client } = queueClient({
      user_linked_traders: [
        { data: [ultRow('positive-cap'), ultRow('negative-cap'), ultRow('beyond-cap')] },
      ],
      public_ranked_leaderboard: [
        {
          data: [
            rankRow('positive-cap', 10_000, 0, 80),
            rankRow('negative-cap', -10_000, 0, 80),
            rankRow('beyond-cap', 10_000.01, 0, 80),
          ],
        },
      ],
    })

    const links = await getLinkedTraders(client, 'u1')
    expect(links.map((link) => link.roi)).toEqual([10_000, -10_000, null])
    expect(links.map((link) => link.rankingVisibility)).toEqual(['verified', 'verified', 'partial'])
  })

  it('requires exactly one sanitized row for the same source + trader key', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('duplicated', true), ultRow('exact-pair')] }],
      public_ranked_leaderboard: [
        {
          data: [
            rankRow('duplicated', 10, 100, 80),
            rankRow('duplicated', 11, 100, 80, { rank: 6 }),
            rankRow('exact-pair', 12, 100, 80),
            rankRow('exact-pair', 99, 100, 80, { source: 'okx' }),
          ],
        },
      ],
    })

    const links = await getLinkedTraders(client, 'u1')
    expect(links[0]).toMatchObject({
      traderKey: 'duplicated',
      roi: null,
      rank: null,
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_cohort_unverified',
    })
    expect(links[1]).toMatchObject({
      traderKey: 'exact-pair',
      roi: 12,
      rank: 5,
      rankingVisibility: 'verified',
      rankingVisibilityReason: null,
    })
  })

  it('keeps an unrankable-source membership but marks all metrics partial', async () => {
    const { client, from } = queueClient({
      user_linked_traders: [{ data: [ultRow('wallet-1', true, 'okx_web3_solana')] }],
    })

    const [link] = await getLinkedTraders(client, 'u1')
    expect(link).toMatchObject({
      platform: 'okx_web3_solana',
      traderKey: 'wallet-1',
      roi: null,
      pnl: null,
      arenaScore: null,
      winRate: null,
      maxDrawdown: null,
      rank: null,
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'source_not_publicly_rankable',
    })
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('does not treat an arbitrary primary membership query error as legacy fallback', async () => {
    const { client, from } = queueClient({
      user_linked_traders: [{ error: { code: '57014', message: 'query canceled' } }],
      trader_links: [{ data: [] }],
    })

    await expect(getLinkedTraders(client, 'u1')).rejects.toThrow('linked trader lookup failed')
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('does not cache or replay ranking metrics when the live public cohort fails', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('t1', true)] }],
      public_ranked_leaderboard: [{ error: { message: 'database unavailable' } }],
    })

    await expect(getLinkedTraders(client, 'u1')).resolves.toEqual([
      expect.objectContaining({
        traderKey: 't1',
        roi: null,
        arenaScore: null,
        winRate: null,
        maxDrawdown: null,
        rank: null,
        rankingVisibility: 'unknown',
        rankingVisibilityReason: 'public_cohort_unavailable',
      }),
    ])
    expect(mockCacheStore.has('linked-traders:v2:u1')).toBe(false)
  })

  it('标准表空结果为权威结果，不会复活退役表账号', async () => {
    const { client, from } = queueClient({
      user_linked_traders: [{ data: [] }],
      trader_links: [
        {
          data: [
            {
              id: 'stale',
              user_id: 'u1',
              trader_id: 'retired-link',
              source: 'okx',
              handle: 'stale',
              verified_at: null,
              created_at: '2026-06-01',
            },
          ],
        },
      ],
    })

    expect(await getLinkedTraders(client, 'u1')).toEqual([])
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('标准关系缺失时才回退 trader_links，并把首个设为 primary', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ error: { code: '42P01', message: 'relation missing' } }],
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
      public_ranked_leaderboard: [{ data: [] }],
    })
    const links = await getLinkedTraders(client, 'u1')
    expect(links).toHaveLength(2)
    expect(links[0].isPrimary).toBe(true)
    expect(links[1].isPrimary).toBe(false)
    expect(links[0].linkedAt).toBe('2026-06-01') // verified_at null → created_at
  })

  it('标准关系缺失且退役表空 → []', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ error: { code: 'PGRST205', message: 'relation missing' } }],
      trader_links: [{ data: [] }],
    })
    expect(await getLinkedTraders(client, 'u1')).toEqual([])
  })

  it('re-reads membership so an unlink cannot survive in process cache', async () => {
    const { client, from } = queueClient({
      user_linked_traders: [{ data: [ultRow('t1')] }],
      public_ranked_leaderboard: [{ data: [] }],
    })
    await getLinkedTraders(client, 'u1')
    const callsAfterFirst = from.mock.calls.length
    await getLinkedTraders(client, 'u1')
    expect(from.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })
})

describe('getAggregatedStats', () => {
  function twoAccountClient() {
    return queueClient({
      user_linked_traders: [{ data: [ultRow('t1', true), ultRow('t2')] }],
      public_ranked_leaderboard: [
        { data: [rankRow('t1', 50, 1000, 80), rankRow('t2', 100, -500, 60)] },
      ],
    })
  }

  it('withholds aggregate numerics until a complete publication contract is bound', async () => {
    const { client } = twoAccountClient()
    const agg = (await getAggregatedStats(client, 'u1'))!
    expect(agg.combinedPnl).toBeNull()
    expect(agg.bestRoi).toBeNull()
    expect(agg.weightedScore).toBeNull()
    expect(agg.totalAccounts).toBe(2)
  })

  it('does not derive a weighted score from unbound PnL currencies', async () => {
    const { client } = twoAccountClient()
    const agg = (await getAggregatedStats(client, 'u1'))!
    expect(agg.weightedScore).toBeNull()
  })

  it('does not publish a best ROI from a partial account set', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('t1', true), ultRow('t2')] }],
      public_ranked_leaderboard: [
        {
          data: [rankRow('t1', 0, 0, 80), rankRow('t2', null, 100, 60)],
        },
      ],
    })

    const agg = (await getAggregatedStats(client, 'u1'))!
    expect(agg.bestRoi).toBeNull()
    expect(agg.combinedPnl).toBeNull()
    expect(agg.weightedScore).toBeNull()
  })

  it('preserves measured zero as profile evidence without promoting it to an aggregate', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('t1', true), ultRow('t2')] }],
      public_ranked_leaderboard: [
        {
          data: [rankRow('t1', 0, 0, 80), rankRow('t2', 0, 0, 60)],
        },
      ],
    })

    const agg = (await getAggregatedStats(client, 'u1'))!
    expect(agg.accounts.map((account) => account.roi)).toEqual([0, 0])
    expect(agg.bestRoi).toBeNull()
  })

  it('单账号保留真实 membership count，但不会产生聚合值', async () => {
    const { client } = queueClient({
      user_linked_traders: [{ data: [ultRow('only')] }],
      public_ranked_leaderboard: [{ data: [] }],
    })
    expect(await getAggregatedStats(client, 'u1')).toMatchObject({
      combinedPnl: null,
      bestRoi: null,
      weightedScore: null,
      totalAccounts: 1,
      accounts: [expect.objectContaining({ traderKey: 'only' })],
    })
  })

  it('零账号 → null', async () => {
    const { client } = queueClient({ user_linked_traders: [{ data: [] }] })
    expect(await getAggregatedStats(client, 'u1')).toBeNull()
  })
})

describe('findUserByTrader + 缓存失效', () => {
  it('标准表命中 → user_id；标准表无记录 → 权威 null', async () => {
    const hit = queueClient({ user_linked_traders: [{ data: { user_id: 'u9' } }] })
    expect(await findUserByTrader(hit.client, 'bybit', 't1')).toBe('u9')

    const canonicalMiss = queueClient({
      user_linked_traders: [{ data: null }],
      trader_links: [{ data: { user_id: 'stale-user' } }],
    })
    expect(await findUserByTrader(canonicalMiss.client, 'bybit', 't1')).toBeNull()
    expect(canonicalMiss.from).toHaveBeenCalledTimes(1)
  })

  it('仅在标准关系缺失时回退退役表', async () => {
    const fallback = queueClient({
      user_linked_traders: [{ error: { code: '42P01', message: 'relation missing' } }],
      trader_links: [{ data: { user_id: 'u8' } }],
    })
    expect(await findUserByTrader(fallback.client, 'bybit', 't1')).toBe('u8')

    const none = queueClient({
      user_linked_traders: [{ error: { code: 'PGRST205', message: 'relation missing' } }],
      trader_links: [{ data: null }],
    })
    expect(await findUserByTrader(none.client, 'bybit', 't1')).toBeNull()
  })

  it('fails closed when the primary owner lookup errors unexpectedly', async () => {
    const failed = queueClient({
      user_linked_traders: [{ error: { code: '57014', message: 'query canceled' } }],
      trader_links: [{ data: { user_id: 'stale-user' } }],
    })

    await expect(findUserByTrader(failed.client, 'bybit', 't1')).rejects.toThrow(
      'linked trader owner lookup failed'
    )
    expect(failed.from).toHaveBeenCalledTimes(1)
  })

  it('invalidateLinkedTraderCache 清理账号、聚合与路由三层 key', async () => {
    mockCacheStore.set('linked-traders:u1', ['legacy'])
    mockCacheStore.set('linked-traders:v2:u1', ['x'])
    mockCacheStore.set('linked-traders-agg:u1', { legacy: true })
    mockCacheStore.set('linked-traders-agg:v2:u1', { y: 1 })
    mockCacheStore.set('aggregate:user:u1', { legacy: true })
    mockCacheStore.set('aggregate:v2:user:u1', { z: 1 })
    await invalidateLinkedTraderCache('u1')
    expect(mockCacheStore.size).toBe(0)
  })
})
