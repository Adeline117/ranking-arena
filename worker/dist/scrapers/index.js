/**
 * 爬虫模块导出
 */
export { BaseScraper, parseTraderFromApi } from './base.js';
export { BinanceSpotScraper } from './binance-spot.js';
export { BinanceFuturesScraper } from './binance-futures.js';
export { BybitScraper } from './bybit.js';
import { BinanceSpotScraper } from './binance-spot.js';
import { BinanceFuturesScraper } from './binance-futures.js';
import { BybitScraper } from './bybit.js';
/**
 * 根据数据源获取对应的爬虫实例
 */
export function getScraperForSource(source) {
    switch (source) {
        case 'binance_spot':
            return new BinanceSpotScraper();
        case 'binance':
            return new BinanceFuturesScraper();
        case 'bybit':
            return new BybitScraper();
        // TODO: 添加其他爬虫
        // case 'bitget':
        //   return new BitgetFuturesScraper()
        // case 'bitget_spot':
        //   return new BitgetSpotScraper()
        default:
            return null;
    }
}
/**
 * 获取所有可用的数据源
 */
export function getAvailableSources() {
    return [
        'binance',
        'binance_spot',
        'bybit',
        // TODO: 添加其他数据源
        // 'bitget',
        // 'bitget_spot',
        // 'mexc',
        // 'coinex',
    ];
}
//# sourceMappingURL=index.js.map