/**
 * 爬虫模块导出
 */

export { BaseScraper, parseTraderFromApi } from './base.js'
export { BinanceSpotScraper } from './binance-spot.js'
export { BinanceFuturesScraper } from './binance-futures.js'
export { BybitScraper } from './bybit.js'
export { BitgetFuturesScraper } from './bitget-futures.js'
export { BitgetSpotScraper } from './bitget-spot.js'
export { MexcScraper } from './mexc.js'
export { KucoinScraper } from './kucoin.js'
export { CoinexScraper } from './coinex.js'
export { BingxScraper } from './bingx.js'
export { PhemexScraper } from './phemex.js'

import { BinanceSpotScraper } from './binance-spot.js'
import { BinanceFuturesScraper } from './binance-futures.js'
import { BybitScraper } from './bybit.js'
import { BitgetFuturesScraper } from './bitget-futures.js'
import { BitgetSpotScraper } from './bitget-spot.js'
import { MexcScraper } from './mexc.js'
import { KucoinScraper } from './kucoin.js'
import { CoinexScraper } from './coinex.js'
import { BingxScraper } from './bingx.js'
import { PhemexScraper } from './phemex.js'
import type { DataSource } from '../types.js'
import type { BaseScraper } from './base.js'

/**
 * 根据数据源获取对应的爬虫实例
 */
export function getScraperForSource(source: DataSource): BaseScraper | null {
  switch (source) {
    case 'binance_spot':
      return new BinanceSpotScraper()
    case 'binance':
      return new BinanceFuturesScraper()
    case 'bybit':
      return new BybitScraper()
    case 'bitget':
      return new BitgetFuturesScraper()
    case 'bitget_spot':
      return new BitgetSpotScraper()
    case 'mexc':
      return new MexcScraper()
    case 'kucoin':
      return new KucoinScraper()
    case 'coinex':
      return new CoinexScraper()
    case 'bingx':
      return new BingxScraper()
    case 'phemex':
      return new PhemexScraper()
    default:
      return null
  }
}

/**
 * 获取所有可用的数据源
 */
export function getAvailableSources(): DataSource[] {
  return [
    'binance',
    'binance_spot',
    'bybit',
    'bitget',
    'bitget_spot',
    'mexc',
    'kucoin',
    'coinex',
    'bingx',
    'phemex',
  ]
}
