/**
 * Platform fetcher registry
 * Maps platform names to their inline fetch functions
 * All fetchers run without child_process or puppeteer — Vercel serverless compatible
 * 
 * 2026-03-09: Deep clean - removed all failing platforms
 */

import type { PlatformFetcher } from './shared'

// CEX - Pure API (Working platforms only)
import { fetchOkxFutures } from './okx-futures'
import { fetchHtx } from './htx'
import { fetchBinanceFutures } from './binance-futures'
import { fetchBinanceSpot } from './binance-spot'
import { fetchBinanceWeb3 } from './binance-web3'
import { fetchBybit } from './bybit'
import { fetchBybitSpot } from './bybit-spot'
import { fetchOkxWeb3 } from './okx-web3'
import { fetchBitgetFutures } from './bitget-futures'
import { fetchBitgetSpot } from './bitget-spot'
import { fetchXt } from './xt'
import { fetchBingx } from './bingx'
import { fetchGateio } from './gateio'
import { fetchMexc } from './mexc'
import { fetchCoinex } from './coinex'
import { fetchPhemex } from './phemex'
import { fetchBlofin } from './blofin'
import { fetchBitfinex } from './bitfinex'
// Removed: fetchWhitebit (2026-03-10: stub — no copy-trading API exists)
// Removed: fetchBtse (2026-03-10: stub — no public leaderboard API)
// Removed: fetchWeex (disabled 2026-02-08: API returns 521)
// Removed: fetchLbank (disabled 2026-03-08: API returns "no data")
// Removed: fetchKucoin (disabled 2026-03-08: API returns 404)
// Removed: fetchToobit (2026-03-09: API returns HTML, not JSON)
// Removed: fetchCryptocom (2026-03-09: WAF blocked, HTTP 403)
// Removed: fetchPionex (2026-03-09: WAF blocked, HTTP 403)

// New CEX/DEX - Verified working, were missing registration
import { fetchDrift } from './drift'
import { fetchBitunix } from './bitunix'
import { fetchBtcc } from './btcc'
import { fetchWeb3Bot } from './web3-bot'

// Social trading platforms
import { fetchEtoro } from './etoro'

// DEX - On-chain / Subgraph (Working platforms only)
import { fetchHyperliquid } from './hyperliquid'
import { fetchGmx } from './gmx'
import { fetchGains } from './gains'
import { fetchJupiterPerps } from './jupiter-perps'
import { fetchAevo } from './aevo'
import { fetchDydx } from './dydx'
// Removed: fetchUniswap (2026-03-09: empty_data - no usable data)
// Removed: fetchPancakeSwap (2026-03-09: empty_data - no usable data)
// Removed: fetchSynthetix (2026-03-09: requires THEGRAPH_API_KEY)
// Removed: fetchKwenta (2026-03-09: requires THEGRAPH_API_KEY)
// Removed: fetchMux (2026-03-09: requires THEGRAPH_API_KEY)
// Removed: fetchPerpetualProtocol (2026-03-09: The Graph subgraph deprecated)

export const INLINE_FETCHERS: Record<string, PlatformFetcher> = {
  // CEX Futures
  okx_futures: fetchOkxFutures,
  htx: fetchHtx,
  htx_futures: fetchHtx, // alias
  binance_futures: fetchBinanceFutures,
  binance_spot: fetchBinanceSpot,
  binance_web3: fetchBinanceWeb3,
  bybit: fetchBybit,
  bybit_spot: fetchBybitSpot,
  okx_web3: fetchOkxWeb3,
  bitget_futures: fetchBitgetFutures,
  bitget_spot: fetchBitgetSpot,
  xt: fetchXt,
  bingx: fetchBingx,
  gateio: fetchGateio,
  mexc: fetchMexc,
  coinex: fetchCoinex,
  phemex: fetchPhemex,
  blofin: fetchBlofin,
  bitfinex: fetchBitfinex,
  // whitebit: stub (no copy-trading API)
  // btse: stub (no public leaderboard API)

  // New platforms (previously missing registration)
  drift: fetchDrift,
  bitunix: fetchBitunix,
  btcc: fetchBtcc,
  web3_bot: fetchWeb3Bot,

  // Social trading
  etoro: fetchEtoro,

  // DEX
  hyperliquid: fetchHyperliquid,
  gmx: fetchGmx,
  gains: fetchGains,
  jupiter_perps: fetchJupiterPerps,
  aevo: fetchAevo,
  dydx: fetchDydx,
}

export function getInlineFetcher(platform: string): PlatformFetcher | undefined {
  return INLINE_FETCHERS[platform]
}

export function getSupportedInlinePlatforms(): string[] {
  return Array.from(new Set(Object.keys(INLINE_FETCHERS)))
}
