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
import { getReadReplica } from '@/lib/supabase/read-replica'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPool } from '@/lib/db'
import { tieredSet } from '@/lib/cache/redis-layer'
import { PLATFORM_CATEGORY } from '@/lib/types/leaderboard'
import type { GranularPlatform } from '@/lib/types/leaderboard'
import { ARENA_CONFIG } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Was 120 — consistently timing out since 2026-05-17 as DB grew

const logger = createLogger('precompute-composite')

// Single source of truth: lib/utils/arena-score.ts
const COMPOSITE_WEIGHTS = ARENA_CONFIG.OVERALL_WEIGHTS
const ROI_ANOMALY_THRESHOLD = 5000
const _CACHE_TTL_SECONDS = 10800 // 3 hours (cron runs every 2h, overlap for safety)
const _FRESHNESS_HOURS = 168 // 7 days — resilient to intermittent fetch failures

// Statement timeout for the heavy per-window queries. Root cause fix: 90s was
// too short for 7D — the largest partition grew past what 90s could scan,
// causing 22+ "canceling statement due to statement timeout" alerts.
// 150s gives headroom. With 3 sequential queries + display name fetch + cache
// write, total max is ~500s — still within 300s maxDuration since actual p95
// for 90D+30D is <10s each, only 7D is slow at ~60-120s.
const WINDOW_QUERY_TIMEOUT_S = 150

interface SnapshotRow {
  platform: string
  trader_key: string
  as_of_ts: string
  arena_score: string | number | null
  roi_pct: string | number | null
  pnl_usd: string | number | null
  max_drawdown: string | number | null
  win_rate: string | number | null
  trades_count: number | null
  followers: number | null
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const releaseLock = await acquireCronLock('precompute-composite', { ttlSeconds: 300 })
  if (!releaseLock) {
    return NextResponse.json({ status: 'skipped', reason: 'already running' })
  }

  const startTime = Date.now()
  // Use read replica for light queries (display names); heavy snapshot queries
  // use the pg pool directly so we can control statement_timeout.
  const supabase = getReadReplica() as SupabaseClient
  const plog = await PipelineLogger.start('precompute-composite')

  // Safety timeout: ensure plog gets closed before Vercel kills the function at maxDuration (300s).
  let plogFinalized = false
  const safetyTimer = setTimeout(async () => {
    if (plogFinalized) return
    plogFinalized = true
    try {
      await plog.error(new Error('Safety timeout: function approaching 300s limit'))
    } catch {
      /* best effort */
    }
  }, 280_000) // 280s safety margin for 300s maxDuration

  try {
    // Include data from the last 7 days — some platforms (Bybit VPS scraper) may
    // have intermittent failures; 72h was too aggressive and dropped platforms entirely
    const freshnessThreshold = new Date(Date.now() - 168 * 3600 * 1000).toISOString()

    /**
     * Fetch top 2000 traders for a window using raw SQL via pg pool.
     * This bypasses PostgREST's 30s statement_timeout — we SET LOCAL to 90s.
     *
     * Key optimizations vs the old PostgREST query:
     * 1. SET LOCAL statement_timeout = '90s' (per-transaction, not per-connection)
     * 2. Explicit as_of_ts range enables partition pruning on the monthly-partitioned table
     * 3. roi_pct anomaly filter applied in-app after index scan (avoids recheck on every row)
     * 4. Uses idx_snapshots_v2_window_arena_score (window, arena_score DESC WHERE NOT NULL)
     */
    const fetchWindow = async (seasonId: string): Promise<SnapshotRow[]> => {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL statement_timeout = '${WINDOW_QUERY_TIMEOUT_S}s'`)

        const result = await client.query<SnapshotRow>(
          `SELECT platform, trader_key, as_of_ts, arena_score,
                  roi_pct, pnl_usd, max_drawdown, win_rate,
                  trades_count, followers
           FROM trader_snapshots_v2
           WHERE "window" = $1
             AND arena_score IS NOT NULL
             AND as_of_ts >= $2
           ORDER BY arena_score DESC NULLS LAST
           LIMIT 2500`,
          [seasonId, freshnessThreshold]
        )

        await client.query('COMMIT')

        // Apply roi_pct anomaly filter in app code — avoids defeating index usage
        // in Postgres (the index covers window + arena_score, not roi_pct).
        // Fetch 2500 from DB to have headroom after filtering.
        const filtered = (result.rows || []).filter((r) => {
          if (r.roi_pct == null) return true
          const roi = typeof r.roi_pct === 'string' ? parseFloat(r.roi_pct) : r.roi_pct
          return roi >= -ROI_ANOMALY_THRESHOLD && roi <= ROI_ANOMALY_THRESHOLD
        })
        return filtered.slice(0, 2000)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw new Error(
          `Fetch ${seasonId} failed: ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        client.release()
      }
    }

