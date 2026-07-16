/**
 * Expected-metrics parity (P0 of the data-completeness system, 2026-07-04).
 *
 * For every adapter, EXPECTED_METRICS (the code-declared "should-have"
 * contract, lib/ingest/adapters/expected-metrics.ts) must be a SUBSET of what
 * the adapter's pure parsers actually emit non-null over their own RAW
 * fixtures. This kills the gate-sharpe bug class in CI: a metric the exchange
 * provides but the parser silently drops can no longer hide — the count-derived
 * capability matview never catches it (count=0 → not listed → "fine").
 *
 * Recipes mirror each adapter's own parsers.test.ts fixture assembly
 * (harvested 2026-07-04). Emissions = union of non-null typed ParsedStats
 * fields across stats blocks ∪ mapped non-null board headline fields.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { ParseCtx, ParsedLeaderboardRow, ParsedProfile } from '../../core/types'
import { EXPECTED_METRICS } from '../expected-metrics'

import { parseBinanceLeaderboardPage, parseBinanceProfile } from '../binance/parsers'
import { parseBinanceWeb3LeaderboardPage } from '../binance-web3/parsers'
import { parseBingxLeaderboardPage } from '../bingx/parsers'
import { parseBitfinexLeaderboardPage } from '../bitfinex/parsers'
import { parseBitgetLeaderboardPage, parseBitgetProfile } from '../bitget/parsers'
import { parseBitgetBotsBoardPage, parseBitgetBotsProfile } from '../bitget/bots-parsers'
import { parseBitmartLeaderboardPage, parseBitmartProfile } from '../bitmart/parsers'
import { parseBitunixLeaderboardPage, parseBitunixProfile } from '../bitunix/parsers'
import { parseBlofinLeaderboardPage, parseBlofinProfile } from '../blofin/parsers'
import { parseBtccLeaderboardPage, parseBtccProfile } from '../btcc/parsers'
import {
  parseBybitCopytradeLeaderboardPage,
  parseBybitCopytradeProfile,
} from '../bybit-copytrade/parsers'
import { parseBybitMt5LeaderboardPage, parseBybitMt5Profile } from '../bybit-mt5/parsers'
import { parseCoinexLeaderboardPage, parseCoinexProfile } from '../coinex/parsers'
import { parseGateLeaderboardPage, parseGateProfile } from '../gate/parsers'
import { parseGmxLeaderboardPage, parseGmxProfile } from '../gmx/parsers'
import { parseGtradeLeaderboardPage, parseGtradeProfile } from '../gtrade/parsers'
import { parseHtxLeaderboardPage, parseHtxProfile } from '../htx/parsers'
import { parseHyperliquidLeaderboardPage, parseHyperliquidProfile } from '../hyperliquid/parsers'
import { parseKucoinLeaderboardPage, parseKucoinProfile } from '../kucoin/parsers'
import { parseLbankLeaderboardPage, parseLbankProfile } from '../lbank/parsers'
import { parseMexcLeaderboardPage, parseMexcProfile } from '../mexc/parsers'
import { parseOkxLeaderboardPage, parseOkxProfile } from '../okx/parsers'
import { parseOkxWeb3LeaderboardPage, parseOkxWeb3Profile } from '../okx-web3/parsers'
import { parsePhemexLeaderboardPage, parsePhemexProfile } from '../phemex/parsers'
import { parseToobitLeaderboardPage, parseToobitProfile } from '../toobit/parsers'
import { parseXtLeaderboardPage, parseXtProfile } from '../xt/parsers'

function fixture(adapter: string, name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '..', adapter, '__tests__', 'fixtures', name), 'utf8')
  )
}

const ctx = (sourceSlug: string, extra: Partial<ParseCtx> = {}): ParseCtx => ({
  sourceSlug,
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
  ...extra,
})

/** ParsedStats camelCase field → trader_stats snake_case metric. */
const STATS_FIELD_TO_METRIC: Record<string, string> = {
  roi: 'roi',
  pnl: 'pnl',
  sharpe: 'sharpe',
  mdd: 'mdd',
  winRate: 'win_rate',
  winPositions: 'win_positions',
  totalPositions: 'total_positions',
  copierPnl: 'copier_pnl',
  copierCount: 'copier_count',
  aum: 'aum',
  volume: 'volume',
  profitShareRate: 'profit_share_rate',
  holdingDurationAvgHours: 'holding_duration_avg',
}

