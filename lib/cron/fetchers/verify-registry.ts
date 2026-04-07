/**
 * Verify Registry — Lightweight health probes for all exchange APIs
 *
 * Each verifier makes a single minimal API call (page=1, size=1) to check
 * reachability and response format without heavy load.
 *
 * Used by /api/cron/verify-fetchers to monitor API health.
 *
 * Notes on verify vs fetch discrepancies:
 * - Some platforms are geo-blocked from US IPs but work from Vercel hnd1 (Tokyo).
 *   Verify runs from sfo1 so these will report geo_blocked — this is expected.
 * - Some platforms use authenticated broker APIs (Bitget) or require API keys
 *   (Drift, BloFin, TheGraph). These report auth_required.
 * - Some platforms have Cloudflare WAF that blocks non-browser requests.
 *   The actual fetchers use browser-like headers or proxy fallback.
 */

import { fetchJson, fetchWithFallback, type FailureReason, classifyFetchError } from './shared'
import { logger } from '@/lib/logger'

// ── Types ──

/** Loose JSON response type for API validation callbacks (replaces `any`) */
 
type ApiResponse = Record<string, any>

export interface VerifyResult {
  platform: string
  healthy: boolean
  latencyMs: number
  failureReason?: FailureReason
  details?: string
  checkedAt: string
}

type VerifyFn = () => Promise<VerifyResult>

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

