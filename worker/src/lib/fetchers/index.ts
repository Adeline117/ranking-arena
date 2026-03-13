/**
 * Platform fetcher registry
 * Maps platform names to their inline fetch functions
 * All fetchers run without child_process or puppeteer — Vercel serverless compatible
 */

import type { PlatformFetcher } from './shared.js'

// CEX - Pure API
import { fetchOkxFutures } from './okx-futures.js'
import { fetchHtx } from './htx.js'
import { fetchBinanceFutures } from './binance-futures.js'
import { fetchBinanceSpot } from './binance-spot.js'
import { fetchBinanceWeb3 } from './binance-web3.js'
import { fetchBybit } from './bybit.js'
import { fetchBybitSpot } from './bybit-spot.js'
import { fetchOkxWeb3 } from './okx-web3.js'
import { fetchBitgetFutures } from './bitget-futures.js'
import { fetchBitgetSpot } from './bitget-spot.js'
import { fetchXt } from './xt.js'
import { fetchPionex } from './pionex.js'
import { fetchBingx } from './bingx.js'
import { fetchGateio } from './gateio.js'
import { fetchMexc } from './mexc.js'
import { fetchKucoin } from './kucoin.js'
import { fetchCoinex } from './coinex.js'
import { fetchPhemex } from './phemex.js'
import { fetchWeex } from './weex.js'
import { fetchLbank } from './lbank.js'
import { fetchBlofin } from './blofin.js'

// DEX - On-chain / Subgraph
import { fetchHyperliquid } from './hyperliquid.js'
import { fetchGmx } from './gmx.js'
import { fetchKwenta } from './kwenta.js'
import { fetchMux } from './mux.js'
import { fetchGains } from './gains.js'
import { fetchVertex } from './vertex.js'
import { fetchDrift } from './drift.js'
import { fetchJupiterPerps } from './jupiter-perps.js'
import { fetchAevo } from './aevo.js'
import { fetchSynthetix } from './synthetix.js'
import { fetchDydx } from './dydx.js'

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
  pionex: fetchPionex,
  bingx: fetchBingx,
  gateio: fetchGateio,
  mexc: fetchMexc,
  kucoin: fetchKucoin,
  coinex: fetchCoinex,
  phemex: fetchPhemex,
  weex: fetchWeex,
  lbank: fetchLbank,
  blofin: fetchBlofin,

  // DEX
  hyperliquid: fetchHyperliquid,
  gmx: fetchGmx,
  kwenta: fetchKwenta,
  mux: fetchMux,
  gains: fetchGains,
  vertex: fetchVertex,
  drift: fetchDrift,
  jupiter_perps: fetchJupiterPerps,
  aevo: fetchAevo,
  synthetix: fetchSynthetix,
  dydx: fetchDydx,
}

export function getInlineFetcher(platform: string): PlatformFetcher | undefined {
  return INLINE_FETCHERS[platform]
}

export function getSupportedInlinePlatforms(): string[] {
  return Array.from(new Set(Object.keys(INLINE_FETCHERS)))
}
