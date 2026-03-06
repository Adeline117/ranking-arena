import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()
    let notificationsCreated = 0

    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('user_id, watched_traders, ranking_change_threshold')
      .eq('email_notifications', true)

    if (!prefs || prefs.length === 0) {
      return NextResponse.json({ ok: true, notifications: 0 })
    }

    const allWatched = new Map<string, Set<string>>()
    for (const pref of prefs) {
      const traders = pref.watched_traders as Array<{ source: string; source_trader_id: string }> | null
      if (!traders || !Array.isArray(traders)) continue
      for (const t of traders) {
        const key = `${t.source}:${t.source_trader_id}`
        if (!allWatched.has(key)) allWatched.set(key, new Set())
        allWatched.get(key)!.add(pref.user_id)
      }
    }

    if (allWatched.size === 0) {
      return NextResponse.json({ ok: true, notifications: 0 })
    }

    for (const [key, userIds] of allWatched) {
      const [source, sourceId] = key.split(':')

      const { data: current } = await supabase
        .from('leaderboard_ranks')
        .select('rank, arena_score')
        .eq('source', source)
        .eq('source_trader_id', sourceId)
        .maybeSingle()

      if (!current?.rank) continue

      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
      const { data: prev } = await supabase
        .from('trader_snapshots')
        .select('rank')
        .eq('source', source)
        .eq('source_trader_id', sourceId)
        .gte('captured_at', `${yesterday}T00:00:00Z`)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!prev?.rank) continue

      const rankChange = prev.rank - current.rank
      const absChange = Math.abs(rankChange)

      for (const userId of userIds) {
        const userPref = prefs.find(p => p.user_id === userId)
        const threshold = userPref?.ranking_change_threshold ?? 10
        if (absChange < threshold) continue

        const direction = rankChange > 0 ? 'up' : 'down'
        const { data: traderInfo } = await supabase
          .from('trader_sources')
          .select('handle')
          .eq('source', source)
          .eq('source_trader_id', sourceId)
          .maybeSingle()

        const handle = traderInfo?.handle || sourceId
        const title = direction === 'up'
          ? `${handle} rose ${absChange} ranks`
          : `${handle} dropped ${absChange} ranks`
        const body = `Now ranked #${current.rank} (was #${prev.rank})`

        await supabase.from('notifications').insert({
          user_id: userId,
          type: 'ranking_change',
          title,
          body,
          data: { source, source_trader_id: sourceId, handle, old_rank: prev.rank, new_rank: current.rank, change: rankChange },
        })
        notificationsCreated++
      }
    }

    return NextResponse.json({ ok: true, notifications: notificationsCreated })
  } catch (err) {
    logger.error('[Notifications] Ranking changes error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