/** ParsedLeaderboardRow headline field → metric (board-lift columns). */
const HEADLINE_TO_METRIC: Record<string, string> = {
  headlineRoi: 'roi',
  headlinePnl: 'pnl',
  headlineWinRate: 'win_rate',
  headlineMdd: 'mdd',
  headlineSharpe: 'sharpe',
  headlineAum: 'aum',
  headlineVolume: 'volume',
  headlineCopierCount: 'copier_count',
  headlineCopierPnl: 'copier_pnl',
  headlineHoldingDurationHours: 'holding_duration_avg',
}

function harvest(stats: ParsedProfile['stats'], rows: ParsedLeaderboardRow[]): Set<string> {
  const emitted = new Set<string>()
  for (const block of stats) {
    for (const [field, metric] of Object.entries(STATS_FIELD_TO_METRIC)) {
      const v = (block as unknown as Record<string, unknown>)[field]
      if (v !== null && v !== undefined) emitted.add(metric)
    }
  }
  for (const row of rows) {
    for (const [field, metric] of Object.entries(HEADLINE_TO_METRIC)) {
      const v = (row as unknown as Record<string, unknown>)[field]
      if (v !== null && v !== undefined) emitted.add(metric)
    }
  }
  return emitted
}

type Recipe = () => { stats: ParsedProfile['stats']; rows: ParsedLeaderboardRow[] }

