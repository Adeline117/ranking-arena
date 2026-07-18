/**
 * Weekly Cross-Exchange ROI Arena mapper (spec §12.6) — BitMart reference
 * payload fixture is the REAL sources.meta.weekly_arena_latest shape
 * sampled from prod (2026-06-12, week 24).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getWeeklyLeaders } from '../weekly-leaders'

function rpcClient(data: unknown, error: unknown = null): SupabaseClient {
  return { rpc: jest.fn().mockResolvedValue({ data, error }) } as unknown as SupabaseClient
}

const WEEK_INFO = {
  week: 24,
  year: 2026,
  end_date: '2026-06-14',
  start_date: '2026-06-08',
  is_current_week: true,
}

const BITMART_WEEKLY = {
  week: WEEK_INFO,
  categories: {
    open: {
      list: [
        { roi: '0.796053', master_name: '鹤衍H', uuid: 'a', leverage_limit: '' },
        { roi: '0.254641', master_name: '银子的秘密', uuid: 'b', leverage_limit: '' },
      ],
      week_info: WEEK_INFO,
      last_update_time: '2026-06-12T03:48:18Z',
    },
    low_lev: {
      list: [{ roi: '0.05288', master_name: 'BTC多军头子', uuid: 'c', leverage_limit: '5' }],
      week_info: WEEK_INFO,
      last_update_time: '2026-06-12T03:48:18Z',
    },
    protected: {
      list: [{ roi: '0', master_name: '我可有钱', uuid: 'd', leverage_limit: '5' }],
      week_info: WEEK_INFO,
      last_update_time: '2026-06-12T03:48:18Z',
    },
  },
  fetched_at: '2026-06-12T03:54:44.235Z',
}

const RPC_PAYLOAD = {
  nonLegacyCount: 29,
  rows: [
    {
      source: 'bitget_futures',
      exchangeSlug: 'bitget',
      exchangeName: 'Bitget',
      productType: 'futures',
      exchangeTraderId: 'beb24d718eb23b54ac91',
      nickname: 'AI-HUB',
      traderKind: 'human',
      avatarMirrorUrl: 'https://x.supabase.co/storage/v1/object/public/trader-avatars/a.png',
      avatarOriginUrl: 'https://qrc.bgstatic.com/otc/images/a.png',
      sourceRank: 1,
      roi: 503144.33,
      pnl: { value: 7415.46, currency: 'USDT' },
      winRate: 60.52,
      derived: false,
      asOf: '2026-06-11T21:46:01.504405+00:00',
    },
    {
      source: 'hyperliquid',
      exchangeSlug: 'hyperliquid',
      exchangeName: 'Hyperliquid',
      productType: 'onchain',
      exchangeTraderId: '0xabc',
      nickname: null,
      traderKind: 'bot',
      avatarMirrorUrl: null,
      avatarOriginUrl: null,
      sourceRank: 3,
      roi: 88.1,
      pnl: null,
      winRate: null,
      derived: true,
      asOf: '2026-06-11T20:00:00Z',
    },
  ],
  bitmartWeekly: BITMART_WEEKLY,
}

describe('getWeeklyLeaders', () => {
  it('maps pooled rows with per-currency money and provenance', async () => {
    const client = rpcClient(RPC_PAYLOAD)
    const out = await getWeeklyLeaders(client, 50)
    expect(client.rpc).toHaveBeenCalledWith('arena_weekly_leaders', { p_limit: 50 })
    expect(out?.nonLegacyCount).toBe(29)
    expect(out?.rows).toHaveLength(2)

    const top = out!.rows[0]
    expect(top.exchangeName).toBe('Bitget')
    expect(top.roi).toBe(503144.33)
    expect(top.pnl).toEqual({ value: 7415.46, currency: 'USDT' })
    expect(top.avatarSrc).toBeTruthy()
    expect(top.provenance.derived).toBe(false)

    const second = out!.rows[1]
    expect(second.traderKind).toBe('bot')
    expect(second.pnl).toBeNull()
    expect(second.provenance.derived).toBe(true)
  })

  it('parses the real BitMart weekly payload: fractions → percent, 3 leagues', async () => {
    const out = await getWeeklyLeaders(rpcClient(RPC_PAYLOAD))
    const bm = out!.bitmart!
    expect(bm.year).toBe(2026)
    expect(bm.week).toBe(24)
    expect(bm.isCurrentWeek).toBe(true)
    expect(bm.categories.map((c) => c.key)).toEqual(['open', 'low_lev', 'protected'])
    expect(bm.categories[0].entries[0]).toEqual({
      name: '鹤衍H',
      roiPct: 79.61, // '0.796053' → 79.61
      leverageLimit: null, // '' collapses
    })
    expect(bm.categories[1].entries[0].leverageLimit).toBe('5')
    expect(bm.fetchedAt).toBe('2026-06-12T03:54:44.235Z')
  })

  it('tolerates missing bitmart panel and junk rows', async () => {
    const out = await getWeeklyLeaders(
      rpcClient({
        nonLegacyCount: 5,
        rows: [null, { source: 'x' }, 42],
        bitmartWeekly: null,
      })
    )
    expect(out?.rows).toEqual([])
    expect(out?.bitmart).toBeNull()
  })

  it('throws on RPC error so the page cannot render a false empty board', async () => {
    await expect(getWeeklyLeaders(rpcClient(null, { message: 'boom' }))).rejects.toThrow(
      'Weekly rankings request failed'
    )
  })

  it('throws on a malformed response instead of treating schema drift as empty data', async () => {
    await expect(getWeeklyLeaders(rpcClient({ rows: [] }))).rejects.toThrow(
      'Weekly rankings returned an invalid response'
    )
    await expect(getWeeklyLeaders(rpcClient({ nonLegacyCount: 5 }))).rejects.toThrow(
      'Weekly rankings returned an invalid response'
    )
  })

  it('keeps a successful empty response distinct from request failure', async () => {
    await expect(
      getWeeklyLeaders(rpcClient({ nonLegacyCount: 5, rows: [], bitmartWeekly: null }))
    ).resolves.toMatchObject({
      nonLegacyCount: 5,
      rows: [],
      bitmart: null,
    })
  })
})
