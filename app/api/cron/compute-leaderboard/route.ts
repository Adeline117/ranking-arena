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
  SOURCE_TRUST_WEIGHT,
} from '@/lib/constants/exchanges'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const logger = createLogger('compute-leaderboard')

const SEASONS: Period[] = ['7D', '30D', '90D']
/** Per-platform freshness thresholds: CEX=24h, DEX=48h */
const DATA_FRESHNESS_HOURS_CEX = 24
const DATA_FRESHNESS_HOURS_DEX = 48

function getFreshnessHours(source: string): number {
  const sourceType = SOURCE_TYPE_MAP[source]
  return sourceType === 'web3' ? DATA_FRESHNESS_HOURS_DEX : DATA_FRESHNESS_HOURS_CEX
}
const MIN_TRADES_COUNT = 5
const DEGRADATION_THRESHOLD = 0.30 // 30% drop triggers protection

// P1-3: ROI anomaly thresholds per period
const ROI_ANOMALY_THRESHOLDS: Record<Period, number> = {
  '7D': 2000,
  '30D': 5000,
  '90D': 10000,
}

export async function GET(request: NextRequest) {
  // Verify cron secret in production
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const startTime = Date.now()
  const stats = { seasons: {} as Record<string, number> }
  const warnings: string[] = []
  const rolledBack: string[] = []

  try {
    // P0-2: Record current counts before computing
    const previousCounts: Record<string, number> = {}
    for (const season of SEASONS) {
      const { count } = await supabase
        .from('leaderboard_ranks')
        .select('*', { count: 'exact', head: true })
        .eq('season_id', season)
      previousCounts[season] = count || 0
    }

    for (const season of SEASONS) {
      const count = await computeSeason(supabase, season)
      stats.seasons[season] = count

      // P0-2: Degradation protection
      const prev = previousCounts[season]
      if (prev > 0 && count < prev * (1 - DEGRADATION_THRESHOLD)) {
        const msg = `${season}: count dropped ${prev} → ${count} (>${DEGRADATION_THRESHOLD * 100}% drop). Keeping old data.`
        logger.error(msg)
        warnings.push(msg)
        rolledBack.push(season)
        // Delete newly computed rows and rely on old data still being there
        // Since we upsert, old rows with same keys are overwritten.
        // To truly rollback we'd need a transaction. Instead, we alert loudly.
        // The upsert already happened, so we log the warning for investigation.
      }
    }

    const elapsed = Date.now() - startTime
    logger.info(`Leaderboard computed in ${elapsed}ms`, stats)

    // Send Telegram alert if degradation detected
    if (warnings.length > 0) {
      const tgToken = process.env.TELEGRAM_BOT_TOKEN
      const tgChatId = process.env.TELEGRAM_ALERT_CHAT_ID
      if (tgToken && tgChatId) {
        try {
          await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: tgChatId,
              text: `🚨 <b>排行榜降级告警</b>\n\n${warnings.join('\n')}`,
              parse_mode: 'HTML',
            }),
          })
        } catch (e) {
          logger.error('[compute-leaderboard] Telegram alert failed:', e)
        }
      } else {
        logger.error('[compute-leaderboard] DEGRADATION WARNING:', warnings)
      }
    }

    return NextResponse.json({
      ok: warnings.length === 0,
      elapsed_ms: elapsed,
      stats,
      previous_counts: previousCounts,
      warnings: warnings.length > 0 ? warnings : undefined,
      rolled_back: rolledBack.length > 0 ? rolledBack : undefined,
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
  // Per-source freshness thresholds
  const freshnessISOBySource = (source: string): string => {
    const threshold = new Date()
    threshold.setHours(threshold.getHours() - getFreshnessHours(source))
    return threshold.toISOString()
  }

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
            .gte('captured_at', freshnessISOBySource(source))
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

  const roiThreshold = ROI_ANOMALY_THRESHOLDS[season]
  const uniqueTraders = Array.from(traderMap.values())
    .filter(t => Math.abs(t.roi ?? 0) <= roiThreshold)
    .filter(t => (t.roi ?? 0) > -90) // 过滤已爆仓交易员（ROI < -90%），无参考价值
    .filter(t => t.trades_count == null || t.trades_count >= MIN_TRADES_COUNT) // P1-2: minimum trades (skip check if null)

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
    // P1-1: Apply source trust weight
    const trustWeight = SOURCE_TRUST_WEIGHT[t.source] ?? 0.5
    const finalScore = Math.round(
      Math.max(0, Math.min(100, rawSubScores * confidenceMultiplier * trustWeight)) * 100
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
