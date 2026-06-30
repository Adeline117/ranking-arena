import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseBybitCopytradeHistory,
  parseBybitCopytradeLeaderboardPage,
  parseBybitCopytradePositions,
  parseBybitCopytradeProfile,
} from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'bybit_copytrade',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

describe('parseBybitCopytradeLeaderboardPage', () => {
  it('parses a live all-traders page (display-string columns + totalCount)', () => {
    const page = parseBybitCopytradeLeaderboardPage(fixture('leaderboard-p1.json'), ctx)
    expect(page.reportedTotal).toBe(8781)
    expect(page.rows).toHaveLength(16)
    expect(page.rows[0]).toMatchObject({
      exchangeTraderId: 'S9LoGlRC6qFD5thjUyzWrQ==',
      rank: 1,
      nickname: 'Puma Osorio',
      avatarUrlOrigin:
        'https://s1.bycsi.com/fop/copytrade/ad427341-542b-4388-958e-59b36c0e7451.png',
      traderKind: 'human',
      headlineRoi: 11.36, // metricValues[0] "+11.36%"
      headlinePnl: null, // board has no master-PnL column
      headlineWinRate: 100, // "+100.00%"
      headlineMdd: 0, // Drawdown column (already percent) → board captures MDD
    })
    expect(page.rows[1].rank).toBe(2)
  })

  it('maps badge/level/country metadata into traderMeta (spec §11.3)', () => {
    const page = parseBybitCopytradeLeaderboardPage(fixture('leaderboard-p1.json'), ctx)
    expect(page.rows[0].traderMeta).toEqual({
      leader_level: 'COPY_TRADE_LEADER_LEVEL_SILVER_TRADER',
      country_code: 'MX',
      leader_user_id: '438928277',
      user_tags: ['Top Profit', 'Low Leverage', 'Trend Trader'],
    })
  })

  it('resolves metricValues against metricColumns into raw._metrics', () => {
    const page = parseBybitCopytradeLeaderboardPage(fixture('leaderboard-p1.json'), ctx)
    expect(page.rows[0].raw._metrics).toEqual({
      roi: 11.36,
      drawdown: 0,
      follower_pnl: 30564.63, // "+30,564.63"
      win_rate: 100,
      profit_loss_ratio: '45.49 : 0', // ratio stays a display string
      sharpe: 3.47,
    })
    // Verbatim board row preserved alongside
    expect(page.rows[0].raw).toMatchObject({ followerYieldE8: '3056462640874' })
  })

  it('skips rows without leaderMark and handles empty payloads', () => {
    const page = parseBybitCopytradeLeaderboardPage(
      { result: { leaderDetails: [{ nickName: 'ghost' }], totalCount: '1' } },
      ctx
    )
    expect(page.rows).toHaveLength(0)
    expect(page.reportedTotal).toBe(1)
    expect(parseBybitCopytradeLeaderboardPage({}, ctx)).toEqual({ rows: [], reportedTotal: null })
  })
})

