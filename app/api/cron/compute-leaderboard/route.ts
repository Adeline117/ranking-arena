/**
 * Cron: Compute leaderboard_ranks from trader_snapshots
 * Schedule: Every hour (0 * * * *)
 *
 * For each season (7D, 30D, 90D):
 * 1. Fetch latest trader_snapshots per source+source_trader_id
 * 2. Calculate arena_score
 * 3. Join trader_sources for handle/avatar
 * 4. Rank and upsert into leaderboard_ranks
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import {
  calculateArenaScore,
  debouncedConfidence,
  ARENA_CONFIG,
  type Period,
} from '@/lib/utils/arena-score'
import {
  ALL_SOURCES,
  SOURCE_TYPE_MAP,
} from '@/lib/constants/exchanges'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const logger = createLogger('compute-leaderboard')

const SEASONS: Period[] = ['7D', '30D', '90D']
const DATA_FRESHNESS_HOURS = 24
const ROI_ANOMALY_THRESHOLD = 10000

export async function GET(request: NextRequest) {
  // Verify cron secret in production
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const startTime = Date.now()
  const stats = { seasons: {} as Record<string, number> }

  try {
    for (const season of SEASONS) {
      const count = await computeSeason(supabase, season)
      stats.seasons[season] = count
    }

    const elapsed = Date.now() - startTime
    logger.info(`Leaderboard computed in ${elapsed}ms`, stats)

    return NextResponse.json({
      ok: true,
      elapsed_ms: elapsed,
      stats,
    })
  } catch (error: unknown) {
    logger.error('Failed to compute leaderboard', error)
    return NextResponse.json(
      { error: 'Compute failed', detail: String(error) },
      { status: 500 }
    )
  }
}

async function computeSeason(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period
): Promise<number> {
  const freshnessThreshold = new Date()
  freshnessThreshold.setHours(freshnessThreshold.getHours() - DATA_FRESHNESS_HOURS)
  const freshnessISO = freshnessThreshold.toISOString()

  // Collect all traders across all sources
  interface TraderRow {
    source: string
    source_trader_id: string
    roi: number
    pnl: number
    win_rate: number | null
    max_drawdown: number | null
    trades_count: number | null
    followers: number | null
    arena_score: number | null
    captured_at: string
    full_confidence_at: string | null
  }

  const allSnapshots: TraderRow[] = []

  // Fetch snapshots for all sources in parallel (batched)
  const batchSize = 10
  for (let i = 0; i < ALL_SOURCES.length; i += batchSize) {
    const batch = ALL_SOURCES.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async (source) => {
        const rows: TraderRow[] = []
        let page = 0
        const pageSize = 1000

        while (true) {
          const { data, error } = await supabase
            .from('trader_snapshots')
            .select('source, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, captured_at, full_confidence_at')
            .eq('source', source)
            .eq('season_id', season)
            .gte('captured_at', freshnessISO)
            .order('captured_at', { ascending: false })
            .range(page * pageSize, (page + 1) * pageSize - 1)

          if (error || !data?.length) break
          rows.push(...(data as TraderRow[]))
          if (data.length < pageSize) break
          page++
        }
        return rows
      })
    )
    results.forEach(rows => allSnapshots.push(...rows))
  }

  // Dedupe: keep latest per source+source_trader_id
  const traderMap = new Map<string, TraderRow>()
  for (const snap of allSnapshots) {
    const key = `${snap.source}:${snap.source_trader_id}`
    if (!traderMap.has(key)) {
      traderMap.set(key, snap)
    } else {
      // Merge full_confidence_at (keep newest)
      const existing = traderMap.get(key)!
      if (snap.full_confidence_at &&
          (!existing.full_confidence_at || snap.full_confidence_at > existing.full_confidence_at)) {
        existing.full_confidence_at = snap.full_confidence_at
      }
    }
  }

  const uniqueTraders = Array.from(traderMap.values())
    .filter(t => Math.abs(t.roi ?? 0) <= ROI_ANOMALY_THRESHOLD)

  if (!uniqueTraders.length) return 0

  // Batch fetch handles and avatars from trader_sources
  const handleMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
  
  // Group by source for efficient queries
  const bySource = new Map<string, string[]>()
  for (const t of uniqueTraders) {
    const ids = bySource.get(t.source) || []
    ids.push(t.source_trader_id)
    bySource.set(t.source, ids)
  }

  await Promise.all(
    Array.from(bySource.entries()).map(async ([source, traderIds]) => {
      // Query in chunks of 500 (Supabase IN limit)
      for (let i = 0; i < traderIds.length; i += 500) {
        const chunk = traderIds.slice(i, i + 500)
        const { data } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, avatar_url')
          .eq('source', source)
          .in('source_trader_id', chunk)

        data?.forEach((s: { source_trader_id: string; handle: string | null; avatar_url: string | null }) => {
          handleMap.set(`${source}:${s.source_trader_id}`, {
            handle: s.handle,
            avatar_url: s.avatar_url || null,
          })
        })
      }
    })
  )

  // Calculate arena_score and rank
  const scored = uniqueTraders.map(t => {
    // Normalize win_rate
    let normalizedWinRate: number | null = null
    if (t.win_rate != null && !isNaN(t.win_rate)) {
      const wr = t.win_rate <= 1 ? t.win_rate * 100 : t.win_rate
      normalizedWinRate = Math.max(0, Math.min(100, wr))
    }

    const scoreResult = calculateArenaScore(
      {
        roi: t.roi ?? 0,
        pnl: t.pnl ?? 0,
        maxDrawdown: t.max_drawdown,
        winRate: normalizedWinRate,
      },
      season
    )

    const effectiveConfidence = debouncedConfidence(
      scoreResult.scoreConfidence,
      t.full_confidence_at,
    )
    const confidenceMultiplier = ARENA_CONFIG.CONFIDENCE_MULTIPLIER[effectiveConfidence]
    const rawSubScores = scoreResult.returnScore + scoreResult.pnlScore +
                         scoreResult.drawdownScore + scoreResult.stabilityScore
    const finalScore = Math.round(
      Math.max(0, Math.min(100, rawSubScores * confidenceMultiplier)) * 100
    ) / 100

    const info = handleMap.get(`${t.source}:${t.source_trader_id}`) || { handle: null, avatar_url: null }
    const displayHandle = (info.handle && info.handle.trim()) || t.source_trader_id

    return {
      source: t.source,
      source_trader_id: t.source_trader_id,
      arena_score: finalScore,
      roi: t.roi ?? 0,
      pnl: t.pnl ?? 0,
      win_rate: normalizedWinRate,
      max_drawdown: t.max_drawdown,
      followers: t.followers ?? 0,
      trades_count: t.trades_count,
      handle: displayHandle,
      avatar_url: info.avatar_url,
    }
  })

  // Sort by arena_score desc, then by drawdown, then by id
  scored.sort((a, b) => {
    const diff = b.arena_score - a.arena_score
    if (Math.abs(diff) > 0.01) return diff
    const mddA = Math.abs(a.max_drawdown ?? 100)
    const mddB = Math.abs(b.max_drawdown ?? 100)
    if (mddA !== mddB) return mddA - mddB
    return a.source_trader_id.localeCompare(b.source_trader_id)
  })

  // Upsert into leaderboard_ranks in batches
  const batchUpsertSize = 500
  for (let i = 0; i < scored.length; i += batchUpsertSize) {
    const batch = scored.slice(i, i + batchUpsertSize).map((t, idx) => ({
      season_id: season,
      source: t.source,
      source_type: SOURCE_TYPE_MAP[t.source] || 'futures',
      source_trader_id: t.source_trader_id,
      rank: i + idx + 1,
      arena_score: t.arena_score,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.win_rate,
      max_drawdown: t.max_drawdown,
      followers: t.followers,
      trades_count: t.trades_count,
      handle: t.handle,
      avatar_url: t.avatar_url,
      computed_at: new Date().toISOString(),
    }))

    const { error } = await supabase
      .from('leaderboard_ranks')
      .upsert(batch, { onConflict: 'season_id,source,source_trader_id' })

    if (error) {
      logger.error(`Upsert error for ${season} batch ${i}:`, error)
    }
  }

  logger.info(`${season}: ranked ${scored.length} traders`)
  return scored.length
}
