/**
 * Verify Registry — Lightweight health probes for all exchange APIs
 *
 * Each verifier makes a single minimal API call (page=1, size=1) to check
 * reachability and response format without heavy load.
 *
 * Used by /api/cron/verify-fetchers to monitor API health.
 */

import { fetchJson, type FailureReason, classifyFetchError } from './shared'
import { logger } from '@/lib/logger'

// ── Types ──

export interface VerifyResult {
  platform: string
  healthy: boolean
  latencyMs: number
  failureReason?: FailureReason
  details?: string
  checkedAt: string
}

type VerifyFn = () => Promise<VerifyResult>

/** Loose shape for external API responses checked by validators */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = Record<string, any>

// ── Helpers ──

async function verifyEndpoint(
  platform: string,
  url: string,
  opts?: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    validateResponse?: (data: ApiResponse) => boolean
    timeoutMs?: number
  }
): Promise<VerifyResult> {
  const start = Date.now()
  const checkedAt = new Date().toISOString()

  try {
    const data = await fetchJson<ApiResponse>(url, {
      method: opts?.method,
      headers: opts?.headers,
      body: opts?.body,
      timeoutMs: opts?.timeoutMs || 10000,
    })

    const latencyMs = Date.now() - start

    if (opts?.validateResponse && !opts.validateResponse(data)) {
      return {
        platform,
        healthy: false,
        latencyMs,
        failureReason: 'empty_data',
        details: 'Response valid but no usable data',
        checkedAt,
      }
    }

    return { platform, healthy: true, latencyMs, checkedAt }
  } catch (err) {
    const latencyMs = Date.now() - start
    const failureReason = classifyFetchError(err)
    return {
      platform,
      healthy: false,
      latencyMs,
      failureReason,
      details: err instanceof Error ? err.message.slice(0, 300) : String(err),
      checkedAt,
    }
  }
}

// ── Platform Verifiers ──

