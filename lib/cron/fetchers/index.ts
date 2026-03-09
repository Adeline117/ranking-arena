/**
 * Platform fetcher registry
 * Maps platform names to their inline fetch functions
 * All fetchers run without child_process or puppeteer — Vercel serverless compatible
 */

import type { PlatformFetcher } from './shared'

// CEX - Pure API
import { fetchOkxFutures } from './okx-futures'
import { fetchOkxSpot } from './okx-spot'
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
import { fetchKucoin } from './kucoin'
import { fetchCoinex } from './coinex'
import { fetchPhemex } from './phemex'
import { fetchWeex } from './weex'
import { fetchLbank } from './lbank'
import { fetchBlofin } from './blofin'
import { fetchCryptocom } from './cryptocom'
import { fetchBitfinex } from './bitfinex'
import { fetchWhitebit } from './whitebit'
import { fetchBtse } from './btse'
import { fetchToobit } from './toobit'
import { fetchPionex } from './pionex'

// DEX - On-chain / Subgraph
import { fetchHyperliquid } from './hyperliquid'
import { fetchGmx } from './gmx'
import { fetchGains } from './gains'
import { fetchJupiterPerps } from './jupiter-perps'
import { fetchAevo } from './aevo'
import { fetchDydx } from './dydx'
import { fetchUniswap } from './uniswap'
import { fetchPancakeSwap } from './pancakeswap'
import fetchPerpetualProtocol from './perpetual'
import { fetchKwenta } from './kwenta'
import { fetchSynthetix } from './synthetix'
import { fetchMux } from './mux'
import { fetchBitmart } from './bitmart'
import { fetchWeb3Bot } from './web3-bot'
import { fetchDrift } from './drift'
import { fetchBitunix } from './bitunix'
import { fetchParadex } from './paradex'
import { fetchBtcc } from './btcc'

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
  okx_spot: fetchOkxSpot,
  okx_web3: fetchOkxWeb3,
  bitget_futures: fetchBitgetFutures,
  bitget_spot: fetchBitgetSpot,
  xt: fetchXt,
  bingx: fetchBingx,
  gateio: fetchGateio,
  mexc: fetchMexc,
  kucoin: fetchKucoin,
  coinex: fetchCoinex,
  phemex: fetchPhemex,
  weex: fetchWeex,
  lbank: fetchLbank,
  blofin: fetchBlofin,
  cryptocom: fetchCryptocom,
  bitfinex: fetchBitfinex,
  whitebit: fetchWhitebit,
  btse: fetchBtse,
  toobit: fetchToobit,
  pionex: fetchPionex,

  // DEX
  hyperliquid: fetchHyperliquid,
  gmx: fetchGmx,
  gains: fetchGains,
  jupiter_perps: fetchJupiterPerps,
  aevo: fetchAevo,
  dydx: fetchDydx,
  uniswap: fetchUniswap,
  pancakeswap: fetchPancakeSwap,
  perpetual_protocol: fetchPerpetualProtocol,
  kwenta: fetchKwenta,
  synthetix: fetchSynthetix,
  mux: fetchMux,
  bitmart: fetchBitmart,
  web3_bot: fetchWeb3Bot,
  drift: fetchDrift,
  bitunix: fetchBitunix,
  paradex: fetchParadex,
  btcc: fetchBtcc,
}

/**
 * Get a fetcher with automatic retry wrapper.
 * Retries once on transient errors (network, 5xx, timeout) with 2s delay.
 */
export function getInlineFetcher(platform: string): PlatformFetcher | undefined {
  const baseFetcher = INLINE_FETCHERS[platform]
  if (!baseFetcher) return undefined

  // Wrap with retry logic for transient failures
  const wrappedFetcher: PlatformFetcher = async (supabase, periods) => {
    const maxRetries = 1
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await baseFetcher(supabase, periods)
      } catch (error) {
        lastError = error
        const msg = error instanceof Error ? error.message : String(error)
        const isTransient = /timeout|abort|ECONNRESET|ETIMEDOUT|fetch failed|5\d\d|429|socket hang up/i.test(msg)
        if (attempt >= maxRetries || !isTransient) throw error
        // Wait 2s before retry with jitter
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000))
      }
    }
    throw lastError
  }
  return wrappedFetcher
}

export function getSupportedInlinePlatforms(): string[] {
  return Array.from(new Set(Object.keys(INLINE_FETCHERS)))
}
