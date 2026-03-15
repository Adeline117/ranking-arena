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
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// DEX sources where 0x addresses may be bots
const DEX_SOURCES = new Set(['hyperliquid', 'gmx', 'dydx', 'vertex', 'drift', 'aevo', 'gains', 'kwenta'])

// Heuristic bot detection for DEX traders
// High trade counts on DEX with 0x addresses are likely automated
function detectTraderType(
  source: string,
  sourceId: string,
  tradesCount: number | null,
  existingType: string | null,
): 'human' | 'bot' | null {
  // Explicit type always wins
  if (existingType === 'human' || existingType === 'bot') return existingType
  // web3_bot source is always bot
  if (source === 'web3_bot') return 'bot'
  // DEX 0x address with very high trade count → likely bot
  if (DEX_SOURCES.has(source) && sourceId.startsWith('0x') && tradesCount != null && tradesCount > 500) {
    return 'bot'
  }
  return null
}

const logger = createLogger('compute-leaderboard')

const SEASONS: Period[] = ['7D', '30D', '90D']
/** Per-platform freshness thresholds: CEX=48h, DEX=72h
 *  Tightened from 168h (7d) now that all fetcher groups run every 3-6h.
 *  If a platform's data is >2-3 days old, it's genuinely stale. */
const DATA_FRESHNESS_HOURS_CEX = 48
const DATA_FRESHNESS_HOURS_DEX = 72

function getFreshnessHours(source: string): number {
  const sourceType = SOURCE_TYPE_MAP[source]
  return sourceType === 'web3' ? DATA_FRESHNESS_HOURS_DEX : DATA_FRESHNESS_HOURS_CEX
}
const MIN_TRADES_COUNT = 1 // Allow all traders with at least 1 trade (DEX traders may have 1-2 high-quality trades)
const DEGRADATION_THRESHOLD = 0.50 // 50% — 70% was too aggressive, normal daily variance = 30-40%