/** Like verifyEndpoint but uses fetchWithFallback (direct → VPS proxy) for WAF-blocked platforms */
async function verifyEndpointWithProxy(
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
    const { data, via } = await fetchWithFallback<ApiResponse>(url, {
      method: opts?.method,
      headers: opts?.headers,
      body: opts?.body,
      timeoutMs: opts?.timeoutMs || 10000,
      platform,
    })

    const latencyMs = Date.now() - start

    if (opts?.validateResponse && !opts.validateResponse(data)) {
      return {
        platform,
        healthy: false,
        latencyMs,
        failureReason: 'empty_data',
        details: `Response valid but no usable data (via ${via})`,
        checkedAt,
      }
    }

    return { platform, healthy: true, latencyMs, details: `via ${via}`, checkedAt }
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

/** Helper: return a known-skip result for platforms requiring env vars */
function skipResult(
  platform: string,
  reason: FailureReason,
  details: string
): Promise<VerifyResult> {
  return Promise.resolve({
    platform,
    healthy: false,
    latencyMs: 0,
    failureReason: reason,
    details,
    checkedAt: new Date().toISOString(),
  })
}

// ── Platform Verifiers ──

const VERIFY_REGISTRY: Record<string, VerifyFn> = {
  // =============================================
  // CEX — Geo-blocked from US but work from Vercel hnd1
  // These will report geo_blocked when verify runs from sfo1.
  // The actual fetchers work because batch-fetch-traders runs from hnd1.
  // =============================================

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

  // binance_spot: REMOVED 2026-03-14 - repeatedly hangs 45-76min, blocks entire pipeline

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

  // =============================================
  // CEX — Working from any region
  // =============================================

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

  // OKX Web3: try SWAP first (more data), fall back to MARGIN
  okx_web3: async () => {
    const base = 'https://www.okx.com/api/v5/copytrading/public-lead-traders'
    const opts = {
      headers: { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      validateResponse: (d: ApiResponse) =>
        d?.code === '0' && Array.isArray(d?.data) && d.data.length > 0,
    }
    const result = await verifyEndpoint('okx_web3', `${base}?instType=SWAP&page=1`, opts)
    if (result.healthy) return result
    return verifyEndpoint('okx_web3', `${base}?instType=MARGIN&page=1`, opts)
  },

  htx: () =>
    verifyEndpoint(
      'htx',
      'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?pageNo=1&pageSize=1&sortField=roi&sortType=desc',
      {
        validateResponse: (d: ApiResponse) => !!d?.data,
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

  btse: () =>
    verifyEndpoint(
      'btse',
      'https://api.btse.com/spot/api/v3.2/market_summary',
      {
        validateResponse: (d: ApiResponse) => Array.isArray(d) && d.length > 0,
      }
    ),

  // =============================================
  // CEX — Auth required (need API keys or broker credentials)
  // =============================================

  // Bitget public copy-trading endpoints return 404 since late 2025.
  // Only the authenticated broker API works: /api/v2/copy/mix-broker/query-traders
  // Requires BITGET_API_KEY, BITGET_SECRET, BITGET_PASSPHRASE env vars.
  bitget_futures: () => {
    if (!process.env.BITGET_API_KEY) {
      return skipResult('bitget_futures', 'auth_required', 'BITGET_API_KEY not set — public endpoints return 404, broker API required')
    }
    return verifyEndpoint(
      'bitget_futures',
      'https://api.bitget.com/api/v2/copy/mix-broker/query-traders?pageNo=1&pageSize=1&period=THIRTY_DAYS',
      {
        headers: {
          Referer: 'https://www.bitget.com/',
          Origin: 'https://www.bitget.com',
        },
        validateResponse: (d: ApiResponse) =>
          d?.code === '00000' || d?.code === 0 || d?.code === '0' || !!d?.data,
      }
    )
  },

  bitget_spot: () => {
    if (!process.env.BITGET_API_KEY) {
      return skipResult('bitget_spot', 'auth_required', 'BITGET_API_KEY not set — public endpoints return 404, broker API required')
    }
    return verifyEndpoint(
      'bitget_spot',
      'https://api.bitget.com/api/v2/copy/spot-broker/query-traders?pageNo=1&pageSize=1&period=THIRTY_DAYS',
      {
        headers: {
          Referer: 'https://www.bitget.com/',
          Origin: 'https://www.bitget.com',
        },
        validateResponse: (d: ApiResponse) =>
          d?.code === '00000' || d?.code === 0 || d?.code === '0' || !!d?.data,
      }
    )
  },

  // BloFin openapi returns 401 Unauthorized without API credentials
  blofin: () =>
    skipResult('blofin', 'auth_required', 'openapi.blofin.com requires authentication (401)'),

  // Drift public Data API (no auth required)
  drift: () =>
    verifyEndpoint(
      'drift',
      'https://data.api.drift.trade/stats/leaderboard?limit=1&sort=pnl',
      {
        validateResponse: (d: ApiResponse) => !!d?.success && !!d?.data?.leaderboard,
      }
    ),

  // =============================================
  // CEX — Cloudflare WAF / endpoint changes
  // Fetchers use multi-URL fallback strategies with browser headers and proxies.
  // Verify probes the primary endpoint — CF challenge is expected from serverless.
  // =============================================

  // Gate.io v4 API now requires API KEY header for copy_trading endpoints.
  // Fetcher uses www.gate.com/apiw/v2/copy/leader/list (internal web API, no key needed).
  gateio: () =>
    verifyEndpoint(
      'gateio',
      'https://www.gate.com/apiw/v2/copy/leader/list?page=1&page_size=1&order_by=profit_rate&sort_by=desc&cycle=month&status=running',
      {
        headers: {
          Referer: 'https://www.gate.io/copy_trading',
          Origin: 'https://www.gate.io',
        },
        validateResponse: (d: ApiResponse) => d?.code === 0 && !!d?.data,
      }
    ),

  // CoinEx perpetual copy trading API
  coinex: () =>
    verifyEndpoint(
      'coinex',
      'https://api.coinex.com/perpetual/v1/market/copy_trading/trader?page=1&limit=1&sort_by=roi',
      {
        headers: {
          Referer: 'https://www.coinex.com/en/copy-trading/futures',
          Origin: 'https://www.coinex.com',
        },
        validateResponse: (d: ApiResponse) => d?.code === 0 || !!d?.data,
      }
    ),

  // MEXC: primary fetcher URL uses www.mexc.com/api/platform/copy/v1/
  // with fallback to contract.mexc.com. Both are geo-sensitive.
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

  // BingX behind Cloudflare challenge — fetcher uses proxy fallback
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

  // Pionex behind Cloudflare challenge — uses VPS proxy fallback
  pionex: () =>
    verifyEndpointWithProxy(
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

  // Crypto.com: no public API — requires stealth browser (CF challenge + session cookies)
  cryptocom: () =>
    skipResult('cryptocom', 'endpoint_gone', 'No public API — requires stealth browser (CF challenge + session cookies)'),

  // Toobit: re-enabled via VPS Playwright scraper (2026-03-09)
  // toobit: now handled by inline fetcher with VPS scraper strategy

  // LBank: no public API — all endpoints return HTML (CF challenge)
  lbank: () =>
    skipResult('lbank', 'endpoint_gone', 'No public API — all endpoints return HTML (CF challenge)'),

  // =============================================
  // CEX — Discontinued
  // =============================================

  // WEEX — DISABLED 2026-03-14: API returning HTTP 521 (server down)
  weex: () =>
    Promise.resolve({
      platform: 'weex',
      healthy: false,
      latencyMs: 0,
      failureReason: 'endpoint_gone' as FailureReason,
      details: 'API returning HTTP 521 (server down since 2026-03-14)',
      checkedAt: new Date().toISOString(),
    }),

  // =============================================
  // DEX — Working
  // =============================================

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

  // dYdX v4 indexer: /v4/leaderboard/pnl endpoint was removed.
  // Fetcher uses proxy fallback. Test the base indexer health.
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

  perpetual_protocol: () =>
    verifyEndpoint(
      'perpetual_protocol',
      'https://api.studio.thegraph.com/query/58978/perpetual-v2-optimism/version/latest',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: '{ traderDayDatas(first: 1, orderBy: tradingVolume, orderDirection: desc) { trader { id } } }',
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data?.traderDayDatas) && d.data.traderDayDatas.length > 0,
      }
    ),

  // Jupiter Perps: now requires marketMint parameter
  jupiter_perps: () =>
    verifyEndpoint(
      'jupiter_perps',
      'https://perps-api.jup.ag/v1/top-traders?marketMint=So11111111111111111111111111111111111111112&year=2026&week=current',
      {
        timeoutMs: 15000,
        validateResponse: (d: ApiResponse) =>
          !!d?.topTradersByPnl || !!d?.topTradersByVolume,
      }
    ),

  // =============================================
  // DEX — TheGraph dependent (require THEGRAPH_API_KEY)
  // =============================================

  uniswap: () => {
    const apiKey = process.env.THEGRAPH_API_KEY || ''
    if (!apiKey) {
      return skipResult('uniswap', 'auth_required', 'THEGRAPH_API_KEY not set')
    }
    return verifyEndpoint(
      'uniswap',
      `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: '{ swaps(first: 1, orderBy: amountUSD, orderDirection: desc) { origin amountUSD } }',
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data?.swaps) && d.data.swaps.length > 0,
      }
    )
  },

  pancakeswap: () => {
    const apiKey = process.env.THEGRAPH_API_KEY || ''
    if (!apiKey) {
      return skipResult('pancakeswap', 'auth_required', 'THEGRAPH_API_KEY not set')
    }
    return verifyEndpoint(
      'pancakeswap',
      `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: '{ swaps(first: 1, orderBy: amountUSD, orderDirection: desc) { origin amountUSD } }',
        },
        validateResponse: (d: ApiResponse) =>
          Array.isArray(d?.data?.swaps) && d.data.swaps.length > 0,
      }
    )
  },

  kwenta: () => {
    const apiKey = process.env.THEGRAPH_API_KEY || ''
    if (!apiKey) {
      return skipResult('kwenta', 'auth_required', 'THEGRAPH_API_KEY not set')
    }
    return verifyEndpoint(
      'kwenta',
      `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/5sbJJTTJQQ4kYuVYNBVw9sX8C5juRpVJNLHg7uFugw2e`,
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
      return skipResult('synthetix', 'auth_required', 'THEGRAPH_API_KEY not set')
    }
    return verifyEndpoint(
      'synthetix',
      `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/Cjhmx65d3EJPxYXcidLeBXFGiVrBfYEPaywVMPf3DP9M`,
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
      return skipResult('mux', 'auth_required', 'THEGRAPH_API_KEY not set')
    }
    return verifyEndpoint(
      'mux',
      `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/7hUM4US9DPz6JqLD6ySqwFmLq4XiAF7cEZLmEesQnYgR`,
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
  // Dynamically import to avoid circular dependency
  const { DEAD_BLOCKED_PLATFORMS } = await import('@/lib/constants/exchanges')
  const deadSet = new Set(DEAD_BLOCKED_PLATFORMS as string[])
  const platforms = getAllVerifiablePlatforms().filter(p => !deadSet.has(p))
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
            failureReason: classifyFetchError(err),
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