describe('parseBybitCopytradeProfile', () => {
  const bundle = (timeframe: number) => ({
    info: fixture('pub-leader-info.json'),
    income: fixture('leader-income.json'),
    yieldTrend: fixture(`yield-trend-${timeframe === 0 ? 90 : timeframe}.json`),
    timeframe,
  })

  it('extracts the 7d 表现 block incl. Sharpe + Sortino', () => {
    const profile = parseBybitCopytradeProfile(bundle(7), ctx)
    expect(profile.nickname).toBe('Camry759')
    expect(profile.avatarUrlOrigin).toBe(
      'https://s1.bycsi.com/fop/copytrade/3a1f62c9-a943-4c4c-ab7c-7e7caef468eb.png'
    )
    expect(profile.stats).toHaveLength(1)
    const st = profile.stats[0]
    expect(st).toMatchObject({
      timeframe: 7,
      roi: -19.45, // sevenDayYieldRateE4 "-1945"
      sharpe: -2.4707, // sevenDaySharpeRatioE4 "-24707" (UI: -2.47)
      mdd: 17.71, // sevenDayDrawDownE4 "1771"
      winRate: 7.55, // sevenDayProfitWinRateE4 "755" (UI: 7.55%)
      winPositions: 3,
      totalPositions: 4, // 3 wins + 1 loss
      copierCount: 41,
      aum: 428768.14, // aumE8 "42876814000000"
      profitShareRate: 10, // shareProfitRateE8 "10000000" → 10%
      volume: null,
    })
    expect(st.pnl).toBeCloseTo(-214.7256, 4) // sevenDayProfitE8
    expect(st.copierPnl).toBeCloseTo(23125.8897, 4) // sevenDayFollowerYieldE8
    // sevenDayAvePositionTime "13198" is MINUTES (UI: 9.16 days)
    expect(st.holdingDurationAvgHours).toBeCloseTo(13198 / 60, 6)
    expect(st.extras).toMatchObject({
      sortino: -1.5208, // sevenDaySortinoRatioE4 (UI: -1.52)
      profit_to_loss_ratio: 23.6898, // sevenDayYieldLossRatioE4 "236898"
      weekly_trades: 3, // sevenDayWeekTradeCountE2 "300"
      roe_volatility: 2.98, // sevenDayReturnVolatilityE4 "298"
      last_traded_at: new Date(1781198942753).toISOString(),
      stability_score: 2.5, // stableScoreLevelE1 "25" → 2.5/5.0
      trading_days: 930,
      leader_user_id: '112764932',
      cum_follower_count: 1533,
      max_follower_count: 250,
    })
    expect(st.extras.avg_pnl_per_trade).toBeCloseTo(138.3619, 4)
  })

  it('selects the per-TF prefix (30d/90d) from the same response', () => {
    const st30 = parseBybitCopytradeProfile(bundle(30), ctx).stats[0]
    expect(st30.timeframe).toBe(30)
    expect(st30.roi).toBe(-25.23) // thirtyDayYieldRateE4 "-2523"
    const st90 = parseBybitCopytradeProfile(bundle(90), ctx).stats[0]
    expect(st90.timeframe).toBe(90)
    expect(st90.roi).toBe(-28.62) // ninetyDayYieldRateE4 "-2862"
    expect(st90.totalPositions).toBe(65) // 15 + 50
  })

  it('maps timeframe 0 (inception) onto the 90d block', () => {
    expect(parseBybitCopytradeProfile(bundle(0), ctx).stats[0]?.timeframe).toBe(90)
  })

  it('emits base series from the 全部 scope; no variants for all-zero bot scope', () => {
    const profile = parseBybitCopytradeProfile(bundle(7), ctx)
    const byMetric = Object.fromEntries(profile.series.map((s) => [s.metric, s]))
    // metricListBot is all-zero for this trader → base metrics only
    expect(Object.keys(byMetric).sort()).toEqual(['pnl', 'roi', 'roi_daily'])
    expect(byMetric.roi.points).toHaveLength(7)
    // cumResetRoi last point "1135" → 11.35 %
    expect(byMetric.roi.points.at(-1)).toEqual({
      ts: new Date(1781049600000).toISOString(),
      value: 11.35,
    })
    // cumResetPnl last point "20815500069" → 208.155 USDT
    expect(byMetric.pnl.points.at(-1)?.value).toBeCloseTo(208.155, 3)
    expect(byMetric.roi_daily.points.at(-1)?.value).toBe(0.5) // yieldRate "50"
  })

  it('emits _trading/_bot scope variants when the bot scope has signal (spec §1.3)', () => {
    // Structure mirrors the live capture; values synthesized because no
    // bot-running trader existed in the top-48 board sample on 2026-06-11.
    const lines = (roi: string, pnl: string) => [
      {
        line: 'cumResetRoi',
        showType: 'percent',
        metricLineValue: [{ statisticDate: '1781049600000', value: roi }],
      },
      {
        line: 'cumResetPnl',
        showType: 'num',
        metricLineValue: [{ statisticDate: '1781049600000', value: pnl }],
      },
    ]
    const profile = parseBybitCopytradeProfile(
      {
        income: fixture('leader-income.json'),
        yieldTrend: {
          result: {
            metricList: lines('1000', '50000000000'), // trading: 10% / 500
            metricListBot: lines('135', '12300000000'), // bot: 1.35% / 123
            metricListAll: lines('1135', '62300000000'), // all: 11.35% / 623
          },
        },
        timeframe: 7,
      },
      ctx
    )
    const byMetric = Object.fromEntries(profile.series.map((s) => [s.metric, s]))
    expect(Object.keys(byMetric).sort()).toEqual([
      'pnl',
      'pnl_bot',
      'pnl_trading',
      'roi',
      'roi_bot',
      'roi_trading',
    ])
    expect(byMetric.roi.points[0].value).toBe(11.35) // base ← 全部
    expect(byMetric.roi_trading.points[0].value).toBe(10) // 交易
    expect(byMetric.roi_bot.points[0].value).toBe(1.35) // 机器人
    expect(byMetric.pnl_bot.points[0].value).toBe(123)
  })

  it('returns empty stats/series for a missing bundle', () => {
    const profile = parseBybitCopytradeProfile({}, ctx)
    expect(profile.stats).toHaveLength(0)
    expect(profile.series).toHaveLength(0)
  })
})