// P1-3: ROI anomaly thresholds per period
const ROI_ANOMALY_THRESHOLDS: Record<Period, number> = {
  '7D': 2000,
  '30D': 5000,
  '90D': 50000,
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
  const plog = await PipelineLogger.start('compute-leaderboard')

  try {
    // P0-2: Record current counts before computing
    const previousCounts: Record<string, number> = {}
    for (const season of SEASONS) {
      const { count } = await supabase
        .from('leaderboard_ranks')
        .select('id', { count: 'exact', head: true })
        .eq('season_id', season)
      previousCounts[season] = count || 0
    }

    for (const season of SEASONS) {
      const count = await computeSeason(supabase, season, previousCounts[season])
      stats.seasons[season] = count

      // Degradation protection: computeSeason returns -1 if it aborted
      if (count === -1) {
        const msg = `${season}: degradation detected, upsert SKIPPED (previous: ${previousCounts[season]})`
        warnings.push(msg)
        rolledBack.push(season)
        stats.seasons[season] = previousCounts[season] // Keep old count in stats
      }
    }

    const elapsed = Date.now() - startTime
    logger.info(`Leaderboard computed in ${elapsed}ms`, stats)

    // Send Telegram alert if degradation detected
    if (warnings.length > 0) {
      try {
        const { sendTelegramAlert } = await import('@/lib/notifications/telegram')
        await sendTelegramAlert({
          level: 'critical',
          source: 'Leaderboard',
          title: '排行榜降级告警',
          message: warnings.join('\n'),
        })
      } catch (e) {
        logger.error('[compute-leaderboard] 告警发送失败:', e)
      }
    }

    // Refresh leaderboard count cache after all seasons computed
    try {
      const { query: dbQuery } = await import('@/lib/db')
      await dbQuery('SELECT refresh_leaderboard_count_cache()', [])
      logger.info('Refreshed leaderboard_count_cache')
    } catch (cacheErr) {
      logger.warn('Failed to refresh leaderboard_count_cache:', cacheErr)
    }

    // Sync arena_score from leaderboard_ranks → trader_snapshots_v2 flat column
    // This ensures the v2 table has scores matching the freshly computed leaderboard
    try {
      const recentCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
      // Fetch recent v2 rows missing scores
      const { data: missingScores } = await supabase
        .from('trader_snapshots_v2')
        .select('id, platform, trader_key, window')
        .is('arena_score', null)
        .gte('created_at', recentCutoff)
        .limit(1000)

      if (missingScores && missingScores.length > 0) {
        // Batch lookup from leaderboard_ranks
        const traderKeys = [...new Set(missingScores.map(r => r.trader_key))]
        const { data: ranks } = await supabase
          .from('leaderboard_ranks')
          .select('source, trader_key, period, arena_score')
          .in('trader_key', traderKeys.slice(0, 500))
          .not('arena_score', 'is', null)

        if (ranks && ranks.length > 0) {
          const scoreMap = new Map(ranks.map(r => [`${r.source}:${r.trader_key}:${r.period}`, r.arena_score]))
          let synced = 0
          for (const row of missingScores) {
            const key = `${row.platform}:${row.trader_key}:${row.window}`
            const score = scoreMap.get(key)
            if (score != null && score > 0) {
              await supabase.from('trader_snapshots_v2').update({ arena_score: score }).eq('id', row.id)
              synced++
            }
          }
          logger.info(`Synced arena_score to v2: ${synced}/${missingScores.length} rows`)
        }
      }
    } catch (syncErr) {
      logger.warn('arena_score sync to v2 failed (non-critical):', syncErr)
    }

    const totalRanked = Object.values(stats.seasons).reduce((a, b) => a + b, 0)
    if (warnings.length > 0) {
      await plog.error(new Error(warnings.join('; ')), { stats, rolledBack })
    } else {
      await plog.success(totalRanked, { stats })
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
    await plog.error(error)
    return NextResponse.json(
      { error: 'Compute failed', detail: String(error) },
      { status: 500 }
    )
  }
}

async function computeSeason(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period,
  previousCount?: number
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
    profitability_score: number | null
    risk_control_score: number | null
    execution_score: number | null
    score_completeness: string | null
    trading_style: string | null
    avg_holding_hours: number | null
    style_confidence: number | null
    sharpe_ratio: number | null
    trader_type: string | null
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
        const maxPages = 10 // Safety cap: max 10K rows per source to prevent runaway queries

        while (page < maxPages) {
          const { data, error } = await supabase
            .from('trader_snapshots')
            .select('source, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, captured_at, full_confidence_at, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, style_confidence, sharpe_ratio, trader_type')
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
        if (page >= maxPages) {
          logger.warn(`${source}/${season}: hit ${maxPages}-page cap (${rows.length} rows), some data may be truncated`)
        }
        return rows
      })
    )
    results.forEach(rows => allSnapshots.push(...rows))
  }

  // Also fetch from trader_snapshots_v2 (some connectors write v2 only)
  // Column mapping: platform→source, trader_key→source_trader_id, window→season_id,
  //                  roi_pct→roi, pnl_usd→pnl, created_at→captured_at
  const v2Window = season // V2 uses same format as v1: '7D', '30D', '90D'
  for (let i = 0; i < ALL_SOURCES.length; i += batchSize) {
    const batch = ALL_SOURCES.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async (source) => {
        const rows: TraderRow[] = []
        const freshnessISO = freshnessISOBySource(source)
        const { data, error } = await supabase
          .from('trader_snapshots_v2')
          .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, arena_score, created_at, sharpe_ratio')
          .eq('platform', source)
          .eq('window', v2Window)
          .gte('created_at', freshnessISO)
          .order('created_at', { ascending: false })
          .limit(5000)

        if (error || !data?.length) return rows

        for (const d of data) {
          rows.push({
            source: d.platform as string,
            source_trader_id: d.trader_key as string,
            roi: d.roi_pct as number,
            pnl: d.pnl_usd as number,
            win_rate: d.win_rate as number | null,
            max_drawdown: d.max_drawdown as number | null,
            trades_count: d.trades_count as number | null,
            followers: d.followers as number | null,
            arena_score: d.arena_score as number | null,
            captured_at: d.created_at as string,
            full_confidence_at: null,
            profitability_score: null,
            risk_control_score: null,
            execution_score: null,
            score_completeness: null,
            trading_style: null,
            avg_holding_hours: null,
            style_confidence: null,
            sharpe_ratio: d.sharpe_ratio as number | null,
            trader_type: null,
          })
        }
        return rows
      })
    )
    results.forEach(rows => allSnapshots.push(...rows))
  }
  logger.info(`[${season}] Fetched ${allSnapshots.length} total snapshots (v1 + v2)`)

  // Dedupe: keep latest per source+source_trader_id
  // Normalize 0x addresses to lowercase to prevent case-sensitive duplicates
  const traderMap = new Map<string, TraderRow>()
  for (const snap of allSnapshots) {
    if (snap.source_trader_id.startsWith('0x')) {
      snap.source_trader_id = snap.source_trader_id.toLowerCase()
    }
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
    .filter(t => t.roi != null) // Must have ROI data — null ROI traders shouldn't be ranked
    .filter(t => Math.abs(t.roi!) <= roiThreshold)
    .filter(t => t.roi! > -90) // 过滤已爆仓交易员（ROI < -90%），无参考价值
    .filter(t => t.trades_count == null || t.trades_count >= MIN_TRADES_COUNT)

  if (!uniqueTraders.length) return 0

  // Batch fetch handles and avatars from trader_sources + trader_profiles_v2 fallback
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
          // Normalize 0x addresses to lowercase to match dedup key
          const tid = s.source_trader_id.startsWith('0x') ? s.source_trader_id.toLowerCase() : s.source_trader_id
          handleMap.set(`${source}:${tid}`, {
            handle: s.handle,
            avatar_url: s.avatar_url || null,
          })
        })
      }
    })
  )

  // Fallback: fill missing avatars from trader_profiles_v2
  const missingAvatarKeys = Array.from(handleMap.entries())
    .filter(([, v]) => !v.avatar_url)
    .map(([k]) => k)

  if (missingAvatarKeys.length > 0) {
    const missingBySource = new Map<string, string[]>()
    for (const key of missingAvatarKeys) {
      const [source, ...rest] = key.split(':')
      const traderId = rest.join(':')
      const ids = missingBySource.get(source) || []
      ids.push(traderId)
      missingBySource.set(source, ids)
    }

    await Promise.all(
      Array.from(missingBySource.entries()).map(async ([source, traderIds]) => {
        for (let i = 0; i < traderIds.length; i += 500) {
          const chunk = traderIds.slice(i, i + 500)
          const { data } = await supabase
            .from('trader_profiles_v2')
            .select('trader_key, avatar_url')
            .eq('platform', source)
            .in('trader_key', chunk)
            .not('avatar_url', 'is', null)

          data?.forEach((p: { trader_key: string; avatar_url: string | null }) => {
            if (p.avatar_url) {
              const existing = handleMap.get(`${source}:${p.trader_key}`)
              if (existing) {
                existing.avatar_url = p.avatar_url
              }
            }
          })
        }
      })
    )
  }

  // Calculate arena_score and rank
  const scored = uniqueTraders.map(t => {
    // Win rate should already be percentage (0-100) from fetcher normalization.
    // Only clamp to valid range; don't re-normalize decimal→percentage.
    let normalizedWinRate: number | null = null
    if (t.win_rate != null && !isNaN(t.win_rate)) {
      // Safety: if somehow still decimal (0-1 range), convert
      const wr = t.win_rate > 0 && t.win_rate <= 1 ? t.win_rate * 100 : t.win_rate
      normalizedWinRate = Math.max(0, Math.min(100, wr))
    }

    const scoreResult = calculateArenaScore(
      {
        roi: t.roi!, // guaranteed non-null by filter above
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
    // Only use handle if it's a real nickname, not a numeric UID
    const rawHandle = info.handle?.trim() || null
    const isNumericUid = rawHandle && /^\d{7,}$/.test(rawHandle)
    // Apply profanity filter before storing in database
    const displayHandle = (rawHandle && !isNumericUid) ? sanitizeDisplayName(rawHandle) : null

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
      profitability_score: t.profitability_score,
      risk_control_score: t.risk_control_score,
      execution_score: t.execution_score,
      score_completeness: t.score_completeness,
      trading_style: t.trading_style,
      avg_holding_hours: t.avg_holding_hours,
      style_confidence: t.style_confidence,
      sharpe_ratio: t.sharpe_ratio,
      trader_type: detectTraderType(t.source, t.source_trader_id, t.trades_count, t.trader_type),
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

  // Pre-upsert degradation check: abort if count drops >50% from previous
  // Exception: if previousCount is inflated from historical accumulation (>10K stale rows),
  // use a minimum floor of 1000 to allow pipeline recovery after prolonged fetcher failures
  const effectivePrevious = previousCount && previousCount > 10000 ? Math.max(previousCount * (1 - DEGRADATION_THRESHOLD), 1000) : (previousCount ?? 0) * (1 - DEGRADATION_THRESHOLD)
  if (previousCount && previousCount > 0 && scored.length < effectivePrevious) {
    logger.error(`${season}: computed ${scored.length} vs previous ${previousCount} (threshold ${Math.round(effectivePrevious)}). SKIPPING upsert to preserve data.`)
    return -1 // Signal degradation — caller handles alerting
  }

  // Upsert into leaderboard_ranks in batches
  let upsertErrors = 0
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
      profitability_score: t.profitability_score,
      risk_control_score: t.risk_control_score,
      execution_score: t.execution_score,
      score_completeness: t.score_completeness,
      trading_style: t.trading_style,
      avg_holding_hours: t.avg_holding_hours,
      style_confidence: t.style_confidence,
      sharpe_ratio: t.sharpe_ratio,
      trader_type: t.trader_type || (t.source === 'web3_bot' ? 'bot' : null),
    }))

    const { error } = await supabase
      .from('leaderboard_ranks')
      .upsert(batch, { onConflict: 'season_id,source,source_trader_id' })

    if (error) {
      logger.error(`Upsert error for ${season} batch ${i}:`, error)
      upsertErrors += batch.length
    }
  }

  // Clean up rows not updated in 14 days (truly abandoned data)
  // Previously used 2-minute cutoff which aggressively deleted data from
  // platforms with broken fetchers, causing 70%+ count drops.
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const { data: staleRows, error: staleErr } = await supabase
    .from('leaderboard_ranks')
    .select('id')
    .eq('season_id', season)
    .lt('computed_at', cutoff)
    .limit(5000)
  if (!staleErr && staleRows && staleRows.length > 0) {
    const staleIds = staleRows.map((r: { id: string }) => r.id)
    for (let i = 0; i < staleIds.length; i += 500) {
      await supabase.from('leaderboard_ranks').delete().in('id', staleIds.slice(i, i + 500))
    }
    logger.info(`${season}: cleaned ${staleIds.length} stale rows (>14d old)`)
  }

  const actualUpserted = scored.length - upsertErrors
  logger.info(`${season}: ranked ${scored.length} traders (${upsertErrors} upsert errors)`)
  return actualUpserted
}
