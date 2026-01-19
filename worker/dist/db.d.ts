/**
 * Supabase 数据库客户端
 */
import { SupabaseClient } from '@supabase/supabase-js';
import type { TraderData, DataSource, TimeRange } from './types.js';
export declare function getSupabaseClient(): SupabaseClient;
/**
 * 保存交易员数据到数据库
 */
export declare function saveTraders(traders: TraderData[], source: DataSource, timeRange: TimeRange): Promise<{
    saved: number;
    errors: number;
}>;
/**
 * 记录爬取日志
 */
export declare function logScrapeResult(source: DataSource, timeRange: TimeRange, success: boolean, details: {
    tradersCount: number;
    duration: number;
    error?: string;
}): Promise<void>;
//# sourceMappingURL=db.d.ts.map