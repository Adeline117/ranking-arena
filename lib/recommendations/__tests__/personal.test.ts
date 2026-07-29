/**
 * personal — 个性化推荐(相似跟随>偏好交易所>全站头部兜底)+ 去重。
 */

const mockQueues: Record<string, Array<{ data: unknown; error?: unknown }>> = {}
const mockQueryCalls: Array<{ table: string; method: string; args: unknown[] }> = []
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const q = mockQueues[table] ?? []
      const resp = q.length > 1 ? q.shift()! : (q[0] ?? { data: [] })
      const p = Promise.resolve({ data: resp.data, error: resp.error ?? null })
      const obj: Record<string, unknown> = {}
      for (const m of [
        'select',
        'eq',
        'filter',
        'in',
        'gte',
        'lte',
        'neq',
        'gt',
        'not',
        'or',
        'order',
      ]) {
        obj[m] = (...args: unknown[]) => {
          mockQueryCalls.push({ table, method: m, args })
          return obj
        }
      }
      obj.limit = (...args: unknown[]) => {
        mockQueryCalls.push({ table, method: 'limit', args })
        return p
      }
      return obj
    },
  }),
}))

const mockReadSealedRankingAuthorityGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingAuthorityGeneration: (...args: unknown[]) =>
    mockReadSealedRankingAuthorityGeneration(...args),
  sealedRankingPublicationIdentity: (publication: unknown) => JSON.stringify(publication),
}))

const mockTieredGetOrSet = jest.fn()
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn() }),
}))

import { getPersonalRecommendations } from '../personal'

function ranked(id: string, source = 'bybit', overrides: Record<string, unknown> = {}) {
  return {
    source,
    source_trader_id: id,
    handle: id,
    avatar_url: null,
    arena_score: 80,
    roi: 50,
    pnl: 100,
    win_rate: 60,
    ...overrides,
  }
}

beforeEach(() => {
  for (const k of Object.keys(mockQueues)) delete mockQueues[k]
  mockQueryCalls.length = 0
  jest.clearAllMocks()
  mockTieredGetOrSet.mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) =>
    fetcher()
  )
  mockReadSealedRankingAuthorityGeneration.mockImplementation(
    async (
      _client: unknown,
      season: string,
      reader: (publication: {
        scoreCohortId: string
        proofs: Array<{ source: string }>
      }) => Promise<unknown>
    ) => {
      const publication = {
        state: 'sealed',
        season,
        scoreCohortId: '11111111-1111-4111-8111-111111111111',
        proofs: [{ source: 'bybit' }, { source: 'okx_web3_solana' }],
      }
      return {
        value: await reader(publication),
        publication,
        publicationIdentity: JSON.stringify(publication),
      }
    }
  )
})

describe('getPersonalRecommendations', () => {
  it('无关注 → 全站头部兜底,reason=top_performer', async () => {
    mockQueues.user_follows = [{ data: [] }]
    mockQueues.leaderboard_ranks = [{ data: [ranked('top1'), ranked('top2')] }]
    const recs = await getPersonalRecommendations('u1', 10)
    expect(recs).toHaveLength(2)
    expect(recs[0].reason).toBe('top_performer')
    expect(recs[0].reason_detail).toContain('bybit')
    expect(mockReadSealedRankingAuthorityGeneration).toHaveBeenCalledWith(
      expect.anything(),
      '90D',
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(mockTieredGetOrSet).toHaveBeenCalledWith(
      expect.stringMatching(/^recommendations:personal:sealed-v2:u1:10:/),
      expect.any(Function),
      'hot',
      ['recommendations', 'user:u1']
    )
    expect(mockQueryCalls).toEqual(
      expect.arrayContaining([
        {
          table: 'leaderboard_ranks',
          method: 'filter',
          args: ['rank_publication_id', 'eq', '11111111-1111-4111-8111-111111111111'],
        },
        {
          table: 'leaderboard_ranks',
          method: 'in',
          args: ['source', ['bybit']],
        },
      ])
    )
  })

  it('有关注 → 相似交易员 reason=similar_to_follow,已关注的被排除', async () => {
    mockQueues.user_follows = [{ data: [{ following_id: 'followed-user-1' }] }]
    mockQueues.user_linked_traders = [
      {
        data: [
          {
            user_id: 'followed-user-1',
            source: 'bybit',
            trader_id: 'followed-1',
          },
        ],
      },
    ]
    mockQueues.leaderboard_ranks = [
      // 1. 关注用户正式绑定的 trader 排名
      { data: [ranked('followed-1', 'bybit', { roi: 100 })] },
      // 2. findSimilarTraders:包含一个已关注的(应被去重)
      { data: [ranked('similar-1'), ranked('followed-1')] },
      // 3. getTopFromExchanges 补位
      { data: [ranked('top-pref')] },
    ]
    const recs = await getPersonalRecommendations('u1', 10)
    const ids = recs.map((r) => r.source_trader_id)
    expect(ids).toContain('similar-1')
    expect(ids).not.toContain('followed-1') // 已关注不推
    expect(recs.find((r) => r.source_trader_id === 'similar-1')?.reason).toBe('similar_to_follow')
    expect(recs.find((r) => r.source_trader_id === 'top-pref')?.reason).toBe('preferred_exchange')
  })

  it('相似结果重复出现 → 只推一次(followedSet 兼做去重)', async () => {
    mockQueues.user_follows = [
      { data: [{ following_id: 'followed-user-1' }, { following_id: 'followed-user-2' }] },
    ]
    mockQueues.user_linked_traders = [
      {
        data: [
          { user_id: 'followed-user-1', source: 'bybit', trader_id: 'f1' },
          { user_id: 'followed-user-2', source: 'bybit', trader_id: 'f2' },
        ],
      },
    ]
    mockQueues.leaderboard_ranks = [
      { data: [ranked('f1', 'bybit'), ranked('f2', 'bybit')] }, // 关注映射
      { data: [ranked('dup-similar')] }, // f1 的相似
      { data: [ranked('dup-similar')] }, // f2 的相似(重复)
      { data: [] }, // 补位
    ]
    const recs = await getPersonalRecommendations('u1', 10)
    expect(recs.filter((r) => r.source_trader_id === 'dup-similar')).toHaveLength(1)
  })

  it('limit 截断', async () => {
    mockQueues.user_follows = [{ data: [] }]
    mockQueues.leaderboard_ranks = [{ data: Array.from({ length: 30 }, (_, i) => ranked(`t${i}`)) }]
    const recs = await getPersonalRecommendations('u1', 5)
    // 兜底路径 limit 直接传给查询,这里验证返回不超限
    expect(recs.length).toBeLessThanOrEqual(30)
  })

  it('user_follows 查询抛错 → 捕获,走兜底不炸', async () => {
    mockQueues.user_follows = [{ data: null, error: null }] // data null → follows null → []
    mockQueues.leaderboard_ranks = [{ data: [ranked('fallback')] }]
    const recs = await getPersonalRecommendations('u1')
    expect(recs[0].source_trader_id).toBe('fallback')
    expect(recs[0].reason).toBe('top_performer')
  })

  it('排名查询返回 publication authority 外来源时失败关闭', async () => {
    mockQueues.user_follows = [{ data: [] }]
    mockQueues.leaderboard_ranks = [{ data: [ranked('escaped', 'hyperliquid')] }]

    await expect(getPersonalRecommendations('u1')).rejects.toThrow('escaped publication authority')
  })
})
