/**
 * Cron: Generate trader activity feed events
 * Schedule: Every 6 hours (after compute-leaderboard)
 *
 * Scans leaderboard_ranks for notable events and writes to trader_activities.
 * Dedup key prevents duplicate entries for the same event on the same day.
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { withCron } from '@/lib/api/with-cron'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'

const log = createLogger('cron:generate-activities')

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const EXCHANGE_NAMES: Record<string, string> = {
  binance_futures: 'Binance',
  hyperliquid: 'Hyperliquid',
  okx_futures: 'OKX',
  bitget_futures: 'Bitget',
  gmx: 'GMX',
  bybit: 'Bybit',
  dydx: 'dYdX',
  aevo: 'Aevo',
  drift: 'Drift',
  gains: 'Gains',
  mexc: 'MEXC',
  htx_futures: 'HTX',
  gateio: 'Gate.io',
  coinex: 'CoinEx',
}

function exchangeName(source: string): string {
  return EXCHANGE_NAMES[source] || source
}

export const GET = withCron('generate-activities', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin()
  const today = new Date().toISOString().split('T')[0]
  const now = new Date().toISOString()

  const activities: Array<{
    source: string
    source_trader_id: string
    handle: string | null
    avatar_url: string | null
    activity_type: string
    activity_text: string
    metric_value: number | null
    metric_label: string | null
    dedup_key: string
    occurred_at: string
  }> = []

  // Fetch top traders from one stable public generation.
  const sealedRead = await readSealedRankingAuthorityGeneration(
    supabase,
    '90D',
    async (publication) => {
      const authoritySources = publication.proofs.map((proof) => proof.source)
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, handle, avatar_url, rank, arena_score, roi, pnl')
        .in('source', authoritySources)
        .eq('season_id', '90D')
        .filter('rank_publication_id', 'eq', publication.scoreCohortId)
        .gt('arena_score', 0)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .order('arena_score', { ascending: false })
        .order('source', { ascending: true })
        .order('source_trader_id', { ascending: true })
        .limit(200)

      if (error || data === null) {
        throw new Error(`activity ranking query failed: ${error?.message ?? 'null payload'}`)
      }
      if (data.some((row) => !isPublicRankingSourceAllowed(row.source))) {
        throw new Error('activity ranking query crossed the public source boundary')
      }
      return data
    },
    { timeoutMs: 10_000 }
  )
  const leaders = sealedRead.value

  if (leaders.length === 0) {
    return { count: 0, reason: 'no leaderboard data' }
  }

  for (const t of leaders) {
    const name = t.handle || t.source_trader_id
    const ex = exchangeName(t.source)

    // leaderboard_ranks.rank is the global cross-source rank, not a platform-local rank.
    if (t.rank != null && t.rank <= 10) {
      activities.push({
        source: t.source,
        source_trader_id: t.source_trader_id,
        handle: t.handle,
        avatar_url: t.avatar_url,
        activity_type: 'entered_top10',
        activity_text: `${name} ranked #${t.rank} across Arena with ${Number(t.roi).toFixed(1)}% ROI (${ex})`,
        metric_value: t.arena_score,
        metric_label: 'Arena Score',
        dedup_key: `${t.source}:${t.source_trader_id}:top10:${today}`,
        occurred_at: now,
      })
    }

    // High ROI (>500%)
    if (Number(t.roi) > 500 && Number(t.arena_score) > 70) {
      activities.push({
        source: t.source,
        source_trader_id: t.source_trader_id,
        handle: t.handle,
        avatar_url: t.avatar_url,
        activity_type: 'roi_milestone',
        activity_text: `${name} achieved ${Math.round(Number(t.roi))}% ROI on ${ex}`,
        metric_value: Number(t.roi),
        metric_label: 'ROI %',
        dedup_key: `${t.source}:${t.source_trader_id}:roi500:${today}`,
        occurred_at: now,
      })
    }

    // Large profit (>$10K)
    if (Number(t.pnl) > 10000) {
      activities.push({
        source: t.source,
        source_trader_id: t.source_trader_id,
        handle: t.handle,
        avatar_url: t.avatar_url,
        activity_type: 'large_profit',
        activity_text: `${name} earned $${Math.round(Number(t.pnl)).toLocaleString()} profit`,
        metric_value: Number(t.pnl),
        metric_label: 'PnL USD',
        dedup_key: `${t.source}:${t.source_trader_id}:pnl10k:${today}`,
        occurred_at: now,
      })
    }
  }

  // Batch upsert (dedup key prevents duplicates)
  if (activities.length > 0) {
    const { error } = await supabase
      .from('trader_activities')
      .upsert(activities, { onConflict: 'dedup_key', ignoreDuplicates: true })

    if (error) {
      log.error('Failed to upsert activities', { error: error.message })
      throw error
    }
  }

  // Cleanup: remove activities older than 30 days
  await supabase
    .from('trader_activities')
    .delete()
    .lt('occurred_at', new Date(Date.now() - 30 * 86400000).toISOString())

  log.info(`Generated ${activities.length} activities`)
  return { count: activities.length }
})