const RECIPES: Record<string, Recipe> = {
  binance: () => {
    const futCtx = ctx('binance_futures', { meta: { boardKey: 'futures' } })
    const spotCtx = ctx('binance_spot', { meta: { boardKey: 'spot' } })
    const bundle = (p: string) => ({
      detail: fixture('binance', `${p}detail.json`),
      performance: fixture('binance', `${p}performance-7.json`),
      chartRoi: fixture('binance', `${p}chart-roi-7.json`),
      chartPnl: fixture('binance', `${p}chart-pnl-7.json`),
      coinPreference: fixture('binance', `${p}coin-preference-7.json`),
      timeframe: 7,
    })
    return {
      stats: [
        ...parseBinanceProfile(bundle(''), futCtx).stats,
        ...parseBinanceProfile(bundle('spot-'), spotCtx).stats,
      ],
      rows: [
        ...parseBinanceLeaderboardPage(fixture('binance', 'leaderboard-p1.json'), futCtx).rows,
        ...parseBinanceLeaderboardPage(fixture('binance', 'spot-leaderboard-p1.json'), spotCtx)
          .rows,
      ],
    }
  },

  binance_web3: () => ({
    stats: [],
    rows: parseBinanceWeb3LeaderboardPage(
      fixture('binance-web3', 'board-page.json'),
      ctx('binance_web3_bsc')
    ).rows,
  }),

  bingx: () => ({
    stats: [],
    rows: [7, 30, 90].flatMap(
      (tf) =>
        parseBingxLeaderboardPage(
          { search: fixture('bingx', 'search.json'), timeframe: tf },
          ctx('bingx_futures')
        ).rows
    ),
  }),

  bitfinex: () => ({
    stats: [],
    rows: parseBitfinexLeaderboardPage(
      fixture('bitfinex', 'board-page.json'),
      ctx('bitfinex', { currency: 'USD' })
    ).rows,
  }),

  bitget: () => {
    const bg = ctx('bitget_futures')
    // Board fixtures don't exist (tests use inline synthetic payloads) — a
    // minimal currentTrader/list payload mirrors parsers.test.ts.
    const inlineBoard = {
      data: {
        total: 2,
        list: [
          {
            traderId: '123',
            traderName: 'Alpha',
            roi: 15.5,
            profit: 1234.56,
            winRate: 62.5,
            drawDown: 8.2,
            followerNum: 100,
            copyTraderNum: 28,
          },
        ],
      },
    }
    const detailV2 = fixture('bitget', 'profile-detail-v2.json')
    const stats = ([7, 30, 90] as const).flatMap(
      (tf) =>
        parseBitgetProfile(
          { detailV2, cycleData: fixture('bitget', `profile-cycle-${tf}.json`), timeframe: tf },
          bg
        ).stats
    )
    stats.push(
      ...parseBitgetProfile(
        {
          utaDetails: fixture('bitget', 'uta-details.json'),
          utaPerformance: fixture('bitget', 'uta-performance-30.json'),
          utaChart: fixture('bitget', 'uta-cycle-chart-30.json'),
          timeframe: 30,
        },
        bg
      ).stats
    )
    return { stats, rows: parseBitgetLeaderboardPage(inlineBoard, bg).rows }
  },

  bitget_bots: () => {
    const bots = ctx('bitget_bots_futures')
    const rows = (
      [
        ['futures_grid', 'bots-board-futures-grid.json'],
        ['spot_martingale', 'bots-board-spot-martingale.json'],
      ] as const
    ).flatMap(
      ([board, file]) =>
        parseBitgetBotsBoardPage({ board, payload: fixture('bitget', file) }, bots).rows
    )
    return {
      stats: parseBitgetBotsProfile(
        { strategyInfo: fixture('bitget', 'bots-strategy-info.json'), timeframe: 30 },
        bots
      ).stats,
      rows,
    }
  },

  bitmart: () => {
    const bm = ctx('bitmart_futures', {
      tfLabelMap: { '24H': null, '7D': 7, '1M': 30, '3M': 90 },
      scrapedAt: '2026-06-12T03:30:00.000Z',
    })
    const bundle = (tf: number) => ({
      getByUuid: fixture('bitmart', 'get-by-uuid.json'),
      keyMetric: fixture('bitmart', 'key-metric.json'),
      aumInfo: fixture('bitmart', 'aum-info.json'),
      sheet: fixture('bitmart', 'sheet.json'),
      chart: fixture('bitmart', 'chart-1m.json'),
      assetPreferences: fixture('bitmart', 'asset-preferences-1m.json'),
      radar: fixture('bitmart', 'radar.json'),
      timeframe: tf,
    })
    return {
      stats: [
        ...parseBitmartProfile(bundle(30), bm).stats,
        ...parseBitmartProfile(bundle(90), bm).stats,
      ],
      rows: parseBitmartLeaderboardPage(fixture('bitmart', 'master-ranking-7d-p1.json'), bm).rows,
    }
  },

  bitunix: () => {
    const bu = ctx('bitunix_futures', { scrapedAt: '2026-06-12T03:00:00.000Z' })
    return {
      stats: parseBitunixProfile(
        {
          statistic: fixture('bitunix', 'statistic-30.json'),
          detail: fixture('bitunix', 'detail.json'),
          timeframe: 30,
        },
        bu
      ).stats,
      rows: [
        ...parseBitunixLeaderboardPage(fixture('bitunix', 'trader-list-30d-p1.json'), bu).rows,
        ...parseBitunixLeaderboardPage(fixture('bitunix', 'trader-list-7d-p1.json'), bu).rows,
      ],
    }
  },

  blofin: () => {
    const bf = ctx('blofin_futures')
    return {
      stats: parseBlofinProfile(
        {
          info: fixture('blofin', 'profile-info.json'),
          indicators: fixture('blofin', 'profile-indicators-d30.json'),
          symbolPerf: fixture('blofin', 'profile-symbol-perf-d30.json'),
          performance: fixture('blofin', 'profile-performance-d30.json'),
          timeframe: 30,
        },
        ctx('blofin_futures', { scrapedAt: '2026-07-02T00:00:00.000Z' })
      ).stats,
      rows: [
        ...parseBlofinLeaderboardPage(fixture('blofin', 'board-fut-30.json'), bf).rows,
        ...parseBlofinLeaderboardPage(fixture('blofin', 'board-fut-7.json'), bf).rows,
        ...parseBlofinLeaderboardPage(fixture('blofin', 'board-spot-30.json'), ctx('blofin_spot'))
          .rows,
      ],
    }
  },

  btcc: () => {
    const bc = ctx('btcc_futures', {
      tfLabelMap: { '7D': 7, '1M': 30, '3M': 90 },
      scrapedAt: '2026-06-11T12:00:00.000Z',
    })
    return {
      stats: parseBtccProfile(
        {
          info: fixture('btcc', 'info.json'),
          profitInfo: fixture('btcc', 'profit-info.json'),
          gain: fixture('btcc', 'gain-7.json'),
          profit: fixture('btcc', 'profit-7.json'),
          tradeAmount: fixture('btcc', 'trade-amount-7.json'),
          symbolRate: fixture('btcc', 'symbol-rate-7.json'),
          timeframe: 7,
        },
        bc
      ).stats,
      rows: parseBtccLeaderboardPage(fixture('btcc', 'trader-page-p1.json'), bc).rows,
    }
  },

  bybit_copytrade: () => {
    const by = ctx('bybit_copytrade')
    const bundle = (tf: number) => ({
      info: fixture('bybit-copytrade', 'pub-leader-info.json'),
      income: fixture('bybit-copytrade', 'leader-income.json'),
      yieldTrend: fixture('bybit-copytrade', `yield-trend-${tf === 0 ? 90 : tf}.json`),
      timeframe: tf,
    })
    return {
      stats: [7, 30, 90, 0].flatMap((tf) => parseBybitCopytradeProfile(bundle(tf), by).stats),
      rows: parseBybitCopytradeLeaderboardPage(
        fixture('bybit-copytrade', 'leaderboard-p1.json'),
        by
      ).rows,
    }
  },

  bybit_mt5: () => {
    const by = ctx('bybit_mt5', { currency: 'USDx' })
    const bundle = (tf: number) => ({
      info: fixture('bybit-mt5', 'provider-info.json'),
      incomeDetail: fixture('bybit-mt5', 'income-detail.json'),
      yieldTrend: fixture('bybit-mt5', `yield-trend-${tf === 0 ? 90 : tf}.json`),
      timeframe: tf,
    })
    return {
      stats: [7, 30, 90, 0].flatMap((tf) => parseBybitMt5Profile(bundle(tf), by).stats),
      rows: parseBybitMt5LeaderboardPage(fixture('bybit-mt5', 'leaderboard-p1.json'), by).rows,
    }
  },

  coinex: () => {
    const cx = ctx('coinex_futures')
    const bundle = (tf: number) => ({
      traderDetail: fixture('coinex', 'trader-detail.json'),
      tradeData: fixture('coinex', 'trade-data.json'),
      profitSeries: fixture('coinex', 'profit-series-30.json'),
      aumSeries: fixture('coinex', 'aum-series-30.json'),
      marketPercent: fixture('coinex', 'market-percent-30.json'),
      timeframe: tf,
    })
    return {
      stats: [30, 90].flatMap((tf) => parseCoinexProfile(bundle(tf), cx).stats),
      rows: parseCoinexLeaderboardPage(fixture('coinex', 'leaderboard-p1.json'), cx).rows,
    }
  },

  gate: () => {
    const g = ctx('gate_futures')
    const cfd = ctx('gate_cfd', { currency: 'USDx' })
    return {
      stats: [
        ...parseGateProfile(
          {
            detail: fixture('gate', 'detail-fut.json'),
            profitChart: fixture('gate', 'profit-chart-30.json'),
            positionComposition: fixture('gate', 'position-composition-30.json'),
            timeframe: 30,
          },
          g
        ).stats,
        ...parseGateProfile(
          {
            tradeInfo: fixture('gate', 'trade-info-cfd-30.json'),
            leadInfo: fixture('gate', 'lead-info-cfd.json'),
            yieldData: fixture('gate', 'yield-cfd-30.json'),
            timeframe: 30,
          },
          cfd
        ).stats,
      ],
      rows: [
        ...parseGateLeaderboardPage(fixture('gate', 'leaderboard-fut-p1.json'), g).rows,
        ...parseGateLeaderboardPage(fixture('gate', 'leaderboard-cfd-p1.json'), cfd).rows,
      ],
    }
  },

  gmx: () => {
    const g = ctx('gmx', { currency: 'USDC', scrapedAt: '2026-06-12T00:00:00.000Z' })
    const fx = fixture('gmx', 'period-account-stats.json') as Record<string, unknown>
    return {
      stats: parseGmxProfile(fixture('gmx', 'profile-bundle.json'), g).stats,
      rows: parseGmxLeaderboardPage(
        { timeframe: 7, from: fx.from, reportedTotal: 2866, rows: fx.rows },
        g
      ).rows,
    }
  },

  gtrade: () => {
    const g = ctx('gtrade', { currency: 'USDC', scrapedAt: '2026-06-12T00:00:00.000Z' })
    const byTf = fixture('gtrade', 'leaderboard-all.json') as Record<
      string,
      Array<Record<string, unknown>>
    >
    const bundle = fixture('gtrade', 'profile-bundle.json') as {
      stats: Record<string, unknown>
      trades: { data: Array<Record<string, unknown>> }
    }
    const asOfTimeMs = Date.parse(g.scrapedAt)
    const versionedRaw = (tf: number) => ({
      stats: bundle.stats,
      timeframe: tf,
      tradesFetchState: 'fetched',
      tradesFetchReason: 'exhausted',
      tradesSnapshot: {
        schemaVersion: 3,
        rawPages: [
          {
            pageIndex: 1,
            requestCursor: null,
            requestStartTimeMs: asOfTimeMs - 90 * 86_400_000,
            requestEndTimeMs: asOfTimeMs,
            url: 'https://gtrade.test/history',
            response: {
              data: bundle.trades.data,
              pagination: { hasMore: false, nextCursor: null, limit: 1_000 },
            },
          },
        ],
        meta: { asOfTimeMs, horizonStartTimeMs: asOfTimeMs - 90 * 86_400_000 },
      },
    })
    return {
      stats: [7, 30].flatMap((tf) => parseGtradeProfile(versionedRaw(tf), g).stats),
      rows: parseGtradeLeaderboardPage({ timeframe: 7, rows: byTf['7'], reportedTotal: 25 }, g)
        .rows,
    }
  },

  htx: () => {
    const h = ctx('htx_futures', { meta: { boardKey: 'futures' } })
    return {
      stats: parseHtxProfile(
        {
          baseInfo: fixture('htx', 'base-info.json'),
          performance: fixture('htx', 'performance.json'),
          profitRateChart: fixture('htx', 'profit-rate-chart-90.json'),
          profitChart: fixture('htx', 'profit-chart-90.json'),
          timeframe: 90,
        },
        h
      ).stats,
      rows: [
        ...parseHtxLeaderboardPage(fixture('htx', 'rank-futures-p1.json'), h).rows,
        ...parseHtxLeaderboardPage(fixture('htx', 'rank-spot-p1.json'), h).rows,
      ],
    }
  },

  hyperliquid: () => {
    const h = ctx('hyperliquid', {
      currency: 'USDC',
      scrapedAt: new Date(1781214420993).toISOString(),
    })
    const payload = fixture('hyperliquid', 'leaderboard-page.json') as Record<string, unknown>
    const bundle = fixture('hyperliquid', 'profile-bundle.json') as Record<string, unknown>
    const fillsEnd = Date.parse(h.scrapedAt)
    const fillsStart = fillsEnd - 90 * 86_400_000
    const completeEmptyFills = {
      fillsFetchState: 'fetched',
      fillsSnapshot: {
        schemaVersion: 2,
        rawPages: [{ requestStartTimeMs: fillsStart, requestEndTimeMs: fillsEnd, response: [] }],
        fills: [],
        meta: {
          requestedStartTimeMs: fillsStart,
          requestedEndTimeMs: fillsEnd,
          coveredStartTimeMs: null,
          coveredEndTimeMs: null,
          requestCount: 1,
          pageCount: 1,
          fillCount: 0,
          exhausted: true,
          limitHit: false,
          stalled: false,
          completeThroughEnd: true,
          failureReason: null,
          complete: true,
        },
      },
    }
    return {
      stats: [
        ...parseHyperliquidProfile({ ...bundle, timeframe: 30 }, h).stats,
        ...parseHyperliquidProfile({ ...bundle, timeframe: 90 }, h).stats,
        // Versioned, exhausted empty window → explicit-0 positions.
        ...parseHyperliquidProfile({ ...bundle, ...completeEmptyFills, timeframe: 30 }, h).stats,
      ],
      rows: [
        ...parseHyperliquidLeaderboardPage(payload, h).rows,
        ...parseHyperliquidLeaderboardPage({ ...payload, timeframe: 30 }, h).rows,
      ],
    }
  },

  kucoin: () => {
    const k = ctx('kucoin_futures')
    return {
      stats: parseKucoinProfile(
        {
          summary: fixture('kucoin', 'summary.json'),
          overview: fixture('kucoin', 'overview.json'),
          pnlHistory: fixture('kucoin', 'pnl-history-30.json'),
          currencyPreference: fixture('kucoin', 'currency-preference.json'),
          timeframe: 30,
        },
        k
      ).stats,
      rows: parseKucoinLeaderboardPage(fixture('kucoin', 'leaderboard-p1.json'), k).rows,
    }
  },

  lbank: () => {
    const l = ctx('lbank_futures', { tfLabelMap: { '7D': 7, '30D': 30 } })
    return {
      stats: parseLbankProfile(
        {
          headInfo: fixture('lbank', 'head-info.json'),
          stat: fixture('lbank', 'stat-1m.json'),
          profitRateChart: fixture('lbank', 'profit-rate-30.json'),
          profitChart: fixture('lbank', 'profit-30.json'),
          volumeChart: fixture('lbank', 'trade-volume-30.json'),
          tradePreference: fixture('lbank', 'trade-preference-30.json'),
          timeframe: 30,
        },
        l
      ).stats,
      rows: [
        ...parseLbankLeaderboardPage(fixture('lbank', 'getall-30d-p1.json'), l).rows,
        ...parseLbankLeaderboardPage(fixture('lbank', 'getall-7d-p1.json'), l).rows,
      ],
    }
  },

  mexc: () => {
    const m = ctx('mexc_futures')
    const aiUids = (
      fixture('mexc', 'ai-list.json') as { data: { traders: Array<{ uid: string }> } }
    ).data.traders.map((t) => t.uid)
    return {
      stats: parseMexcProfile(
        {
          trader: fixture('mexc', 'trader-30.json'),
          accumulate: fixture('mexc', 'accumulate-30.json'),
          dayPnl: fixture('mexc', 'day-pnl-30.json'),
          ability: fixture('mexc', 'ability-30.json'),
          hold: fixture('mexc', 'hold-30.json'),
          contractStat: fixture('mexc', 'contract-stat-30.json'),
          timeframe: 30,
        },
        m
      ).stats,
      rows: [
        ...parseMexcLeaderboardPage({ list: fixture('mexc', 'leaderboard-p1.json'), aiUids: [] }, m)
          .rows,
        ...parseMexcLeaderboardPage({ aiDetail: fixture('mexc', 'ai-detail.json'), aiUids }, m)
          .rows,
      ],
    }
  },

  okx: () => {
    const o = ctx('okx_futures', { scrapedAt: '2026-06-12T00:00:00.000Z' })
    return {
      stats: parseOkxProfile(fixture('okx', 'profile-bundle.json'), o).stats,
      rows: parseOkxLeaderboardPage(fixture('okx', 'board-page.json'), o).rows,
    }
  },

  okx_web3: () => {
    const o = ctx('okx_web3_solana', {
      currency: 'USDC',
      tfLabelMap: { '1D': 1, '7D': 7, '1M': 30, '3M': 90 },
      scrapedAt: '2026-06-12T00:00:00.000Z',
    })
    const boardFx = fixture('okx-web3', 'board-page.json') as { response: { data: unknown } }
    const profFx = fixture('okx-web3', 'profile-summary.json') as { response: unknown }
    return {
      stats: parseOkxWeb3Profile({ summary: profFx.response, timeframe: 7 }, o).stats,
      rows: parseOkxWeb3LeaderboardPage({ data: boardFx.response.data, timeframe: 7 }, o).rows,
    }
  },

  phemex: () => {
    const p = ctx('phemex_futures')
    const bundle = (tf: number) => ({
      user: fixture('phemex', 'user-detail.json'),
      pnlRateChart: fixture('phemex', 'pnl-rate-chart-30.json'),
      pnlChart: fixture('phemex', 'pnl-rate-chart-30.json'),
      symbolMetric: fixture('phemex', 'symbol-metric.json'),
      timeframe: tf,
    })
    return {
      stats: [
        ...parsePhemexProfile(bundle(30), p).stats,
        ...parsePhemexProfile(bundle(90), p).stats,
      ],
      rows: [
        ...parsePhemexLeaderboardPage(
          { board: fixture('phemex', 'recommend-p1.json'), timeframe: 30 },
          p
        ).rows,
        ...parsePhemexLeaderboardPage(
          { board: fixture('phemex', 'recommend-p1.json'), timeframe: 90 },
          p
        ).rows,
        ...parsePhemexLeaderboardPage(
          { aiList: fixture('phemex', 'ai-trader-list.json'), timeframe: 30 },
          p
        ).rows,
      ],
    }
  },

  toobit: () => {
    const t = ctx('toobit_futures')
    return {
      stats: parseToobitProfile(fixture('toobit', 'profile-bundle.json'), t).stats,
      rows: parseToobitLeaderboardPage(fixture('toobit', 'board-page.json'), t).rows,
    }
  },

  xt: () => {
    const x = ctx('xt_futures')
    const spotCtx = ctx('xt_spot', { meta: { boardKey: 'spot' } })
    return {
      stats: parseXtProfile(
        {
          detail: fixture('xt', 'detail-fut.json'),
          stats: fixture('xt', 'leader-stats-30.json'),
          symbolPrefer: fixture('xt', 'leader-symbol-prefer-30.json'),
          timeframe: 30,
        },
        x
      ).stats,
      rows: [
        ...parseXtLeaderboardPage(fixture('xt', 'leaderboard-fut-30.json'), x).rows,
        ...parseXtLeaderboardPage(fixture('xt', 'leaderboard-spot-30.json'), spotCtx).rows,
      ],
    }
  },
}

describe('expected-metrics parity (declared ⊆ emitted over fixtures)', () => {
  it('every declared adapter has a recipe, and vice versa', () => {
    expect(Object.keys(RECIPES).sort()).toEqual(Object.keys(EXPECTED_METRICS).sort())
  })

  for (const [slug, declared] of Object.entries(EXPECTED_METRICS)) {
    it(`${slug}: declares ${declared.length} metrics, parsers must emit them all`, () => {
      const { stats, rows } = RECIPES[slug]()
      const emitted = harvest(stats, rows)
      const missing = declared.filter((m) => !emitted.has(m))
      // Failure = parser silently drops a metric the exchange provides
      // (gate-sharpe class) OR the declaration overreaches the fixtures —
      // either way, fix the parser / refresh the fixture / correct the
      // declaration with an UNREACHABLE_FIELDS_LEDGER verdict. Never delete
      // the assertion.
      expect(missing).toEqual([])
      // Surplus (emitted but undeclared) is logged as declaration candidates.
      const surplus = [...emitted].filter((m) => !(declared as readonly string[]).includes(m))
      if (surplus.length > 0) {
        console.log(`[parity] ${slug} emits undeclared candidates: ${surplus.sort().join(', ')}`)
      }
    })
  }
})
