/**
 * trader-utils — 交易员源解析 + 请求级缓存 + PostgREST 注入防护。
 */

jest.mock('@/lib/supabase/client', () => ({ supabase: {} }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }),
}))

import {
  findTraderAcrossSources,
  findTradersAcrossSources,
  getTraderArenaFollowersCountBatch,
  traderAccountKey,
  clearSourceCache,
} from '../trader-utils'
import type { SupabaseClient } from '@supabase/supabase-js'

/** 链式 supabase mock:每次 .from() 消费下一个预置响应,limit() 为终结符 */
function mockClient(responses: Array<{ data?: unknown; error?: { message: string } | null }>) {
  let call = 0
  const from = jest.fn(() => {
    const result = responses[Math.min(call++, responses.length - 1)] ?? { data: null, error: null }
    const p = Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
    const obj: Record<string, unknown> = {}
    for (const m of ['select', 'in', 'or', 'eq']) obj[m] = () => obj
    obj.limit = () => p
    return obj
  })
  const rpc = jest.fn(() =>
    Promise.resolve({
      data: (responses[0]?.data as unknown) ?? null,
      error: responses[0]?.error ?? null,
    })
  )
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc }
}

const REC = { source_trader_id: 'id1', handle: 'whale', profile_url: null, source: 'bybit' }

beforeEach(() => clearSourceCache())

describe('findTraderAcrossSources', () => {
  it('单结果 → 直接返回', async () => {
    const { client } = mockClient([{ data: [REC] }])
    const r = await findTraderAcrossSources('whale', { client })
    expect(r?.source_trader_id).toBe('id1')
  })

  it('DB error → null(不抛)', async () => {
    const { client } = mockClient([{ data: null, error: { message: 'boom' } }])
    expect(await findTraderAcrossSources('whale', { client })).toBeNull()
  })

  it('空结果 → null', async () => {
    const { client } = mockClient([{ data: [] }])
    expect(await findTraderAcrossSources('nobody', { client })).toBeNull()
  })

  it('多结果 → 优先返回有 90D 排名的那个', async () => {
    const other = { ...REC, source_trader_id: 'id2', source: 'okx' }
    const { client } = mockClient([
      { data: [REC, other] }, // trader_sources 查询
      { data: [{ source_trader_id: 'id2' }] }, // leaderboard_ranks:只有 id2 有排名
    ])
    const r = await findTraderAcrossSources('whale', { client })
    expect(r?.source_trader_id).toBe('id2')
  })

  it('多结果但都无排名 → 回退 data[0]', async () => {
    const other = { ...REC, source_trader_id: 'id2' }
    const { client } = mockClient([{ data: [REC, other] }, { data: [] }])
    const r = await findTraderAcrossSources('whale', { client })
    expect(r?.source_trader_id).toBe('id1')
  })

  it('请求级缓存:同 handle 第二次调用不再查 DB', async () => {
    const { client, from } = mockClient([{ data: [REC] }])
    await findTraderAcrossSources('whale', { client })
    await findTraderAcrossSources('whale', { client })
    expect(from).toHaveBeenCalledTimes(1) // 第二次命中缓存
  })

  it('includeWeb3 不同 → 缓存 key 不同(各查一次)', async () => {
    const { client, from } = mockClient([{ data: [REC] }])
    await findTraderAcrossSources('whale', { client, includeWeb3: true })
    await findTraderAcrossSources('whale', { client, includeWeb3: false })
    expect(from).toHaveBeenCalledTimes(2)
  })

  it('clearSourceCache 后重新查询', async () => {
    const { client, from } = mockClient([{ data: [REC] }])
    await findTraderAcrossSources('whale', { client })
    clearSourceCache()
    await findTraderAcrossSources('whale', { client })
    expect(from).toHaveBeenCalledTimes(2)
  })
})

describe('findTradersAcrossSources — 批量 + 注入防护', () => {
  it('空 handles → 空 map,不发请求', async () => {
    const { client, from } = mockClient([{ data: [] }])
    const r = await findTradersAcrossSources([], { client })
    expect(r.size).toBe(0)
    expect(from).not.toHaveBeenCalled()
  })

  it('含 PostgREST 特殊字符的 handle 被过滤(防 filter 注入)', async () => {
    const { client, from } = mockClient([{ data: [] }])
    // 全部是注入尝试 → 全被过滤 → 不发请求
    const r = await findTradersAcrossSources(['a,b', 'c(d', 'e"f'], { client })
    expect(r.size).toBe(0)
    expect(from).not.toHaveBeenCalled()
  })

  it('结果按 handle 和 source_trader_id 双键入 map', async () => {
    const { client } = mockClient([{ data: [REC] }])
    const r = await findTradersAcrossSources(['whale'], { client })
    expect(r.get('whale')?.source_trader_id).toBe('id1')
    expect(r.get('id1')?.source_trader_id).toBe('id1')
  })

  it('DB error → 空 map(不抛)', async () => {
    const { client } = mockClient([{ data: null, error: { message: 'x' } }])
    const r = await findTradersAcrossSources(['whale'], { client })
    expect(r.size).toBe(0)
  })
})

describe('getTraderArenaFollowersCountBatch', () => {
  it('RPC 返回行 → 按交易所账户映射', async () => {
    const { client, rpc } = mockClient([
      {
        data: [
          { trader_id: 'shared', source: 'bybit', cnt: 5 },
          { trader_id: 'shared', source: 'binance', cnt: 1 },
        ],
      },
    ])
    const accounts = [
      { traderId: 'shared', source: 'bybit' },
      { traderId: 'shared', source: 'binance' },
    ]
    const r = await getTraderArenaFollowersCountBatch(client, accounts)
    expect(rpc).toHaveBeenCalledWith('count_trader_account_followers', {
      p_trader_ids: ['shared', 'shared'],
      p_sources: ['bybit', 'binance'],
    })
    expect(r.get(traderAccountKey(accounts[0]))).toBe(5)
    expect(r.get(traderAccountKey(accounts[1]))).toBe(1)
  })

  it('空账户 → 空 map 不调 RPC;RPC error → 空 map', async () => {
    const { client, rpc } = mockClient([{ data: null, error: { message: 'x' } }])
    expect((await getTraderArenaFollowersCountBatch(client, [])).size).toBe(0)
    expect(rpc).not.toHaveBeenCalled()
    expect(
      (await getTraderArenaFollowersCountBatch(client, [{ traderId: 't1', source: 'bybit' }])).size
    ).toBe(0)
  })
})
