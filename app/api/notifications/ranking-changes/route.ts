import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import {
  filterPublicRankingSources,
  isPublicRankingSourceAllowed,
} from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import { createRankingNotificationsBatch } from '@/lib/data/ranking-notifications'
import { watchedRankingChangeLink, watchedRankingChangeReference } from './notification-identity'

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('ranking-change-notifications')

  try {
    const supabase = getSupabaseAdmin()

    const { data: prefs, error: prefsError } = await supabase
      .from('user_preferences')
      .select('user_id, watched_traders, ranking_change_threshold')
      .eq('email_notifications', true)

    if (prefsError || prefs === null) {
      throw new Error(
        `Failed to load ranking notification preferences: ${prefsError?.message ?? 'null payload'}`
      )
    }
    if (!prefs || prefs.length === 0) {
      await plog.success(0)
      return NextResponse.json({ ok: true, notifications: 0 })
    }

    // Build a map: trader key → set of user IDs watching it
    // Also build a per-user threshold lookup
    const allWatched = new Map<string, Set<string>>()
    const userThresholds = new Map<string, number>()

    for (const pref of prefs) {
      const threshold = pref.ranking_change_threshold
      userThresholds.set(
        pref.user_id,
        typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 1
          ? threshold
          : 10
      )
      const traders = pref.watched_traders as Array<{
        source: string
        source_trader_id: string
      }> | null
      if (!traders || !Array.isArray(traders)) continue
      for (const t of traders) {
        if (
          typeof t?.source !== 'string' ||
          !isPublicRankingSourceAllowed(t.source) ||
          typeof t.source_trader_id !== 'string' ||
          t.source_trader_id.length === 0 ||
          t.source_trader_id !== t.source_trader_id.trim()
        ) {
          continue
        }
        const key = `${t.source}:${t.source_trader_id}`
        if (!allWatched.has(key)) allWatched.set(key, new Set())
        allWatched.get(key)!.add(pref.user_id)
      }
    }

    if (allWatched.size === 0) {
      await plog.success(0)
      return NextResponse.json({ ok: true, notifications: 0 })
    }

    // Decompose watched keys into (source, source_trader_id) arrays for batch queries
    const watchedSources: string[] = []
    const watchedTraderIds: string[] = []
    for (const key of allWatched.keys()) {
      const colonIdx = key.indexOf(':')
      watchedSources.push(key.slice(0, colonIdx))
      watchedTraderIds.push(key.slice(colonIdx + 1))
    }

    // BATCH QUERY 1: Fetch ALL current ranks in one query
    // Filter by source+source_trader_id pairs using OR conditions via RPC or in-clause
    // Supabase doesn't support multi-column IN, so we fetch all rows for the sources and
    // filter in-memory — still far fewer queries than N individual lookups.
    const uniqueSources = filterPublicRankingSources(watchedSources)
    const sealedCurrentRanks = await readSealedRankingGeneration(
      supabase,
      { season: '90D', sources: uniqueSources },
      async (publication) => {
        const { data, error } = await supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, rank, arena_score')
          .in('source', uniqueSources)
          .in('source_trader_id', watchedTraderIds)
          .eq('season_id', '90D')
          .filter('rank_publication_id', 'eq', publication.scoreCohortId)

        if (error || data === null) {
          throw new Error(
            `Failed to load current sealed ranks: ${error?.message ?? 'null payload'}`
          )
        }
        if (data.some((row) => !isPublicRankingSourceAllowed(row.source))) {
          throw new Error('ranking notification query crossed the public source boundary')
        }
        return data
      },
      { timeoutMs: 15_000 }
    )
    const currentRanks = sealedCurrentRanks.value

    // Build current rank lookup: key → { rank, arena_score }
    const currentRankMap = new Map<string, { rank: number; arena_score: number | null }>()
    if (currentRanks) {
      for (const row of currentRanks) {
        if (row.rank === null || !Number.isFinite(row.rank) || row.rank < 1) continue
        currentRankMap.set(`${row.source}:${row.source_trader_id}`, {
          rank: row.rank,
          arena_score: row.arena_score,
        })
      }
    }

    // BATCH QUERY 2: previous ranks. Migrated off retiring trader_snapshots_v2 →
    // rank_history (period='90D', snapshot_date; actively written by snapshot-ranks).
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
    const { data: prevRanks, error: prevRanksError } = await supabase
      .from('rank_history')
      .select('platform, trader_key, rank')
      .in('platform', uniqueSources)
      .in('trader_key', watchedTraderIds)
      .eq('period', '90D')
      .eq('snapshot_date', yesterday)
      .order('snapshot_date', { ascending: false })

    if (prevRanksError || prevRanks === null) {
      throw new Error(`Failed to load previous ranks: ${prevRanksError?.message ?? 'null payload'}`)
    }
    // Build prev rank lookup: keep only the latest row per (platform, trader_key)
    const prevRankMap = new Map<string, number>()
    if (prevRanks) {
      for (const row of prevRanks) {
        const key = `${row.platform}:${row.trader_key}`
        if (!prevRankMap.has(key) && row.rank != null) {
          prevRankMap.set(key, row.rank)
        }
      }
    }

    // BATCH QUERY 3: Fetch ALL trader handles in one query
    const { data: traderInfos, error: traderInfosError } = await supabase
      .from('trader_sources')
      .select('source, source_trader_id, handle')
      .in('source', uniqueSources)
      .in('source_trader_id', watchedTraderIds)

    if (traderInfosError || traderInfos === null) {
      throw new Error(
        `Failed to load watched trader identities: ${traderInfosError?.message ?? 'null payload'}`
      )
    }
    const handleMap = new Map<string, string>()
    if (traderInfos) {
      for (const t of traderInfos) {
        handleMap.set(`${t.source}:${t.source_trader_id}`, t.handle || t.source_trader_id)
      }
    }

    // Build one stable logical identity per recipient and rank movement. The
    // batch authority makes a retry after any committed chunk harmless.
    const notificationRows: Array<{
      userId: string
      title: string
      message: string
      link: string
      referenceId: string
    }> = []

    for (const [key, userIds] of allWatched) {
      const current = currentRankMap.get(key)
      if (!current?.rank) continue

      const prevRank = prevRankMap.get(key)
      if (!prevRank) continue

      const rankChange = prevRank - current.rank
      const absChange = Math.abs(rankChange)

      const colonIdx = key.indexOf(':')
      const source = key.slice(0, colonIdx)
      const sourceId = key.slice(colonIdx + 1)
      const handle = handleMap.get(key) || sourceId

      for (const userId of userIds) {
        const threshold = userThresholds.get(userId) ?? 10
        if (absChange < threshold) continue

        const direction = rankChange > 0 ? 'up' : 'down'
        const title =
          direction === 'up'
            ? `${handle} rose ${absChange} ranks`
            : `${handle} dropped ${absChange} ranks`
        const message = `Now ranked #${current.rank} (was #${prevRank})`

        notificationRows.push({
          userId,
          title,
          message,
          link: watchedRankingChangeLink(sourceId, source),
          referenceId: watchedRankingChangeReference(
            sourceId,
            source,
            yesterday,
            prevRank,
            current.rank
          ),
        })
      }
    }

    const delivery = await createRankingNotificationsBatch(supabase, notificationRows)

    await plog.success(delivery.createdCount, {
      requested: delivery.requestedCount,
      deduplicated: delivery.deduplicatedCount,
      skipped: delivery.skippedCount,
    })
    return NextResponse.json({
      ok: true,
      notifications: delivery.createdCount,
      deduplicated: delivery.deduplicatedCount,
      skipped: delivery.skippedCount,
    })
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    logger.error('[Notifications] Ranking changes error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
