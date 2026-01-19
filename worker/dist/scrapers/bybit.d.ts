/**
 * Bybit Copy Trading 爬虫
 * 重构自 scripts/import_bybit.mjs
 * 使用 Playwright 代替 puppeteer-extra
 */
import { BaseScraper } from './base.js';
import type { TraderData, TimeRange } from '../types.js';
export declare class BybitScraper extends BaseScraper {
    private readonly baseUrl;
    private readonly targetCount;
    private readonly maxScrolls;
    constructor();
    protected scrapeData(timeRange: TimeRange): Promise<TraderData[]>;
    private extractTraders;
}
//# sourceMappingURL=bybit.d.ts.map