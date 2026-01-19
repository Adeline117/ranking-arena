/**
 * Binance Futures Copy Trading 爬虫
 * 重构自 scripts/import_binance_futures.mjs
 */
import { BaseScraper } from './base.js';
import type { TraderData, TimeRange } from '../types.js';
export declare class BinanceFuturesScraper extends BaseScraper {
    private readonly baseUrl;
    private readonly targetCount;
    private readonly perPage;
    private apiResponses;
    constructor();
    protected scrapeData(timeRange: TimeRange): Promise<TraderData[]>;
    private handleApiResponse;
    private clickSortByRoi;
    private switchTimePeriod;
    private clickNextPage;
    private extractFromDom;
}
//# sourceMappingURL=binance-futures.d.ts.map