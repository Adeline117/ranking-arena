import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseGateHistory,
  parseGateLeaderboardPage,
  parseGatePositions,
  parseGateProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'gate_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

const cfdCtx: ParseCtx = { ...ctx, sourceSlug: 'gate_cfd', currency: 'USDx' }

describe('parseGateLeaderboardPage', () => {
  it('parses the futures full_ranking list (decimal rates → percent)', () => {
    const page = parseGateLeaderboardPage(fixture('leaderboard-fut-p1.json'), ctx)
    expect(page.reportedTotal).toBe(734)
    expect(page.rows).toHaveLength(3)
    const first = page.rows[0]
    expect(first.exchangeTraderId).toBe('3355')
    expect(first.rank).toBe(1)
    expect(first.nickname).toBeTruthy()
    expect(first.traderKind).toBe('human')
    // profit_rate 14.4897 (decimal) → 1448.97%
    expect(first.headlineRoi).toBeCloseTo(1448.97, 1)
    expect(first.headlineWinRate).toBeCloseTo(50, 5)
    expect(first.headlineMdd).toBeCloseTo(29.7, 1) // max_drawdown 0.297 decimal → percent
    expect(first.headlineAum).toBeCloseTo(10, 5)
    expect(first.raw).toMatchObject({ leader_id: 3355 })
  })

  it('parses the tradfi list (lists key)', () => {
    const page = parseGateLeaderboardPage(fixture('leaderboard-cfd-p1.json'), cfdCtx)
    expect(page.reportedTotal).toBe(2725)
    expect(page.rows.length).toBeGreaterThan(0)
    const first = page.rows[0]
    expect(first.exchangeTraderId).toBe('144647')
    expect(first.headlineRoi).toBeCloseTo(38.647258, 3)
    expect(first.headlineWinRate).toBeCloseTo(73.33, 2)
  })

  it('returns empty on malformed payloads', () => {
    expect(parseGateLeaderboardPage({}, ctx).rows).toHaveLength(0)
    expect(parseGateLeaderboardPage({ data: { list: 'nope' } }, ctx).rows).toHaveLength(0)
  })
})

describe('parseGateProfile (futures)', () => {
  const bundle = {
    detail: fixture('detail-fut.json'),
    profitChart: fixture('profit-chart-30.json'),
    positionComposition: fixture('position-composition-30.json'),
    timeframe: 30,
  }

  it('maps the month_profit block to 30d stats', () => {
    const profile = parseGateProfile(bundle, ctx)
    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s.timeframe).toBe(30)
    // simple_profit_rate 0.346 → 34.6% (简单收益率 = board mode)
    expect(s.roi).toBeCloseTo(34.6, 2)
    expect(s.pnl).toBeCloseTo(24120.01, 2)
    expect(s.mdd).toBeCloseTo(13.88, 2)
    expect(s.sharpe).toBeCloseTo(3.56, 2)
    expect(s.winPositions).toBe(33)
    expect(s.totalPositions).toBe(59)
    expect(s.winRate).toBeCloseTo((33 / 59) * 100, 4)
    expect(s.copierPnl).toBeCloseTo(-354.31, 2)
    expect(s.copierCount).toBe(80)
    expect(s.profitShareRate).toBeCloseTo(12, 5)
    // 数据更新时间 from update_time epoch seconds
    expect(s.asOf).toBe(new Date(1781222256 * 1000).toISOString())
    // net-value dual mode preserved
    expect(s.extras.roi_net_value).toBeCloseTo(749.64, 2)
    expect(s.extras.style_labels).toEqual(['short-line', 'high-frequence', 'radical'])
    expect(s.tradingPreferences).toBeTruthy()
    // 交易频率: raw per-day (1.96 = 59 trades / 30d) + per-week alias for display
    expect(s.extras.trading_frequency).toBeCloseTo(1.96, 2)
    expect(s.extras.trade_frequency).toBeCloseTo(13.72, 2) // 1.96 × 7
  })

  it('emits roi/pnl/pnl_daily/lead_size series from profit_chart', () => {
    const profile = parseGateProfile(bundle, ctx)
    const metrics = profile.series.map((s) => s.metric).sort()
    expect(metrics).toEqual(['lead_size', 'pnl', 'pnl_daily', 'roi'])
    const roi = profile.series.find((s) => s.metric === 'roi')!
    expect(roi.timeframe).toBe(30)
    expect(roi.points.length).toBeGreaterThan(10)
    expect(roi.points[0].ts.endsWith('Z')).toBe(true)
  })

  it('omits last_liquidation_at when liquidation_time = 0', () => {
    const profile = parseGateProfile(bundle, ctx)
    expect(profile.stats[0].extras.last_liquidation_at).toBeUndefined()
  })

  it('surfaces 最近强制平仓时间 when liquidation_time > 0', () => {
    const detail = JSON.parse(JSON.stringify(fixture('detail-fut.json'))) as {
      data: { profit: Record<string, unknown> }
    }
    detail.data.profit.liquidation_time = 1781000000
    const profile = parseGateProfile({ ...bundle, detail }, ctx)
    expect(profile.stats[0].extras.last_liquidation_at).toBe(
      new Date(1781000000 * 1000).toISOString()
    )
  })
})

