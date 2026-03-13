/**
 * Platform fetcher registry (DEPRECATED — Connector framework is now primary)
 *
 * All 24 active platforms now use ConnectorRegistry + ConnectorDbAdapter
 * in batch-fetch-traders. This registry is kept as:
 * 1. Fallback if a connector fails to initialize
 * 2. Reference for backfill-data and other legacy callers
 * 3. getSupportedInlinePlatforms() used by check-data-freshness & daily-digest
 *
 * Platform fetcher files moved to _deprecated/ (March 2026).
 *
 * @deprecated Use ConnectorRegistry from lib/connectors/registry.ts instead
 */

import type { PlatformFetcher } from './shared'

// CEX - Pure API (imports from _deprecated/)
import { fetchOkxFutures } from './_deprecated/okx-futures'
import { fetchHtx } from './_deprecated/htx'
import { fetchBinanceFutures } from './_deprecated/binance-futures'
import { fetchBinanceSpot } from './_deprecated/binance-spot'
import { fetchBinanceWeb3 } from './_deprecated/binance-web3'
import { fetchOkxWeb3 } from './_deprecated/okx-web3'
import { fetchBitgetFutures } from './_deprecated/bitget-futures'
import { fetchXt } from './_deprecated/xt'
import { fetchBingx } from './_deprecated/bingx'
import { fetchGateio } from './_deprecated/gateio'
import { fetchMexc } from './_deprecated/mexc'
import { fetchCoinex } from './_deprecated/coinex'
import { fetchPhemex } from './_deprecated/phemex'
import { fetchBlofin } from './_deprecated/blofin'
import { fetchBitfinex } from './_deprecated/bitfinex'
import { fetchToobit } from './_deprecated/toobit'
import { fetchDrift } from './_deprecated/drift'
import { fetchBitunix } from './_deprecated/bitunix'
import { fetchBtcc } from './_deprecated/btcc'
import { fetchWeb3Bot } from './_deprecated/web3-bot'
import { fetchEtoro } from './_deprecated/etoro'
import { fetchHyperliquid } from './_deprecated/hyperliquid'
import { fetchGmx } from './_deprecated/gmx'
import { fetchGains } from './_deprecated/gains'
import { fetchJupiterPerps } from './_deprecated/jupiter-perps'
import { fetchAevo } from './_deprecated/aevo'
import { fetchDydx } from './_deprecated/dydx'
import { fetchKwenta } from './_deprecated/kwenta'

/** @deprecated Use ConnectorRegistry instead */
export const INLINE_FETCHERS: Record<string, PlatformFetcher> = {
  okx_futures: fetchOkxFutures,
  htx_futures: fetchHtx,
  binance_futures: fetchBinanceFutures,
  binance_spot: fetchBinanceSpot,
  binance_web3: fetchBinanceWeb3,
  okx_web3: fetchOkxWeb3,
  bitget_futures: fetchBitgetFutures,
  xt: fetchXt,
  bingx: fetchBingx,
  gateio: fetchGateio,
  mexc: fetchMexc,
  coinex: fetchCoinex,
  phemex: fetchPhemex,
  blofin: fetchBlofin,
  bitfinex: fetchBitfinex,
  toobit: fetchToobit,
  drift: fetchDrift,
  bitunix: fetchBitunix,
  btcc: fetchBtcc,
  web3_bot: fetchWeb3Bot,
  etoro: fetchEtoro,
  hyperliquid: fetchHyperliquid,
  gmx: fetchGmx,
  gains: fetchGains,
  jupiter_perps: fetchJupiterPerps,
  aevo: fetchAevo,
  dydx: fetchDydx,
  kwenta: fetchKwenta,
}

/** @deprecated Use ConnectorRegistry instead */
export function getInlineFetcher(platform: string): PlatformFetcher | undefined {
  return INLINE_FETCHERS[platform]
}

/** Returns list of platforms with inline fetchers. Used by check-data-freshness and daily-digest. */
export function getSupportedInlinePlatforms(): string[] {
  return Array.from(new Set(Object.keys(INLINE_FETCHERS)))
}
