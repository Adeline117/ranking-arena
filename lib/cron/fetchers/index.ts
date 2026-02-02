/**
 * Platform fetcher registry
 * Maps platform names to their inline fetch functions
 * All fetchers run without child_process or puppeteer — Vercel serverless compatible
 */

import type { PlatformFetcher } from './shared'

// CEX - Pure API
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
import { fetchPionex } from './pionex'
import { fetchBingx } from './bingx'
import { fetchGateio } from './gateio'
import { fetchMexc } from './mexc'
import { fetchKucoin } from './kucoin'
import { fetchCoinex } from './coinex'
import { fetchPhemex } from './phemex'
import { fetchWeex } from './weex'
import { fetchLbank } from './lbank'
import { fetchBlofin } from './blofin'

// DEX - On-chain / Subgraph
import { fetchHyperliquid } from './hyperliquid'
import { fetchGmx } from './gmx'
import { fetchKwenta } from './kwenta'
import { fetchMux } from './mux'
import { fetchGains } from './gains'

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
}

export function getInlineFetcher(platform: string): PlatformFetcher | undefined {
  return INLINE_FETCHERS[platform]
}

export function getSupportedInlinePlatforms(): string[] {
  return Array.from(new Set(Object.keys(INLINE_FETCHERS)))
}
