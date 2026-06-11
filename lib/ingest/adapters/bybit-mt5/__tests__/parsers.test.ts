import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseBybitMt5History,
  parseBybitMt5LeaderboardPage,
  parseBybitMt5Positions,
  parseBybitMt5Profile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'bybit_mt5',
  currency: 'USDx',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

describe('parseBybitMt5LeaderboardPage', () => {
  it('parses a live all-traders page (E-suffix decoding + totalCount)', () => {
    const page = parseBybitMt5LeaderboardPage(fixture('leaderboard-p1.json'), ctx)
    expect(page.reportedTotal).toBe(29572)
    expect(page.rows).toHaveLength(16)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: 'Eo/NS6p2APRTpkCgAHSbyg==',
      rank: 1,
      nickname: '猫和老鼠216',
      avatarUrlOrigin: 'https://s1.bycsi.com/user/avatars/1.png',
      headlineRoi: 895.37, // roeE4 "89537"
      headlinePnl: 72275.39999999, // masterPnlE8 "7227539999999"
      headlineWinRate: 58.35, // winRateE4 "5835"
      traderKind: 'human',
      traderMeta: { provider_level: 'Cadet' },
    })
    expect(page.rows[1].rank).toBe(2)
    // Board extras (sharpe, MDD, P2L...) preserved verbatim in raw
    expect(page.rows[0].raw).toMatchObject({ sharpeRatioE4: '1583', maxDrawDownE4: '10000' })
  })

  it('skips rows without providerMark and handles empty payloads', () => {
    const page = parseBybitMt5LeaderboardPage(
      { result: { providerDetailsList: [{ nickName: 'ghost' }], totalCount: '1' } },
      ctx
    )
    expect(page.rows).toHaveLength(0)
    expect(page.reportedTotal).toBe(1)
    expect(parseBybitMt5LeaderboardPage({}, ctx)).toEqual({ rows: [], reportedTotal: null })
  })
})

describe('parseBybitMt5Profile', () => {
  const bundle = (timeframe: number) => ({
    info: fixture('provider-info.json'),
    incomeDetail: fixture('income-detail.json'),
    yieldTrend: fixture(`yield-trend-${timeframe === 0 ? 90 : timeframe}.json`),
    timeframe,
  })

  it('extracts the 7d 表现 block incl. Sharpe + Sortino', () => {
    const profile = parseBybitMt5Profile(bundle(7), ctx)
    expect(profile.nickname).toBe('make.M')
    expect(profile.avatarUrlOrigin).toBe('https://s1.bycsi.com/user/avatars/default14.png')
    expect(profile.stats).toHaveLength(1)
    const st = profile.stats[0]
    expect(st).toMatchObject({
      timeframe: 7,
      roi: 371.81, // sevenDayRoeE4 "37181"
      pnl: 595.83, // sevenDayMasterPnlE8 "59583000000" (USDx)
      sharpe: 0.2195, // sevenDaySharpeRatioE4 "2195"
      mdd: 100, // sevenDayMaxDrawdownE4 "10000"
      winRate: 44.59,
      winPositions: 33,
      totalPositions: 74, // 33 wins + 41 losses
      copierPnl: 7.85, // sevenDayFollowersPnlE8 "785000000"
      copierCount: 0,
      aum: 0,
      profitShareRate: 15, // shareProfitRateE2 "15" → 15%
    })
    expect(st.holdingDurationAvgHours).toBeCloseTo(1488.351 / 3600, 6)
    expect(st.extras).toMatchObject({
      sortino: 1.6141, // sevenDaySortinoRatioE4 "16141"
      profit_to_loss_ratio: 1.77,
      weekly_trades: 148,
      roe_volatility: 364.66,
      trading_days: 209,
      provider_user_id: '525121896',
      total_assets: 0.86,
    })
    // lastTradedAtTimeE3 "0" → no last_traded_at key
    expect(st.extras.last_traded_at).toBeUndefined()
  })

  it('selects the per-TF prefix (30d/90d) from the same response', () => {
    const st30 = parseBybitMt5Profile(bundle(30), ctx).stats[0]
    expect(st30.timeframe).toBe(30)
    expect(st30.roi).toBe(288.45) // thirtyDayRoeE4 "28845"
    expect(st30.sharpe).toBe(0.1724)
    const st90 = parseBybitMt5Profile(bundle(90), ctx).stats[0]
    expect(st90.timeframe).toBe(90)
    expect(st90.roi).toBe(319.57) // ninetyDayRoeE4 "31957"
    expect(st90.totalPositions).toBe(136) // 58 + 78
  })

  it('maps timeframe 0 (inception) onto the 90d block', () => {
    expect(parseBybitMt5Profile(bundle(0), ctx).stats[0]?.timeframe).toBe(90)
  })

  it('parses the 获利 dual chart into roi/pnl series (+ roi_daily)', () => {
    const profile = parseBybitMt5Profile(bundle(7), ctx)
    const byMetric = Object.fromEntries(profile.series.map((s) => [s.metric, s]))
    expect(byMetric.roi.points).toHaveLength(7)
    expect(byMetric.pnl.points).toHaveLength(7)
    expect(byMetric.roi_daily.points).toHaveLength(7)
    // cumRoe last point "44484" → 444.84 %
    expect(byMetric.roi.points.at(-1)).toEqual({
      ts: new Date(1781049600000).toISOString(),
      value: 444.84,
    })
    // cumProfit last point "72471000000" → 724.71 USDx
    expect(byMetric.pnl.points.at(-1)?.value).toBe(724.71)
  })

  it('returns empty stats/series for a missing bundle', () => {
    const profile = parseBybitMt5Profile({}, ctx)
    expect(profile.stats).toHaveLength(0)
    expect(profile.series).toHaveLength(0)
  })
})

