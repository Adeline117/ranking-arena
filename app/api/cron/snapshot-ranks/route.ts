/**
 * Cron: Snapshot daily ranks into rank_history
 * Schedule: Daily at 00:15 UTC (after compute-leaderboard has run)
 *
 * Takes a daily snapshot of the sealed public cohort (public_ranked_leaderboard,
 * top 500 per period) and writes into rank_history for sparkline trajectory
 * rendering. Raw leaderboard_ranks rows of an unsealed, isolated or expired
 * cohort never enter the history.
 * Retains 30 days of history (older rows cleaned up automatically).
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { withCron } from '@/lib/api/with-cron'

const log = createLogger('cron:snapshot-ranks')

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PERIODS = ['7D', '30D', '90D'] as const
const TOP_N = 500
const RETAIN_DAYS = 30
const UPSERT_BATCH = 500

export const GET = withCron(
  'snapshot-ranks',
  async (_request: NextRequest) => {
    const supabase = getSupabaseAdmin()
    const today = new Date().toISOString().split('T')[0]
    let totalInserted = 0
    // Every DB error is collected and fails the run at the end (after the
    // other periods had their chance) instead of being logged as success.
    const failures: string[] = []

    // Parallel fetch + upsert across all 3 periods (was serial)
    const periodResults = await Promise.all(
      PERIODS.map(async (period) => {
        const { data: rows, error: fetchError } = await supabase
          .from('public_ranked_leaderboard')
          .select('source, source_trader_id, rank, arena_score')
          .eq('season_id', period)
          .not('rank', 'is', null)
          .order('rank', { ascending: true })
          .limit(TOP_N)

        if (fetchError) {
          log.error(`Failed to fetch public_ranked_leaderboard for ${period}`, {
            error: fetchError.message,
          })
          failures.push(`${period} fetch: ${fetchError.message}`)
          return 0
        }
        if (!rows || rows.length === 0) {
          log.warn(`No rows found for period ${period}`)
          return 0
        }

        // 视图列在生成类型里都可空,rank_history 的这三列非空 —— 跳过空值行
        // (flatMap 收窄类型)。
        const records = rows.flatMap((row) =>
          row.rank == null || row.source == null || row.source_trader_id == null
            ? []
            : [
                {
                  platform: row.source,
                  trader_key: row.source_trader_id,
                  period,
                  rank: row.rank,
                  arena_score: row.arena_score,
                  snapshot_date: today,
                },
              ]
        )

        let inserted = 0
        for (let i = 0; i < records.length; i += UPSERT_BATCH) {
          const batch = records.slice(i, i + UPSERT_BATCH)
          const { error: upsertError } = await supabase
            .from('rank_history')
            .upsert(batch, { onConflict: 'platform,trader_key,period,snapshot_date' })
          if (upsertError) {
            log.error(`Upsert error for ${period} batch ${i}`, { error: upsertError.message })
            failures.push(`${period} upsert batch ${i}: ${upsertError.message}`)
          } else {
            inserted += batch.length
          }
        }
        log.info(`Snapshotted ${records.length} traders for ${period}`)
        return inserted
      })
    )
    totalInserted = periodResults.reduce((sum, n) => sum + n, 0)

    // Cleanup old rows (>30 days)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - RETAIN_DAYS)
    const cutoffDate = cutoff.toISOString().split('T')[0]

    const { error: cleanupError } = await supabase
      .from('rank_history')
      .delete()
      .lt('snapshot_date', cutoffDate)

    if (cleanupError) {
      log.error('Cleanup error', { error: cleanupError.message })
      failures.push(`cleanup: ${cleanupError.message}`)
    }

    if (failures.length > 0) {
      throw new Error(
        `snapshot-ranks: ${failures.length} DB error(s), ${totalInserted} rows written — ${failures.join('; ')}`
      )
    }

    return { count: totalInserted, date: today, periods: PERIODS.length }
  },
  { maxDurationSec: maxDuration }
)
