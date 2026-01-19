/**
 * Supabase 数据库客户端
 */
import { createClient } from '@supabase/supabase-js';
import { logger } from './logger.js';
let supabase = null;
export function getSupabaseClient() {
    if (supabase) {
        return supabase;
    }
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
        throw new Error('Missing Supabase credentials: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    }
    supabase = createClient(url, serviceKey, {
        auth: { persistSession: false },
    });
    return supabase;
}
/**
 * 保存交易员数据到数据库
 */
export async function saveTraders(traders, source, timeRange) {
    const db = getSupabaseClient();
    const capturedAt = new Date().toISOString();
    const log = logger.withContext({ source, timeRange });
    let saved = 0;
    let errors = 0;
    for (const trader of traders) {
        try {
            // Upsert trader source
            const sourceRow = {
                source,
                source_type: 'leaderboard',
                source_trader_id: trader.traderId,
                handle: trader.nickname,
                profile_url: trader.avatar,
                is_active: true,
            };
            const { error: sourceError } = await db
                .from('trader_sources')
                .upsert(sourceRow, { onConflict: 'source,source_trader_id' });
            if (sourceError) {
                log.warn('Failed to upsert trader source', {
                    traderId: trader.traderId,
                    error: sourceError.message,
                });
            }
            // Insert snapshot
            const snapshotRow = {
                source,
                source_trader_id: trader.traderId,
                season_id: timeRange,
                rank: trader.rank,
                roi: trader.roi,
                pnl: trader.pnl,
                win_rate: trader.winRate,
                max_drawdown: trader.maxDrawdown,
                followers: trader.followers || 0,
                trades_count: trader.tradesCount,
                captured_at: capturedAt,
            };
            const { error: snapshotError } = await db.from('trader_snapshots').insert(snapshotRow);
            if (snapshotError) {
                log.warn('Failed to insert snapshot', {
                    traderId: trader.traderId,
                    error: snapshotError.message,
                });
                errors++;
            }
            else {
                saved++;
            }
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            log.error('Exception saving trader', err, { traderId: trader.traderId });
            errors++;
        }
    }
    log.info('Save completed', { saved, errors, total: traders.length });
    return { saved, errors };
}
/**
 * 记录爬取日志
 */
export async function logScrapeResult(source, timeRange, success, details) {
    const db = getSupabaseClient();
    try {
        await db.from('cron_logs').insert({
            name: `scrape-${source}-${timeRange}`,
            ran_at: new Date().toISOString(),
            result: JSON.stringify({
                success,
                source,
                timeRange,
                ...details,
            }),
        });
    }
    catch (error) {
        // Ignore if cron_logs table doesn't exist
        logger.debug('Failed to log scrape result', { error: String(error) });
    }
}
//# sourceMappingURL=db.js.map