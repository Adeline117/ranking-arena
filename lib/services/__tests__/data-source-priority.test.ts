/**
 * data-source-priority — 每个 trader 用哪份数据的优先级链。
 * Authorized(绑 API key) > Public API > Enrichment > Historical。
 * 链走错=已验证交易员显示过期数据 or 未验证的冒充已验证。
 */

jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }))

import {
  getTraderDataWithPriority,
  isTraderAuthorized,
  getSourceLabel,
  DataSourcePriority,
} from '../data-source-priority'
import type { SupabaseClient } from '@supabase/supabase-js'

/** 队列式 mock:每次 maybeSingle() 按顺序消费一个预置响应 */
function queueClient(responses: Array<{ data?: unknown; error?: { message: string } | null }>) {
  let i = 0
  const next = () => {
    const r = responses[Math.min(i++, responses.length - 1)] ?? {}
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null })
  }
  const from = jest.fn(() => {
    const obj: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'not', 'gte', 'order', 'limit']) obj[m] = () => obj
    obj.maybeSingle = () => next()
    return obj
  })
  return { client: { from } as unknown as SupabaseClient, from }
}

const SNAPSHOT = {
  roi: 50,
  pnl: 1000,
  win_rate: 60,
  max_drawdown: 20,
  trades_count: 100,
  sharpe_ratio: 1.5,
  followers: 10,
  arena_score: 80,
  computed_at: '2026-07-03T00:00:00Z',
}

describe('优先级链', () => {
  it('有 userId + 活跃授权 + 快照 → AUTHORIZED(带 verifiedAt/authorizationId)', async () => {
    const { client } = queueClient([
      { data: { id: 'auth-1' } },
      {
        data: {
          authorization_id: 'auth-1',
          last_sync_at: '2026-07-01T00:00:00Z',
        },
      },
      { data: SNAPSHOT },
    ])
    const r = await getTraderDataWithPriority(client, 'bybit', 'tk1', 'user-1')
    expect(r.source).toBe(DataSourcePriority.AUTHORIZED)
    expect(r.sourceLabel).toBe('authorized')
    expect(r.isVerified).toBe(true)
    expect(r.authorizationId).toBe('auth-1')
    expect(r.data.roi).toBe(50)
  })

  it('有 userId 但无授权 → 落到 PUBLIC(带他人验证徽章查询)', async () => {
    const { client } = queueClient([
      { data: null }, // auth 无
      { data: SNAPSHOT }, // public
      { data: { authorization_id: 'auth-2', last_sync_at: '2026-06-01T00:00:00Z' } },
    ])
    const r = await getTraderDataWithPriority(client, 'bybit', 'tk1', 'user-1')
    expect(r.source).toBe(DataSourcePriority.PUBLIC_API)
    expect(r.isVerified).toBe(true) // 被别人验证过 → 徽章
    expect(r.verifiedAt).toBe('2026-06-01T00:00:00Z')
    expect(r.authorizationId).toBeNull() // 但不是本用户的授权
  })

  it('无 userId → 直接 PUBLIC,未验证时徽章 false', async () => {
    const { client } = queueClient([
      { data: SNAPSHOT }, // public
      { data: null }, // verified_traders 无
    ])
    const r = await getTraderDataWithPriority(client, 'bybit', 'tk1')
    expect(r.source).toBe(DataSourcePriority.PUBLIC_API)
    expect(r.isVerified).toBe(false)
  })

  it('public 无数据 → 落到 ENRICHMENT', async () => {
    const { client } = queueClient([
      { data: null }, // public
      { data: { roi: 30, pnl: 500, computed_at: '2026-07-01T00:00:00Z' } }, // enrichment
    ])
    const r = await getTraderDataWithPriority(client, 'bybit', 'tk1')
    expect(r.source).toBe(DataSourcePriority.ENRICHMENT)
    expect(r.sourceLabel).toBe('enrichment')
    expect(r.data.roi).toBe(30)
  })

  it('全链无数据 → HISTORICAL 兜底(全 null 但不抛)', async () => {
    const { client } = queueClient([{ data: null }])
    const r = await getTraderDataWithPriority(client, 'bybit', 'tk1')
    expect(r.source).toBe(DataSourcePriority.HISTORICAL)
    expect(r.data.roi).toBeNull()
    expect(r.data.platform).toBe('bybit') // 身份字段保留
  })

  it('有授权但无快照数据 → 不冒充 AUTHORIZED,继续走链', async () => {
    const { client } = queueClient([
      { data: { id: 'auth-1' } },
      { data: { authorization_id: 'auth-1', last_sync_at: '2026-07-01T00:00:00Z' } },
      { data: null }, // authorized 路径的快照缺
      { data: SNAPSHOT }, // public 有
      { data: null }, // verification
    ])
    const r = await getTraderDataWithPriority(client, 'bybit', 'tk1', 'user-1')
    expect(r.source).toBe(DataSourcePriority.PUBLIC_API)
  })
})

describe('isTraderAuthorized', () => {
  it('有活跃授权 → true + id + 时间', async () => {
    const { client } = queueClient([
      { data: { authorization_id: 'a1', last_sync_at: '2026-07-01T00:00:00Z' } },
    ])
    const r = await isTraderAuthorized(client, 'bybit', 'tk1')
    expect(r).toEqual({
      authorized: true,
      authorizationId: 'a1',
      lastVerifiedAt: '2026-07-01T00:00:00Z',
    })
  })

  it('无授权 → false', async () => {
    const { client } = queueClient([{ data: null }])
    expect((await isTraderAuthorized(client, 'bybit', 'tk1')).authorized).toBe(false)
  })

  it('查询 error → false(fail closed,不误标已验证)', async () => {
    const { client } = queueClient([{ data: null, error: { message: 'boom' } }])
    const r = await isTraderAuthorized(client, 'bybit', 'tk1')
    expect(r.authorized).toBe(false)
    expect(r.authorizationId).toBeNull()
  })
})

describe('getSourceLabel', () => {
  it('四级标签齐全', () => {
    expect(getSourceLabel(DataSourcePriority.AUTHORIZED)).toBe('Verified Data')
    expect(getSourceLabel(DataSourcePriority.PUBLIC_API)).toBe('Public Data')
    expect(getSourceLabel(DataSourcePriority.ENRICHMENT)).toBe('Derived Data')
    expect(getSourceLabel(DataSourcePriority.HISTORICAL)).toBe('Historical Data')
  })
})
