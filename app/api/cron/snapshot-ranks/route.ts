/**
 * Cron: Snapshot daily ranks into rank_history
 * Schedule: Daily at 00:15 UTC (after compute-leaderboard has run)
 *
 * Takes a daily snapshot of leaderboard_ranks (top 500 per period) and
 * writes into rank_history for sparkline trajectory rendering.
 * Retains 30 days of history (older rows cleaned up automatically).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'
import { createLogger } from '@/lib/utils/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

const log = createLogger('cron:snapshot-ranks')

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PERIODS = ['7D', '30D', '90D'] as const
const TOP_N = 500
const RETAIN_DAYS = 30
const UPSERT_BATCH = 500

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const plog = await PipelineLogger.start('snapshot-ranks')

  try {
    const today = new Date().toISOString().split('T')[0]
    let totalInserted = 0

    for (const period of PERIODS) {
      // Fetch top 500 traders for this period from leaderboard_ranks
      const { data: rows, error: fetchError } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, rank, arena_score')
        .eq('season_id', period)
        .not('rank', 'is', null)
        .order('rank', { ascending: true })
        .limit(TOP_N)

      if (fetchError) {
        log.error(`Failed to fetch leaderboard_ranks for ${period}`, { error: fetchError.message })
        continue
      }

      if (!rows || rows.length === 0) {
        log.warn(`No rows found for period ${period}`)
        continue
      }

      // Build upsert records
      const records = rows.map(row => ({
        platform: row.source,
        trader_key: row.source_trader_id,
        period,
        rank: row.rank,
        arena_score: row.arena_score,
        snapshot_date: today,
      }))

      // Batch upsert into rank_history
      for (let i = 0; i < records.length; i += UPSERT_BATCH) {
        const batch = records.slice(i, i + UPSERT_BATCH)
        const { error: upsertError } = await supabase
          .from('rank_history')
          .upsert(batch, { onConflict: 'platform,trader_key,period,snapshot_date' })

        if (upsertError) {
          log.error(`Upsert error for ${period} batch ${i}`, { error: upsertError.message })
        } else {
          totalInserted += batch.length
        }
      }

      log.info(`Snapshotted ${records.length} traders for ${period}`)
    }

    // Cleanup old rows (>30 days)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - RETAIN_DAYS)
    const cutoffDate = cutoff.toISOString().split('T')[0]

    const { error: cleanupError } = await supabase
      .from('rank_history')
      .delete()
      .lt('snapshot_date', cutoffDate)

    if (cleanupError) {
      log.warn('Cleanup error', { error: cleanupError.message })
    }

    await plog.success(totalInserted, { date: today, periods: PERIODS.length })

    return NextResponse.json({
      success: true,
      date: today,
      inserted: totalInserted,
      periods: PERIODS,
    })
  } catch (err) {
    log.error('Unexpected error', { error: err instanceof Error ? err.message : String(err) })
    await plog.error(err)
    return NextResponse.json(
      { error: 'Internal server error', detail: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