describe('parseGateProfile (cfd)', () => {
  it('maps trade/info + lead/info + yield curves', () => {
    const profile = parseGateProfile(
      {
        tradeInfo: fixture('trade-info-cfd-30.json'),
        leadInfo: fixture('lead-info-cfd.json'),
        yieldData: fixture('yield-cfd-30.json'),
        timeframe: 30,
      },
      cfdCtx
    )
    expect(profile.stats).toHaveLength(1)
    const s = profile.stats[0]
    expect(s.roi).toBeCloseTo(38.647258, 3)
    expect(s.pnl).toBeCloseTo(28390.96, 2)
    expect(s.winRate).toBeCloseTo(73.33, 2)
    expect(s.winPositions).toBe(11)
    expect(s.totalPositions).toBe(15)
    expect(s.copierPnl).toBeCloseTo(78602.58, 2)
    expect(s.copierCount).toBe(1)
    expect(s.profitShareRate).toBeCloseTo(20, 5)
    expect(s.extras.leading_days).toBe(17)
    // daily_trade_freq 0.8824/day → per-week alias 6.18; unrealized_pnl surfaced
    expect(s.extras.trading_frequency).toBeCloseTo(0.8824, 4)
    expect(s.extras.trade_frequency).toBeCloseTo(6.18, 2)
    expect(s.extras.unrealized_pnl).toBe(0) // lead-info "0.00"
    expect(profile.nickname).toBe('1000X带单')
    const metrics = profile.series.map((x) => x.metric).sort()
    expect(metrics).toEqual(['pnl', 'roi'])
  })
})

describe('parseGatePositions', () => {
  it('parses futures open positions', () => {
    const positions = parseGatePositions(fixture('positions-fut.json'), ctx)
    expect(positions.length).toBeGreaterThan(0)
    const p = positions[0]
    expect(p.symbol).toBe('BTC_USDT')
    expect(p.side).toBe('long')
    expect(p.size).toBe(8000)
    expect(p.entryPrice).toBeCloseTo(69841.1, 1)
    expect(p.unrealizedPnl).toBeCloseTo(4978.93, 2)
  })
})

describe('parseGateHistory', () => {
  it('parses futures 历史带单 with stable id hash', () => {
    const rows = parseGateHistory(fixture('close-position-p1.json'), 'position_history', ctx)
    expect(rows.length).toBeGreaterThan(0)
    const r = rows[0] as Extract<(typeof rows)[0], { kind: 'position_history' }>
    expect(r.symbol).toBe('BEAT_USDT')
    expect(r.side).toBe('long')
    expect(r.realizedPnl).toBeCloseTo(150.31, 2)
    expect(r.openedAt).toBe(new Date(1781179824 * 1000).toISOString())
    expect(r.closedAt).toBe(new Date(1781187463 * 1000).toISOString())
    const again = parseGateHistory(fixture('close-position-p1.json'), 'position_history', ctx)
    expect(again[0].dedupeHash).toBe(r.dedupeHash)
  })

  it('parses tradfi 历史仓位 (data.list shape)', () => {
    const rows = parseGateHistory(
      fixture('positions-history-cfd-p1.json'),
      'position_history',
      cfdCtx
    )
    expect(rows.length).toBeGreaterThan(0)
    const r = rows[0] as Extract<(typeof rows)[0], { kind: 'position_history' }>
    expect(r.symbol).toBe('XAUUSD')
    expect(r.side).toBe('short')
    expect(r.leverage).toBe(500)
    expect(r.realizedPnl).toBeCloseTo(3056, 2)
  })

  it('parses 成交记录 fills', () => {
    const rows = parseGateHistory(fixture('history-order-list-p1.json'), 'orders', ctx)
    expect(rows.length).toBeGreaterThan(0)
    const r = rows[0] as Extract<(typeof rows)[0], { kind: 'orders' }>
    expect(r.symbol).toBe('BEAT_USDT')
    expect(r.side).toBe('buy')
    expect(r.price).toBeCloseTo(9.453, 3)
  })

  it('parses 划转记录 with direction from side', () => {
    const rows = parseGateHistory(fixture('transfer-records-p1.json'), 'transfers', ctx)
    expect(rows.length).toBe(5)
    const r = rows[0] as Extract<(typeof rows)[0], { kind: 'transfers' }>
    expect(r.direction).toBe('out') // side 2, amount -500
    expect(r.amount).toBe(500)
    const r2 = rows[1] as Extract<(typeof rows)[0], { kind: 'transfers' }>
    expect(r2.direction).toBe('in')
  })

  it('parses futures copiers (follow_user) without rendering-grade PII', () => {
    const rows = parseGateHistory(fixture('follow-user-p1.json'), 'copiers', ctx)
    expect(rows.length).toBeGreaterThan(0)
    const r = rows[0] as Extract<(typeof rows)[0], { kind: 'copiers' }>
    expect(r.copierInvested).toBeCloseTo(2750, 2)
    expect(r.copierPnl).toBeCloseTo(116.86, 2)
  })

  it('parses tradfi copiers (followers list shape)', () => {
    const rows = parseGateHistory(fixture('followers-cfd-p1.json'), 'copiers', cfdCtx)
    expect(rows.length).toBeGreaterThan(0)
    const r = rows[0] as Extract<(typeof rows)[0], { kind: 'copiers' }>
    expect(r.copierInvested).toBeCloseTo(33500, 2)
    expect(r.copyDurationDays).toBe(4)
  })
})