describe('parseBybitMt5Positions', () => {
  it('parses 当前开仓 rows (Buy/Sell → long/short, E8 values)', () => {
    const positions = parseBybitMt5Positions(fixture('open-positions.json'), ctx)
    expect(positions).toHaveLength(10)
    expect(positions[0]).toMatchObject({
      symbol: 'UKOUSD',
      side: 'long',
      leverage: null,
      size: 900.03, // positionValueE8 "90003000000" (USDx value)
      entryPrice: 90.796,
      markPrice: 90.003,
      unrealizedPnl: -7.93, // profitE8 "-793000000"
    })
    expect(positions[0].raw).toMatchObject({ stopLossPrice: '0.000' })
  })

  it('returns [] for an empty list', () => {
    expect(parseBybitMt5Positions({ result: { openPositionList: [] } }, ctx)).toEqual([])
    expect(parseBybitMt5Positions({}, ctx)).toEqual([])
  })
})

describe('parseBybitMt5History', () => {
  it('parses 平仓仓位 rows with UTC timestamps + stable dedupe hash', () => {
    const rows = parseBybitMt5History(fixture('history-positions-p1.json'), 'position_history', ctx)
    expect(rows).toHaveLength(10)
    const first = rows[0]
    expect(first).toMatchObject({
      kind: 'position_history',
      symbol: 'USOUSD',
      side: 'long',
      openedAt: '2026-06-11T12:44:59.000Z',
      closedAt: '2026-06-11T12:53:13.000Z',
      entryPrice: 90.421,
      exitPrice: 90.098,
      size: 900.98,
      realizedPnl: -3.26,
    })
    // Hash is deterministic across re-parses (spec §5.5 re-parse guarantee)
    const again = parseBybitMt5History(
      fixture('history-positions-p1.json'),
      'position_history',
      ctx
    )
    expect(again[0].dedupeHash).toBe(first.dedupeHash)
    // ...and unique across rows of the page
    expect(new Set(rows.map((r) => r.dedupeHash)).size).toBe(10)
  })

  it('throws for unsupported history kinds', () => {
    expect(() => parseBybitMt5History({}, 'copiers', ctx)).toThrow('not supported')
    expect(() => parseBybitMt5History({}, 'orders', ctx)).toThrow('not supported')
  })
})
