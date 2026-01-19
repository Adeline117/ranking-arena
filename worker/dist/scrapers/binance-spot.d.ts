/**
 * Binance Spot Copy Trading 爬虫
 * 重构自 scripts/import_binance_spot.mjs
 */
import { BaseScraper } from './base.js';
import type { TraderData, TimeRange } from '../types.js';
export declare class BinanceSpotScraper extends BaseScraper {
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
}
//# sourceMappingURL=binance-spot.d.ts.map