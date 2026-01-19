/**
 * Arena Worker 主入口
 * 用于定时任务或 HTTP 触发
 */
import 'dotenv/config';
import type { DataSource, TimeRange, ScrapeResult } from './types.js';
export { logger } from './logger.js';
export { getScraperForSource, getAvailableSources } from './scrapers/index.js';
export { saveTraders, logScrapeResult } from './db.js';
export type { DataSource, TimeRange, TraderData, ScrapeResult } from './types.js';
/**
 * 执行单个数据源的抓取
 */
export declare function scrapeSource(source: DataSource, timeRanges?: TimeRange[]): Promise<ScrapeResult[]>;
/**
 * 执行所有数据源的抓取
 */
export declare function scrapeAll(): Promise<Map<DataSource, ScrapeResult[]>>;
//# sourceMappingURL=index.d.ts.map