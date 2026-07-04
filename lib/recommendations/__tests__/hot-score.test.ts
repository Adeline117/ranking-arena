/**
 * hot-score — 热门交易员信号聚合(ROI 动量/粉丝增速/交易频率/时间衰减)。
 * 权重 0.35/0.2/0.15/0.3;驱动发现页排序。
 */

const mockResponses: Record<string, { data: unknown; error?: unknown }> = {}
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const resp = mockResponses[table] ?? { data: [] }
      const p = Promise.resolve({ data: resp.data, error: resp.error ?? null })
      const obj: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'not', 'or', 'in', 'gte', 'order']) obj[m] = () => obj
      obj.limit = () => p
      obj.then = (...args: Parameters<Promise<unknown>['then']>) => p.then(...args)
      return obj
    },
  }),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

import { computeHotTraders } from '../hot-score'

function rank(id: string, overrides: Record<string, unknown> = {}) {
  return {
    source: 'bybit',
    source_trader_id: id,
    handle: id,
    avatar_url: null,
    arena_score: 80,
    roi: 50,
    pnl: 1000,
    win_rate: 60,
    followers: 100,
    ...overrides,
  }
}

function snap(id: string, date: string, roi: number, followers: number, trades: number) {
  return { platform: 'bybit', trader_key: id, roi, followers, trades_count: trades, date }
}

beforeEach(() => {
  for (const k of Object.keys(mockResponses)) delete mockResponses[k]
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-07-03T00:00:00Z'))
})
afterEach(() => jest.useRealTimers())

describe('computeHotTraders', () => {
  it('ranks 查询失败/为空 → []', async () => {
    mockResponses.leaderboard_ranks = { data: null, error: { message: 'x' } }
    expect(await computeHotTraders()).toEqual([])
    mockResponses.leaderboard_ranks = { data: [] }
    expect(await computeHotTraders()).toEqual([])
  })

  it('满信号交易员信号值精确(动量/增速/频率=1,recency 按 12h 半衰期)', async () => {
    mockResponses.leaderboard_ranks = { data: [rank('hot1')] }
    mockResponses.trader_daily_snapshots = {
      data: [
        snap('hot1', '2026-07-01', 0, 100, 5), // 旧
        snap('hot1', '2026-07-02', 10, 110, 10), // 新:+10pp roi、+10% 粉、交易增
      ],
    }
    const [t] = await computeHotTraders()
    expect(t.signals.roiMomentum).toBe(1) // 10pp/10 = 1
    expect(t.signals.followerGrowth).toBe(1) // 10%/10% = 1
    expect(t.signals.tradingFrequency).toBe(1)
    // 最新快照 2026-07-02,now=07-03 → 24h → exp(-0.693*24/12)≈0.25
    expect(t.signals.recency).toBeCloseTo(0.25, 2)
    // hot = 0.35+0.2+0.15+0.3*0.25 = 0.775
    expect(t.hot_score).toBeCloseTo(0.775, 3)
  })

  it('动量交易员排在无历史的静态交易员前面', async () => {
    mockResponses.leaderboard_ranks = { data: [rank('static', { roi: 50 }), rank('momentum')] }
    mockResponses.trader_daily_snapshots = {
      data: [
        snap('momentum', '2026-07-01', 0, 100, 5),
        snap('momentum', '2026-07-02', 10, 110, 10),
      ],
    }
    const list = await computeHotTraders()
    expect(list[0].source_trader_id).toBe('momentum')
    // static:momentum=clamp(50/100,0,0.3)=0.3,recency 默认 0.5 → 0.35*0.3+0.3*0.5=0.255
    const staticT = list.find((t) => t.source_trader_id === 'static')!
    expect(staticT.hot_score).toBeCloseTo(0.255, 3)
  })

  it('ROI 下跌 → 负动量(可为负分量)', async () => {
    mockResponses.leaderboard_ranks = { data: [rank('falling')] }
    mockResponses.trader_daily_snapshots = {
      data: [snap('falling', '2026-07-01', 20, 100, 5), snap('falling', '2026-07-02', 0, 100, 5)],
    }
    const [t] = await computeHotTraders()
    expect(t.signals.roiMomentum).toBe(-1) // -20pp/10 clamp 到 -1
    expect(t.signals.tradingFrequency).toBe(0) // 交易数没变
  })

  it('粉丝从 0 起步 → growth 0.5(冷启动信号)', async () => {
    mockResponses.leaderboard_ranks = { data: [rank('newbie')] }
    mockResponses.trader_daily_snapshots = {
      data: [snap('newbie', '2026-07-01', 5, 0, 1), snap('newbie', '2026-07-02', 6, 50, 2)],
    }
    const [t] = await computeHotTraders()
    expect(t.signals.followerGrowth).toBe(0.5)
  })

  it('limit 生效 + 按 hot_score 降序', async () => {
    mockResponses.leaderboard_ranks = {
      data: [rank('a', { roi: 10 }), rank('b', { roi: 90 }), rank('c', { roi: 50 })],
    }
    mockResponses.trader_daily_snapshots = { data: [] }
    const list = await computeHotTraders(2)
    expect(list).toHaveLength(2)
    const scores = list.map((t) => t.hot_score)
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1])
    expect(list[0].source_trader_id).toBe('b') // roi 90 → momentum clamp 0.3 最高档
  })
})
