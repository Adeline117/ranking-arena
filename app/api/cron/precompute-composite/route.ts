/**
 * Cron: Precompute composite rankings and store in Redis
 * Schedule: Every 2 hours (see vercel.json cron config)
 *
 * Composite = weighted average of 7D/30D/90D arena_score:
 *   7D*0.05 + 30D*0.25 + 90D*0.70
 * Unified with OVERALL_WEIGHTS in lib/utils/arena-score.ts (2026-03-13)
 *
 * Result stored in Redis with 3h TTL so /api/rankings?window=composite
 * can serve from cache in ~5ms instead of ~500ms real-time compute.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { tieredSet } from '@/lib/cache/redis-layer'
import { PLATFORM_CATEGORY } from '@/lib/types/leaderboard'
import type { GranularPlatform } from '@/lib/types/leaderboard'
import { createLogger } from '@/lib/utils/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const logger = createLogger('precompute-composite')

// Unified with OVERALL_WEIGHTS in lib/utils/arena-score.ts — 90D-heavy
const COMPOSITE_WEIGHTS = { '7D': 0.05, '30D': 0.25, '90D': 0.70 } as const
const ROI_ANOMALY_THRESHOLD = 5000
const _CACHE_TTL_SECONDS = 10800 // 3 hours (cron runs every 2h, overlap for safety)
const FRESHNESS_HOURS = 168 // 7 days — resilient to intermittent fetch failures

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const supabase = getSupabaseAdmin()
  const plog = await PipelineLogger.start('precompute-composite')

  try {
    // Fetch all three windows in parallel (top 2000 per window)
    // Include data from the last 7 days — some platforms (Bybit VPS scraper) may
    // have intermittent failures; 72h was too aggressive and dropped platforms entirely
    const freshnessThreshold = new Date(Date.now() - 168 * 3600 * 1000).toISOString()

    const fetchWindow = async (seasonId: string) => {
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('source, source_trader_id, captured_at, arena_score, arena_score_v3, roi, pnl, max_drawdown, win_rate, trades_count, followers, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, style_confidence')
        .eq('season_id', seasonId)
        .not('arena_score', 'is', null)
        .gte('captured_at', freshnessThreshold)
        .lte('roi', ROI_ANOMALY_THRESHOLD)
        .gte('roi', -ROI_ANOMALY_THRESHOLD)
        .or('roi.neq.0,pnl.neq.0')
        .order('arena_score', { ascending: false, nullsFirst: false })
        .limit(2000)

      if (error) throw new Error(`Fetch ${seasonId} failed: ${error.message}`)
      return data || []
    }

    const [rows7d, rows30d, rows90d] = await Promise.all([
      fetchWindow('7D'),
      fetchWindow('30D'),
      fetchWindow('90D'),
    ])

    // Build maps keyed by source:source_trader_id
    type SnapshotRow = typeof rows7d[number]
    const buildMap = (rows: SnapshotRow[]) => {
      const m = new Map<string, SnapshotRow>()
      for (const r of rows) {
        const tid = r.source_trader_id?.startsWith('0x') ? r.source_trader_id.toLowerCase() : r.source_trader_id
        const key = `${r.source}:${tid}`
        if (!m.has(key)) m.set(key, r)
      }
      return m
    }

    const map7d = buildMap(rows7d)
    const map30d = buildMap(rows30d)
    const map90d = buildMap(rows90d)

    // Union all trader keys
    const allKeys = new Set<string>()
    for (const m of [map7d, map30d, map90d]) {
      for (const k of m.keys()) allKeys.add(k)
    }

    // Compute weighted scores
    interface CompositeEntry {
      key: string
      source: string
      source_trader_id: string
      compositeScore: number
      primaryRow: SnapshotRow
    }

    const entries: CompositeEntry[] = []
    for (const key of allKeys) {
      const r7 = map7d.get(key)
      const r30 = map30d.get(key)
      const r90 = map90d.get(key)

      const getScore = (r: SnapshotRow | undefined) => {
        if (!r) return null
        const v3 = r.arena_score_v3 != null ? parseFloat(r.arena_score_v3 as string) : null
        if (v3 != null) return Math.min(v3, 100)
        const v2 = r.arena_score != null ? parseFloat(r.arena_score as string) : null
        return v2 != null ? Math.min(v2, 100) : null
      }

      const s7 = getScore(r7)
      const s30 = getScore(r30)
      const s90 = getScore(r90)

      if (s7 == null && s30 == null && s90 == null) continue

      let totalWeight = 0
      let weightedSum = 0
      if (s7 != null) { weightedSum += s7 * COMPOSITE_WEIGHTS['7D']; totalWeight += COMPOSITE_WEIGHTS['7D'] }
      if (s30 != null) { weightedSum += s30 * COMPOSITE_WEIGHTS['30D']; totalWeight += COMPOSITE_WEIGHTS['30D'] }
      if (s90 != null) { weightedSum += s90 * COMPOSITE_WEIGHTS['90D']; totalWeight += COMPOSITE_WEIGHTS['90D'] }

      const compositeScore = totalWeight > 0 ? Math.min(weightedSum / totalWeight, 100) : 0
      const primaryRow = r90 || r30 || r7!
      const [source, ...rest] = key.split(':')
      const source_trader_id = rest.join(':')

      entries.push({ key, source, source_trader_id, compositeScore, primaryRow })
    }

    // Sort by composite score desc
    entries.sort((a, b) => b.compositeScore - a.compositeScore)

    // Batch fetch display names
    const traderIds = [...new Set(entries.slice(0, 1000).map(e => e.source_trader_id))]
    const sources = [...new Set(entries.slice(0, 1000).map(e => e.source))]
    const displayNameMap = new Map<string, { display_name: string | null; avatar_url: string | null }>()

    if (traderIds.length > 0) {
      // Fetch in chunks of 500
      for (let i = 0; i < traderIds.length; i += 500) {
        const chunk = traderIds.slice(i, i + 500)
        const { data: srcData } = await supabase
          .from('trader_sources')
          .select('source, source_trader_id, handle, avatar_url')
          .in('source', sources)
          .in('source_trader_id', chunk)
        if (srcData) {
          for (const s of srcData) {
            displayNameMap.set(`${s.source}:${s.source_trader_id}`, { display_name: s.handle, avatar_url: s.avatar_url })
          }
        }
      }
    }

    // Collect available sources
    const allSources = new Set<string>()
    for (const m of [map7d, map30d, map90d]) {
      for (const r of m.values()) allSources.add(r.source)
    }

    // Build final traders array (top 1000)
    const traders = entries.slice(0, 1000).map((entry, idx) => {
      const info = displayNameMap.get(entry.key)
      const row = entry.primaryRow
      return {
        platform: entry.source,
        trader_key: entry.source_trader_id,
        display_name: info?.display_name || null,
        avatar_url: info?.avatar_url || null,
        rank: idx + 1,
        metrics: {
          roi: row.roi != null ? parseFloat(row.roi as string) : 0,
          pnl: row.pnl != null ? parseFloat(row.pnl as string) : 0,
          win_rate: row.win_rate != null ? parseFloat(row.win_rate as string) : null,
          max_drawdown: row.max_drawdown != null ? parseFloat(row.max_drawdown as string) : null,
          trades_count: row.trades_count ?? null,
          followers: row.followers ?? null,
          copiers: null,
          aum: null,
          arena_score: Math.round(entry.compositeScore * 10) / 10,
          return_score: null,
          drawdown_score: null,
          stability_score: null,
          sharpe_ratio: null,
          sortino_ratio: null,
          platform_rank: idx + 1,
        },
        quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 1.0 },
        updated_at: row.captured_at,
        profitability_score: row.profitability_score != null ? parseFloat(row.profitability_score as string) : null,
        risk_control_score: row.risk_control_score != null ? parseFloat(row.risk_control_score as string) : null,
        execution_score: row.execution_score != null ? parseFloat(row.execution_score as string) : null,
        score_completeness: row.score_completeness || null,
        trading_style: row.trading_style || null,
        avg_holding_hours: row.avg_holding_hours != null ? parseFloat(row.avg_holding_hours as string) : null,
        style_confidence: row.style_confidence != null ? parseFloat(row.style_confidence as string) : null,
        category: PLATFORM_CATEGORY[entry.source as unknown as GranularPlatform] || 'futures',
      }
    })

    // Store full precomputed result in Redis
    const compositeData = {
      traders,
      window: 'COMPOSITE' as const,
      totalcount: entries.length,
      total_count: entries.length,
      as_of: new Date().toISOString(),
      is_stale: false, // freshly precomputed — will become stale when TTL expires
      availableSources: [...allSources].sort(),
      precomputed: true,
    }

    // Store the full composite result
    await tieredSet('precomputed:composite:all', compositeData, 'hot', ['rankings', 'composite'])

    // Also store per-category composites for faster filtered queries
    const categories = ['futures', 'spot', 'onchain'] as const
    for (const cat of categories) {
      const catTraders = traders.filter(t => t.category === cat)
      if (catTraders.length > 0) {
        const catData = {
          ...compositeData,
          traders: catTraders.map((t, idx) => ({ ...t, rank: idx + 1 })),
          totalcount: catTraders.length,
          total_count: catTraders.length,
        }
        await tieredSet(`precomputed:composite:${cat}`, catData, 'hot', ['rankings', 'composite'])
      }
    }

    const elapsed = Date.now() - startTime
    logger.info(`Composite precomputed: ${entries.length} total, ${traders.length} cached, ${elapsed}ms`)

    await plog.success(traders.length, { total_entries: entries.length })

    return NextResponse.json({
      ok: true,
      elapsed_ms: elapsed,
      total_entries: entries.length,
      cached_entries: traders.length,
      categories_cached: categories.length,
    })
  } catch (error) {
    logger.error('Precompute composite failed:', error)
    await plog.error(error)
    return NextResponse.json(
      { error: 'Precompute failed', detail: String(error) },
      { status: 500 }
    )
  }
}