describe('parseBybitCopytradePositions', () => {
  it('parses 当前开仓 rows (Buy/Sell → long/short, E-suffix decoding)', () => {
    const positions = parseBybitCopytradePositions(fixture('position-list.json'), ctx)
    expect(positions).toHaveLength(2)
    expect(positions[0]).toMatchObject({
      symbol: 'UNIUSDT',
      side: 'long',
      leverage: 10, // leverageE2 "1000"
      size: 304.2, // sizeX "30420000000" (base qty)
      entryPrice: 5.67055827,
      markPrice: null, // not in payload — UI computes from live tickers
      unrealizedPnl: null,
    })
    expect(positions[1].size).toBe(11442) // POL qty matches rendered UI
  })

  it('returns [] for protected traders (openTradeInfoProtection)', () => {
    expect(
      parseBybitCopytradePositions({ result: { data: [], openTradeInfoProtection: 1 } }, ctx)
    ).toEqual([])
    expect(parseBybitCopytradePositions({}, ctx)).toEqual([])
  })
})

describe('parseBybitCopytradeHistory', () => {
  it('parses past trades with orderId-keyed dedupe hashes', () => {
    const rows = parseBybitCopytradeHistory(
      fixture('leader-history-p1.json'),
      'position_history',
      ctx
    )
    expect(rows).toHaveLength(8)
    const first = rows[0]
    expect(first).toMatchObject({
      kind: 'position_history',
      symbol: 'BTCUSDT',
      side: 'short', // side "Sell"
      leverage: 10,
      size: 0.028,
      entryPrice: 62383.9,
      exitPrice: 62607.8,
      openedAt: new Date(1781197446786).toISOString(),
      closedAt: new Date(1781198942759).toISOString(),
    })
    expect(first.kind === 'position_history' && first.realizedPnl).toBeCloseTo(-8.651, 3)
    // Hash is deterministic across re-parses (spec §5.5) and unique per row
    const again = parseBybitCopytradeHistory(
      fixture('leader-history-p1.json'),
      'position_history',
      ctx
    )
    expect(again[0].dedupeHash).toBe(first.dedupeHash)
    expect(new Set(rows.map((r) => r.dedupeHash)).size).toBe(8)
  })

  it('parses copier rows (pre-masked labels, PII never rendered)', () => {
    const rows = parseBybitCopytradeHistory(fixture('other-follower-p1.json'), 'copiers', ctx)
    expect(rows).toHaveLength(18)
    expect(rows[0]).toMatchObject({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: 'GoldenFaucet',
      copyDurationDays: 50,
    })
    expect(rows[0].kind === 'copiers' && rows[0].copierPnl).toBeCloseTo(1272.967, 3)
    expect(rows[0].kind === 'copiers' && rows[0].copierInvested).toBeCloseTo(66634.391, 3)
    expect(new Set(rows.map((r) => r.dedupeHash)).size).toBe(18)
  })

  it('throws for unsupported history kinds', () => {
    expect(() => parseBybitCopytradeHistory({}, 'orders', ctx)).toThrow('not supported')
    expect(() => parseBybitCopytradeHistory({}, 'transfers', ctx)).toThrow('not supported')
  })
})
