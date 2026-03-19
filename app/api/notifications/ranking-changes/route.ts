import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('ranking-change-notifications')

  try {
    const supabase = getSupabaseAdmin()
    let notificationsCreated = 0

    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('user_id, watched_traders, ranking_change_threshold')
      .eq('email_notifications', true)

    if (!prefs || prefs.length === 0) {
      await plog.success(0)
      return NextResponse.json({ ok: true, notifications: 0 })
    }

    // Build a map: trader key → set of user IDs watching it
    // Also build a per-user threshold lookup
    const allWatched = new Map<string, Set<string>>()
    const userThresholds = new Map<string, number>()

    for (const pref of prefs) {
      userThresholds.set(pref.user_id, pref.ranking_change_threshold ?? 10)
      const traders = pref.watched_traders as Array<{ source: string; source_trader_id: string }> | null
      if (!traders || !Array.isArray(traders)) continue
      for (const t of traders) {
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
    const uniqueSources = [...new Set(watchedSources)]
    const { data: currentRanks } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, rank, arena_score')
      .in('source', uniqueSources)
      .in('source_trader_id', watchedTraderIds)
      .eq('season_id', '90D')

    // Build current rank lookup: key → { rank, arena_score }
    const currentRankMap = new Map<string, { rank: number; arena_score: number | null }>()
    if (currentRanks) {
      for (const row of currentRanks) {
        currentRankMap.set(`${row.source}:${row.source_trader_id}`, { rank: row.rank, arena_score: row.arena_score })
      }
    }

    // BATCH QUERY 2: Fetch ALL previous ranks in one query
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
    const { data: prevRanks } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, trader_key, rank')
      .in('platform', uniqueSources)
      .in('trader_key', watchedTraderIds)
      .eq('window', '90D')
      .gte('created_at', `${yesterday}T00:00:00Z`)
      .order('created_at', { ascending: false })

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
    const { data: traderInfos } = await supabase
      .from('trader_sources')
      .select('source, source_trader_id, handle')
      .in('source', uniqueSources)
      .in('source_trader_id', watchedTraderIds)

    const handleMap = new Map<string, string>()
    if (traderInfos) {
      for (const t of traderInfos) {
        handleMap.set(`${t.source}:${t.source_trader_id}`, t.handle || t.source_trader_id)
      }
    }

    // Build all notifications to BATCH INSERT
    const notificationRows: Array<{
      user_id: string
      type: string
      title: string
      body: string
      data: Record<string, unknown>
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
        const title = direction === 'up'
          ? `${handle} rose ${absChange} ranks`
          : `${handle} dropped ${absChange} ranks`
        const body = `Now ranked #${current.rank} (was #${prevRank})`

        notificationRows.push({
          user_id: userId,
          type: 'ranking_change',
          title,
          body,
          data: { source, source_trader_id: sourceId, handle, old_rank: prevRank, new_rank: current.rank, change: rankChange },
        })
      }
    }

    // BATCH INSERT all notifications in one query (chunks of 500 to avoid payload limits)
    const BATCH_SIZE = 500
    for (let i = 0; i < notificationRows.length; i += BATCH_SIZE) {
      const batch = notificationRows.slice(i, i + BATCH_SIZE)
      const { error: insertError } = await supabase.from('notifications').insert(batch)
      if (insertError) {
        logger.error('[Notifications] Batch insert error:', insertError)
      } else {
        notificationsCreated += batch.length
      }
    }

    await plog.success(notificationsCreated)
    return NextResponse.json({ ok: true, notifications: notificationsCreated })
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    logger.error('[Notifications] Ranking changes error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
