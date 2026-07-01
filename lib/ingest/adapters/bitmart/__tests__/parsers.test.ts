/**
 * BitMart AIHub parser tests over real RAW fixtures (captured live
 * 2026-06-12 via SG VPS from www.bitmart.com gw-api + master
 * UvNP-Ns4SE-wTpXeHzhlxA "鹤衍H"). Ranking fixtures truncated to the
 * page's visible rows (server post-filters hidden masters).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseBitmartHistory,
  parseBitmartLeaderboardPage,
  parseBitmartPositions,
  parseBitmartProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'bitmart_futures',
  currency: 'USDT',
  tfLabelMap: { '24H': null, '7D': 7, '1M': 30, '3M': 90 },
  scrapedAt: '2026-06-12T03:30:00.000Z',
  meta: {},
}

describe('parseBitmartLeaderboardPage', () => {
  it('parses the 7d board (fractions → percent; NAV + style tag kept)', () => {
    const page = parseBitmartLeaderboardPage(fixture('master-ranking-7d-p1.json'), ctx)
    expect(page.reportedTotal).toBe(123) // includes hidden masters
    expect(page.rows).toHaveLength(2)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: 'IHwQpya4QiiO56-79e9t_g',
      rank: 1,
      nickname: 'SmartSwitch AI',
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: -13.4932,
      headlinePnl: -159.7940409,
      headlineWinRate: 60.5769, // from the structured ai_comment block
      traderMeta: { master_tag: 6 },
      headlineCopierCount: 18, // item.copiers → trader_stats.copier_count (Phase A)
    })
    // board NAV + 盈亏比 → extras via registry aliases (was raw-only)
    expect(page.rows[0].headlineExtras).toMatchObject({ nav: 1.0062559033, pnl_ratio: 1.428402 })
    const raw = page.rows[0].raw as Record<string, unknown>
    expect(raw.nav).toBe('1.0062559033') // Latest NAV — verbatim
    expect(raw.copiers).toBe('18')
  })
})

describe('parseBitmartProfile', () => {
  const bundle = (tf: number) => ({
    getByUuid: fixture('get-by-uuid.json'),
    keyMetric: fixture('key-metric.json'),
    aumInfo: fixture('aum-info.json'),
    sheet: fixture('sheet.json'),
    chart: fixture('chart-1m.json'),
    assetPreferences: fixture('asset-preferences-1m.json'),
    radar: fixture('radar.json'),
    timeframe: tf,
  })

  it('maps the sheet 1M window + key metrics into canonical 30d stats', () => {
    const profile = parseBitmartProfile(bundle(30), ctx)
    expect(profile.nickname).toBe('鹤衍H')
    expect(profile.stats).toHaveLength(1)
    const stats = profile.stats[0]
    expect(stats.timeframe).toBe(30)
    expect(stats.asOf).toBe('2026-06-12T03:12:27.000Z') // sheet last_updated_at
    expect(stats.roi).toBe(31.2171) // window 3
    expect(stats.pnl).toBeCloseTo(446.41124, 4)
    expect(stats.mdd).toBe(41.2186)
    expect(stats.winRate).toBeCloseTo(40.8602, 3)
    expect(stats.copierPnl).toBeCloseTo(45.2634553, 5)
    expect(stats.copierCount).toBe(3)
    expect(stats.aum).toBeCloseTo(2642.1646, 4)
    expect(stats.profitShareRate).toBe(22) // commission_ratio "0.22"
    expect(stats.holdingDurationAvgHours).toBeCloseTo(11384.3076923077 / 3600, 5)
    expect(stats.tradingPreferences).toEqual({
      contracts: [{ contract: 'ETH', trade_amount: '577656.360272' }],
    })
    expect(stats.extras).toMatchObject({
      nav: 1.3732479301, // Latest NAV — Arena Score v2 gold
      total_equity: 1876.43124033,
      trades_per_day: 11.625,
      top_volume_share: 100,
      profit_loss_ratio: 1.502959,
      run_time_seconds: 646869,
    })
    expect((stats.extras.rank_rings as Record<string, unknown>).roi_point).toBeCloseTo(45.734, 3)
    expect(stats.extras.window_24h).toMatchObject({ window: 1 })
  })

  it('maps the sheet 3M window for 90d (derived-board substrate)', () => {
    const profile = parseBitmartProfile(bundle(90), ctx)
    expect(profile.stats[0].timeframe).toBe(90)
    expect(profile.stats[0].roi).toBe(31.2171) // window 4
  })

  it('builds cumulative roi/pnl + daily pnl series from the chart', () => {
    const profile = parseBitmartProfile(bundle(30), ctx)
    expect(profile.series.map((s) => s.metric)).toEqual(['roi', 'pnl', 'pnl_daily'])
    const roi = profile.series[0]
    expect(roi.points[0]).toEqual({ ts: '2026-06-04T00:00:00.000Z', value: 0 })
    expect(roi.points[roi.points.length - 1].value).toBe(43.8629)
    const daily = profile.series[2]
    expect(daily.points[daily.points.length - 1].value).toBeCloseTo(11.9031351, 5)
  })
})

describe('parseBitmartPositions', () => {
  it('parses open positions (mark price + unrealized PnL public)', () => {
    const positions = parseBitmartPositions(fixture('position-list.json'), ctx)
    expect(positions).toHaveLength(1)
    expect(positions[0]).toMatchObject({
      symbol: 'ETHUSDT',
      side: 'short', // position_type 2
      leverage: 200,
      size: 5.97,
      entryPrice: 1675.02,
      unrealizedPnl: 12.53,
    })
  })
})

describe('parseBitmartHistory', () => {
  it('parses closed positions (position_id dedupe; realised_profit USDT)', () => {
    const rows = parseBitmartHistory(fixture('position-history-p1.json'), 'position_history', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'position_history',
      openedAt: '2026-06-11T18:36:06.000Z',
      closedAt: '2026-06-12T00:03:13.000Z',
      symbol: 'ETHUSDT',
      side: 'short',
      leverage: 200,
      size: 18.999,
      entryPrice: 1682.88,
      exitPrice: 1669.87,
      realizedPnl: 217.48, // `pnl`/`roi` fields are ROI fractions, not USDT
    })
    expect(rows[0].dedupeHash).not.toBe(rows[1].dedupeHash)
  })

  it('parses order records with way-enum decoding', () => {
    const rows = parseBitmartHistory(fixture('order-history-p1.json'), 'orders', ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      kind: 'orders',
      ts: '2026-06-12T02:10:56.000Z',
      orderKind: 'open_short', // way 4
      symbol: 'ETHUSDT',
      side: 'short',
      price: 1675.02,
      qty: 5.97,
    })
  })

  it('parses transfers (to=1 → into the copy-trading account)', () => {
    const rows = parseBitmartHistory(fixture('transfer-record-p1.json'), 'transfers', ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'transfers',
      ts: '2026-06-04T15:48:19.000Z',
      direction: 'in',
      asset: 'USDT',
      amount: 1430.02,
    })
  })

  it('rejects the auth-only copier surface', () => {
    expect(() => parseBitmartHistory({}, 'copiers', ctx)).toThrow('not supported')
  })
})