const VERIFY_REGISTRY: Record<string, VerifyFn> = {
  // -- CEX Futures --

  binance_futures: () =>
    verifyEndpoint(
      'binance_futures',
      'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.binance.com',
          Referer: 'https://www.binance.com/en/copy-trading',
        },
        body: {
          pageNumber: 1,
          pageSize: 1,
          timeRange: '90D',
          dataType: 'ROI',
          favoriteOnly: false,
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data?.list) && d.data.list.length > 0,
      }
    ),

  binance_spot: () =>
    verifyEndpoint(
      'binance_spot',
      'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.binance.com',
          Referer: 'https://www.binance.com/en/copy-trading/spot',
        },
        body: {
          pageNumber: 1,
          pageSize: 1,
          timeRange: '90D',
          dataType: 'ROI',
          order: 'DESC',
          portfolioType: 'ALL',
          favoriteOnly: false,
          hideFull: false,
        },
        validateResponse: (d: ApiResponse) => {
          const list = d?.data?.list || d?.data?.data
          return Array.isArray(list) && list.length > 0
        },
      }
    ),

  binance_web3: () =>
    verifyEndpoint(
      'binance_web3',
      'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.binance.com',
          Referer: 'https://www.binance.com/en/leaderboard',
        },
        body: {
          isShared: true,
          isTrader: false,
          periodType: 'QUARTERLY',
          statisticsType: 'ROI',
          tradeType: 'PERPETUAL',
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data) && d.data.length > 0,
      }
    ),

  bybit: () =>
    verifyEndpoint(
      'bybit',
      'https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=1&dataDuration=DATA_DURATION_THIRTY_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI',
      {
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.result?.leaderDetails) && d.result.leaderDetails.length > 0,
      }
    ),

  bybit_spot: () =>
    verifyEndpoint(
      'bybit_spot',
      'https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=1&dataDuration=DATA_DURATION_THIRTY_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI',
      {
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.result?.leaderDetails) && d.result.leaderDetails.length > 0,
      }
    ),

  okx_futures: () =>
    verifyEndpoint(
      'okx_futures',
      'https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&page=1',
      {
        headers: { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        validateResponse: (d: ApiResponse) =>
          d?.code === '0' && Array.isArray(d?.data) && d.data.length > 0,
      }
    ),

  okx_web3: () =>
    verifyEndpoint(
      'okx_web3',
      'https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=MARGIN&page=1',
      {
        headers: { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        validateResponse: (d: ApiResponse) =>
          d?.code === '0' && Array.isArray(d?.data) && d.data.length > 0,
      }
    ),

  htx: () =>
    verifyEndpoint(
      'htx',
      'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?pageNo=1&pageSize=1&sortField=roi&sortType=desc',
      {
        validateResponse: (d: ApiResponse) => !!d?.data,
      }
    ),

  bitget_futures: () =>
    verifyEndpoint(
      'bitget_futures',
      'https://api.bitget.com/api/v2/copy/mix-trader/trader-profit-ranking?period=THIRTY_DAYS&pageNo=1&pageSize=1',
      {
        headers: {
          Referer: 'https://www.bitget.com/',
          Origin: 'https://www.bitget.com',
        },
        validateResponse: (d: ApiResponse) =>
          d?.code === '00000' || d?.code === 0 || d?.code === '0' || !!d?.data,
      }
    ),

  bitget_spot: () =>
    verifyEndpoint(
      'bitget_spot',
      'https://api.bitget.com/api/v2/copy/spot-trader/trader-profit-ranking?period=THIRTY_DAYS&pageNo=1&pageSize=1',
      {
        headers: {
          Referer: 'https://www.bitget.com/',
          Origin: 'https://www.bitget.com',
        },
        validateResponse: (d: ApiResponse) =>
          d?.code === '00000' || d?.code === 0 || d?.code === '0' || !!d?.data,
      }
    ),

  xt: () =>
    verifyEndpoint(
      'xt',
      'https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?size=1&days=30&sotType=1&pageNo=1',
      {
        validateResponse: (d: ApiResponse) => !!d?.result || !!d?.data,
      }
    ),

  bingx: () =>
    verifyEndpoint(
      'bingx',
      'https://bingx.com/api/strategy/api/v1/copy/trader/topRanking?type=ALL&pageIndex=1&pageSize=1',
      {
        headers: {
          Referer: 'https://bingx.com/en/CopyTrading/leaderBoard',
          Origin: 'https://bingx.com',
        },
        validateResponse: (d: ApiResponse) => !!d?.data,
      }
    ),

  gateio: () =>
    verifyEndpoint(
      'gateio',
      'https://api.gateio.ws/api/v4/copy_trading/leader_board?sort_by=roi&period=30D&page=1&limit=1',
      {
        validateResponse: (d: ApiResponse) => Array.isArray(d) || !!d?.data,
      }
    ),

  mexc: () =>
    verifyEndpoint(
      'mexc',
      'https://www.mexc.com/api/platform/copy/v1/recommend/traders?pageNum=1&pageSize=1&sortType=ROI&days=90',
      {
        headers: {
          Referer: 'https://www.mexc.com/futures/copyTrade/home',
          Origin: 'https://www.mexc.com',
        },
        validateResponse: (d: ApiResponse) => !!d?.data,
      }
    ),

  kucoin: () =>
    verifyEndpoint(
      'kucoin',
      'https://www.kucoin.com/_api/copy-trading/leaderboard/query?pageNo=1&pageSize=1',
      {
        headers: {
          Referer: 'https://www.kucoin.com/copytrading',
          Origin: 'https://www.kucoin.com',
        },
        validateResponse: (d: ApiResponse) => !!d?.data,
      }
    ),

  coinex: () =>
    verifyEndpoint(
      'coinex',
      'https://www.coinex.com/res/copy-trading/traders?page=1&limit=1',
      {
        validateResponse: (d: ApiResponse) => !!d?.data,
      }
    ),

  phemex: () =>
    verifyEndpoint(
      'phemex',
      'https://phemex.com/api/phemex-user/users/children/queryTraderWithCopySetting?pageNo=1&pageSize=1&days=90',
      {
        headers: {
          Referer: 'https://phemex.com/copy-trading',
          Origin: 'https://phemex.com',
        },
        validateResponse: (d: ApiResponse) => !!d?.data,
      }
    ),

  weex: () =>
    verifyEndpoint(
      'weex',
      'https://http-gateway1.janapw.com/api/v1/public/trace/traderListView',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://www.weex.com/zh-CN/copy-trading',
          Origin: 'https://www.weex.com',
        },
        body: { pageNo: 1, pageSize: 1 },
        validateResponse: (d: ApiResponse) => !!d?.data,
      }
    ),

  lbank: () =>
    verifyEndpoint(
      'lbank',
      'https://www.lbank.com/api/copy-trading/trader/ranking?period=30d&page=1&size=1&sort=roi',
      {
        headers: {
          Referer: 'https://www.lbank.com/copy-trading',
          Origin: 'https://www.lbank.com',
        },
        validateResponse: (d: ApiResponse) => !!d?.data,
      }
    ),

  blofin: () =>
    verifyEndpoint(
      'blofin',
      'https://openapi.blofin.com/api/v1/copytrading/current-traders?pageNo=1&pageSize=1&range=2',
      {
        headers: {
          Referer: 'https://blofin.com/en/copy-trade',
          Origin: 'https://blofin.com',
        },
        validateResponse: (d: ApiResponse) => !!d?.data,
      }
    ),

  cryptocom: () =>
    verifyEndpoint(
      'cryptocom',
      'https://crypto.com/fe-ex-api/copy/leader/list?sort=roi&period=30d&page=1&pageSize=1',
      {
        headers: {
          Referer: 'https://crypto.com/exchange/copy-trading',
          Origin: 'https://crypto.com',
        },
        validateResponse: (d: ApiResponse) => !!d?.data || !!d?.result,
      }
    ),

  toobit: () =>
    verifyEndpoint(
      'toobit',
      'https://www.toobit.com/api/v1/copy/leader/rank?sortBy=roi&period=30&page=1&pageSize=1',
      {
        headers: {
          Referer: 'https://www.toobit.com/en-US/copy-trading',
          Origin: 'https://www.toobit.com',
        },
        validateResponse: (d: ApiResponse) => !!d?.data || !!d?.result,
      }
    ),

  btse: () =>
    verifyEndpoint(
      'btse',
      'https://api.btse.com/spot/api/v3.2/market_summary',
      {
        validateResponse: (d: ApiResponse) => Array.isArray(d) && d.length > 0,
      }
    ),

  pionex: () =>
    verifyEndpoint(
      'pionex',
      'https://www.pionex.com/kol-apis/tapi/v1/kol/list?page=1&pageSize=1',
      {
        headers: {
          Referer: 'https://www.pionex.com/en/copy-trade',
          Origin: 'https://www.pionex.com',
        },
        validateResponse: (d: ApiResponse) => !!d?.data,
      }
    ),

  // -- DEX --

  hyperliquid: () =>
    verifyEndpoint(
      'hyperliquid',
      'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard',
      {
        timeoutMs: 15000,
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.leaderboardRows) && d.leaderboardRows.length > 0,
      }
    ),

  gmx: () =>
    verifyEndpoint(
      'gmx',
      'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: '{ accountStats(limit: 1, orderBy: realizedPnl_DESC) { id } }',
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data?.accountStats) && d.data.accountStats.length > 0,
      }
    ),

  dydx: () =>
    verifyEndpoint(
      'dydx',
      'https://indexer.dydx.trade/v4/leaderboard/pnl?period=PERIOD_7D&limit=1',
      {
        validateResponse: (d: ApiResponse) => !!d,
      }
    ),

  gains: () =>
    verifyEndpoint(
      'gains',
      'https://backend-arbitrum.gains.trade/leaderboard',
      {
        timeoutMs: 15000,
        validateResponse: (d: ApiResponse) => Array.isArray(d) && d.length > 0,
      }
    ),

  aevo: () =>
    verifyEndpoint(
      'aevo',
      'https://api.aevo.xyz/leaderboard?asset=ETH&period=weekly&limit=1',
      {
        validateResponse: (d: ApiResponse) => !!d,
      }
    ),

  drift: () =>
    verifyEndpoint(
      'drift',
      'https://mainnet-beta.api.drift.trade/leaderboard?resolution=allTime',
      {
        validateResponse: (d: ApiResponse) => Array.isArray(d) || !!d?.data,
      }
    ),

  jupiter_perps: () =>
    verifyEndpoint(
      'jupiter_perps',
      'https://perps-api.jup.ag/v1/top-traders?year=2025&week=current',
      {
        timeoutMs: 15000,
        validateResponse: (d: ApiResponse) =>
          !!d?.topTradersByPnl || !!d?.topTradersByVolume,
      }
    ),

  uniswap: () =>
    verifyEndpoint(
      'uniswap',
      'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: '{ swaps(first: 1, orderBy: amountUSD, orderDirection: desc) { origin amountUSD } }',
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data?.swaps) && d.data.swaps.length > 0,
      }
    ),

  pancakeswap: () =>
    verifyEndpoint(
      'pancakeswap',
      'https://api.thegraph.com/subgraphs/name/pancakeswap/exchange-v3-bsc',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: '{ swaps(first: 1, orderBy: amountUSD, orderDirection: desc) { origin amountUSD } }',
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data?.swaps) && d.data.swaps.length > 0,
      }
    ),

  // TheGraph-dependent platforms (require THEGRAPH_API_KEY)
  kwenta: () => {
    const apiKey = process.env.THEGRAPH_API_KEY || ''
    if (!apiKey) {
      return Promise.resolve({
        platform: 'kwenta',
        healthy: false,
        latencyMs: 0,
        failureReason: 'auth_required' as FailureReason,
        details: 'THEGRAPH_API_KEY not set',
        checkedAt: new Date().toISOString(),
      })
    }
    return verifyEndpoint(
      'kwenta',
      `https://gateway-arbitrum.network.thegraph.com/api/${apiKey}/subgraphs/id/5sbJJTTJQQ4kYuVYNBVw9sX8C5juRpVJNLHg7uFugw2e`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: '{ accounts(first: 1, orderBy: totalVolume, orderDirection: desc) { id } }',
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data?.accounts) && d.data.accounts.length > 0,
      }
    )
  },

  synthetix: () => {
    const apiKey = process.env.THEGRAPH_API_KEY || ''
    if (!apiKey) {
      return Promise.resolve({
        platform: 'synthetix',
        healthy: false,
        latencyMs: 0,
        failureReason: 'auth_required' as FailureReason,
        details: 'THEGRAPH_API_KEY not set',
        checkedAt: new Date().toISOString(),
      })
    }
    return verifyEndpoint(
      'synthetix',
      `https://gateway-arbitrum.network.thegraph.com/api/${apiKey}/subgraphs/id/Cjhmx65d3EJPxYXcidLeBXFGiVrBfYEPaywVMPf3DP9M`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: '{ accounts(first: 1) { id } }',
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data?.accounts) && d.data.accounts.length > 0,
      }
    )
  },

  mux: () => {
    const apiKey = process.env.THEGRAPH_API_KEY || ''
    if (!apiKey) {
      return Promise.resolve({
        platform: 'mux',
        healthy: false,
        latencyMs: 0,
        failureReason: 'auth_required' as FailureReason,
        details: 'THEGRAPH_API_KEY not set',
        checkedAt: new Date().toISOString(),
      })
    }
    return verifyEndpoint(
      'mux',
      `https://gateway-arbitrum.network.thegraph.com/api/${apiKey}/subgraphs/id/7hUM4US9DPz6JqLD6ySqwFmLq4XiAF7cEZLmEesQnYgR`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: '{ accounts(first: 1) { id } }',
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data?.accounts) && d.data.accounts.length > 0,
      }
    )
  },
}

 

// ── Public API ──

export function getVerifier(platform: string): VerifyFn | undefined {
  return VERIFY_REGISTRY[platform]
}

export function getAllVerifiablePlatforms(): string[] {
  return Object.keys(VERIFY_REGISTRY)
}

/**
 * Run all verifiers in batches (concurrency=5) to avoid overwhelming networks.
 */
export async function verifyAll(): Promise<VerifyResult[]> {
  const platforms = getAllVerifiablePlatforms()
  const results: VerifyResult[] = []
  const BATCH_SIZE = 5

  for (let i = 0; i < platforms.length; i += BATCH_SIZE) {
    const batch = platforms.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async (p) => {
        try {
          return await VERIFY_REGISTRY[p]()
        } catch (err) {
          return {
            platform: p,
            healthy: false,
            latencyMs: 0,
            failureReason: 'unknown' as FailureReason,
            details: err instanceof Error ? err.message : String(err),
            checkedAt: new Date().toISOString(),
          }
        }
      })
    )
    results.push(...batchResults)
  }

  logger.info(`[verify-registry] Verified ${results.length} platforms: ${results.filter((r: VerifyResult) => r.healthy).length} healthy`)
  return results
}