    // Fetch sequentially to avoid concurrent connection exhaustion.
    // 7D is now the bottleneck (largest active partition scan).
    const rows7d = await fetchWindow('7D')
    const rows30d = await fetchWindow('30D')
    const rows90d = await fetchWindow('90D')

    // Build maps keyed by platform:trader_key
    const buildMap = (rows: SnapshotRow[]) => {
      const m = new Map<string, SnapshotRow>()
      for (const r of rows) {
        const tid = r.trader_key?.startsWith('0x') ? r.trader_key.toLowerCase() : r.trader_key
        const key = `${r.platform}:${tid}`
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
      platform: string
      trader_key: string
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
        const v2 = r.arena_score != null ? parseFloat(r.arena_score as string) : null
        return v2 != null ? Math.min(v2, 100) : null
      }

      const s7 = getScore(r7)
      const s30 = getScore(r30)
      const s90 = getScore(r90)

      if (s7 == null && s30 == null && s90 == null) continue

      let totalWeight = 0
      let weightedSum = 0
      if (s7 != null) {
        weightedSum += s7 * COMPOSITE_WEIGHTS['7D']
        totalWeight += COMPOSITE_WEIGHTS['7D']
      }
      if (s30 != null) {
        weightedSum += s30 * COMPOSITE_WEIGHTS['30D']
        totalWeight += COMPOSITE_WEIGHTS['30D']
      }
      if (s90 != null) {
        weightedSum += s90 * COMPOSITE_WEIGHTS['90D']
        totalWeight += COMPOSITE_WEIGHTS['90D']
      }

      const compositeScore = totalWeight > 0 ? Math.min(weightedSum / totalWeight, 100) : 0
      const primaryRow = r90 || r30 || r7!
      const [platform, ...rest] = key.split(':')
      const trader_key = rest.join(':')

      entries.push({ key, platform, trader_key, compositeScore, primaryRow })
    }

    // Sort by composite score desc
    entries.sort((a, b) => b.compositeScore - a.compositeScore)

    // Batch fetch display names
    const traderIds = [...new Set(entries.slice(0, 1000).map((e) => e.trader_key))]
    const platforms = [...new Set(entries.slice(0, 1000).map((e) => e.platform))]
    const displayNameMap = new Map<
      string,
      { display_name: string | null; avatar_url: string | null }
    >()

    if (traderIds.length > 0) {
      // Fetch in chunks of 500
      for (let i = 0; i < traderIds.length; i += 500) {
        const chunk = traderIds.slice(i, i + 500)
        const { data: srcData } = await supabase
          .from('trader_sources')
          .select('source, source_trader_id, handle, avatar_url')
          .in('source', platforms)
          .in('source_trader_id', chunk)
        if (srcData) {
          for (const s of srcData) {
            displayNameMap.set(`${s.source}:${s.source_trader_id}`, {
              display_name: s.handle,
              avatar_url: s.avatar_url,
            })
          }
        }
      }
    }

    // Collect available platforms
    const allSources = new Set<string>()
    for (const m of [map7d, map30d, map90d]) {
      for (const r of m.values()) allSources.add(r.platform)
    }

    // Build final traders array (top 1000)
    const traders = entries.slice(0, 1000).map((entry, idx) => {
      const info = displayNameMap.get(entry.key)
      const row = entry.primaryRow
      return {
        platform: entry.platform,
        trader_key: entry.trader_key,
        display_name: info?.display_name || null,
        avatar_url: info?.avatar_url || null,
        rank: idx + 1,
        metrics: {
          roi: row.roi_pct != null ? parseFloat(row.roi_pct as string) : 0,
          pnl: row.pnl_usd != null ? parseFloat(row.pnl_usd as string) : 0,
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
        updated_at: row.as_of_ts,
        profitability_score: null,
        risk_control_score: null,
        execution_score: null,
        score_completeness: null,
        trading_style: null,
        avg_holding_hours: null,
        style_confidence: null,
        category: PLATFORM_CATEGORY[entry.platform as unknown as GranularPlatform] || 'futures',
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
      const catTraders = traders.filter((t) => t.category === cat)
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
    logger.info(
      `Composite precomputed: ${entries.length} total, ${traders.length} cached, ${elapsed}ms`
    )

    clearTimeout(safetyTimer)
    if (!plogFinalized) {
      plogFinalized = true
      await plog.success(traders.length, { total_entries: entries.length, elapsed_ms: elapsed })
    }

    return NextResponse.json({
      ok: true,
      elapsed_ms: elapsed,
      total_entries: entries.length,
      cached_entries: traders.length,
      categories_cached: categories.length,
    })
  } catch (error) {
    clearTimeout(safetyTimer)
    logger.error('Precompute composite failed:', error)
    if (!plogFinalized) {
      plogFinalized = true
      await plog.error(error)
    }
    return NextResponse.json({ error: 'Precompute failed', detail: String(error) }, { status: 500 })
  } finally {
    await releaseLock()
  }
}
