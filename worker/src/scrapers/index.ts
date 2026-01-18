/**
 * 爬虫模块导出
 */

export { BaseScraper, parseTraderFromApi } from './base.js'
export { BinanceSpotScraper } from './binance-spot.js'

import { BinanceSpotScraper } from './binance-spot.js'
import type { DataSource } from '../types.js'
import type { BaseScraper } from './base.js'

/**
 * 根据数据源获取对应的爬虫实例
 */
export function getScraperForSource(source: DataSource): BaseScraper | null {
  switch (source) {
    case 'binance_spot':
      return new BinanceSpotScraper()
    // TODO: 添加其他爬虫
    // case 'binance':
    //   return new BinanceFuturesScraper()
    // case 'bybit':
    //   return new BybitScraper()
    default:
      return null
  }
}

/**
 * 获取所有可用的数据源
 */
export function getAvailableSources(): DataSource[] {
  return [
    'binance_spot',
    // TODO: 添加其他数据源
    // 'binance',
    // 'bybit',
    // 'bitget',
  ]
}
