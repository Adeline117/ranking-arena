/**
 * Cron: Snapshot daily ranks into rank_history
 * Schedule: Daily at 00:15 UTC (after compute-leaderboard has run)
 *
 * Takes a daily snapshot of leaderboard_ranks (top 500 per period) and
 * writes into rank_history for sparkline trajectory rendering.
 * Retains 30 days of history (older rows cleaned up automatically).
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { withCron } from '@/lib/api/with-cron'
import { PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import {
  filterPublicRankingSources,
  isPublicRankingSourceAllowed,
} from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'

const log = createLogger('cron:snapshot-ranks')

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PERIODS = ['7D', '30D', '90D'] as const
const TOP_N = 500
const RETAIN_DAYS = 30
const UPSERT_BATCH = 500
const SNAPSHOT_RANKING_SOURCES = Object.freeze(
  filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)
)

export const GET = withCron('snapshot-ranks', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin()
  const today = new Date().toISOString().split('T')[0]
  let totalInserted = 0

  // Parallel fetch + upsert across all 3 periods (was serial)
  const periodResults = await Promise.all(
    PERIODS.map(async (period) => {
      const sealedRows = await readSealedRankingGeneration(
        supabase,
        { season: period, sources: SNAPSHOT_RANKING_SOURCES },
        async (publication) => {
          const { data, error } = await supabase
            .from('leaderboard_ranks')
            .select('source, source_trader_id, rank, arena_score')
            .in('source', SNAPSHOT_RANKING_SOURCES)
            .eq('season_id', period)
            .filter('rank_publication_id', 'eq', publication.scoreCohortId)
            .not('rank', 'is', null)
            .order('rank', { ascending: true })
            .order('source', { ascending: true })
            .order('source_trader_id', { ascending: true })
            .limit(TOP_N)

          if (error || data === null) {
            throw new Error(
              `Failed to fetch sealed leaderboard_ranks for ${period}: ${error?.message ?? 'null payload'}`
            )
          }
          if (data.some((row) => !isPublicRankingSourceAllowed(row.source))) {
            throw new Error(`Rank snapshot for ${period} crossed the public source boundary`)
          }
          const publishedCount = publication.proofs.reduce(
            (total, proof) => total + proof.published_rank_count,
            0
          )
          if (publishedCount > 0 && data.length === 0) {
            throw new Error(`Rank snapshot for ${period} returned no published rows`)
          }
          return data
        },
        { timeoutMs: 10_000 }
      )
      const rows = sealedRows.value

      // rank 在 leaderboard_ranks 可空,但 rank_history.rank 非空 —— 跳过空 rank
      // 行(flatMap 在 else 分支收窄 row.rank 为 number)。查询已 .not('rank',is,null),
      // 此处是类型安全 + 防御双保险。
      const records = rows.flatMap((row) =>
        row.rank == null
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
          throw new Error(
            `Rank history upsert failed for ${period} batch ${i}: ${upsertError.message}`
          )
        }
        inserted += batch.length
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
    throw new Error(`Rank history cleanup failed: ${cleanupError.message}`)
  }

  return { count: totalInserted, date: today, periods: PERIODS.length }
})
