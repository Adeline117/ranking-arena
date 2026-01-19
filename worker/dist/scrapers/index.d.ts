/**
 * 爬虫模块导出
 */
export { BaseScraper, parseTraderFromApi } from './base.js';
export { BinanceSpotScraper } from './binance-spot.js';
export { BinanceFuturesScraper } from './binance-futures.js';
export { BybitScraper } from './bybit.js';
import type { DataSource } from '../types.js';
import type { BaseScraper } from './base.js';
/**
 * 根据数据源获取对应的爬虫实例
 */
export declare function getScraperForSource(source: DataSource): BaseScraper | null;
/**
 * 获取所有可用的数据源
 */
export declare function getAvailableSources(): DataSource[];
//# sourceMappingURL=index.d.ts.map