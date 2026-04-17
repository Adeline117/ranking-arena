/**
 * compute-leaderboard / fetch-phase1
 *
 * Phase 1: pull every fresh trader for the target season out of
 * `trader_snapshots_v2`, one platform at a time, and stream rows into the
 * provided `addToTraderMap` callback. The biggest single block of computeSeason.
 *
 * Sequential per-platform queries (batchSize = 1) — concurrent batches even
 * at 3 still exhausted the DB pool under cron storms (root cause fix
 * 2026-04-09). Per-source 30s timeout via Promise.race so a slow platform
 * doesn't block the run. 30D fallback for windows that came back near-empty
 * (many platforms only fetch one window). One retry on transient
 * statement_timeout. JSONB metrics fallback for platforms that write columns
 * sparsely.
 *
 * Extracted from route.ts as part of the computeSeason main-loop split
 * (TASKS.md "Open follow-ups").
 */

import { getSupabaseAdmin } from '@/lib/api'
import { SOURCES_WITH_DATA } from '@/lib/constants/exchanges'
import type { Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import { getFreshnessHours } from './helpers'
import type { TraderRow } from './trader-row'

const logger = createLogger('compute-leaderboard')

const PHASE1_TIME_BUDGET_MS = 150_000 // leave 150s for scoring + upsert + enrichment
const PER_SOURCE_TIMEOUT_MS = 30_000
const FALLBACK_THRESHOLD = 50 // if window has fewer rows, try the 30D bucket

/**
 * Per-source freshness threshold ISO. CEX defaults to 6h, web3 sources to
 * 12h — see helpers.getFreshnessHours.
 */
function freshnessISOForSource(source: string): string {
  const threshold = new Date()
  threshold.setHours(threshold.getHours() - getFreshnessHours(source))
  return threshold.toISOString()
}

/**
 * Run Phase 1 for the given season. Mutates traderMap via addToTraderMap.
 * Returns the per-source row counts so the caller can log diagnostic info
 * (currently used for the jupiter_perps debug line in route.ts).
 */
export async function fetchPhase1FromV2(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period,
  addToTraderMap: (row: TraderRow) => void,
): Promise<Map<string, number>> {
  const v2CountBySource = new Map<string, number>()
  const v2Window = season
  const phase1Start = Date.now()
  const batchSize = 1 // Sequential: 1 query at a time to avoid DB pool exhaustion

  for (let i = 0; i < SOURCES_WITH_DATA.length; i += batchSize) {
    if (Date.now() - phase1Start > PHASE1_TIME_BUDGET_MS) {
      logger.warn(`[${season}] Phase 1 time budget exceeded at platform ${i}/${SOURCES_WITH_DATA.length}`)
      break
    }

    const batch = SOURCES_WITH_DATA.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async (source) => {
        const rows: TraderRow[] = []
        const freshnessISO = freshnessISOForSource(source)
        // Per-source 30s timeout: skip slow sources instead of blocking the entire run
        const queryWithTimeout = async <T>(promise: PromiseLike<T>): Promise<T> => {
          return Promise.race([
            promise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${source} query timeout`)), PER_SOURCE_TIMEOUT_MS)),
          ])
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase .select() returns untyped rows; fields are accessed dynamically via col() helper below
        let data: any[] | null = null
        let error: { message: string; code?: string } | null = null
        try {
          // PERF FIX: add as_of_ts filter for partition pruning. Without it,
          // Postgres scans ALL monthly partitions (22.9s avg). With it, only
          // the current month's partition is scanned (~2-4s).
          const partitionPruneDate = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString()
          const result = await queryWithTimeout(supabase
            .from('trader_snapshots_v2')
            .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, updated_at, sharpe_ratio, sortino_ratio, calmar_ratio, volatility_pct, downside_volatility_pct, metrics')
            .eq('platform', source)
            .eq('window', v2Window)
            .gte('updated_at', freshnessISO)
            .gte('as_of_ts', partitionPruneDate)
            .order('updated_at', { ascending: false })
            .limit(1000))
          data = result.data as TraderRow[] | null
          error = result.error
        } catch {
          logger.warn(`[${season}] ${source}: Phase 1 query timeout, skipping`)
          return []
        }

        // Fallback: if this window has too few traders, use 30D data
        // (many platforms only fetch one window; 30D is the most common)
        if ((!data || data.length < FALLBACK_THRESHOLD) && v2Window !== '30D') {
          try {
            const fallback = await queryWithTimeout(supabase
              .from('trader_snapshots_v2')
              .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, updated_at, sharpe_ratio, sortino_ratio, calmar_ratio, volatility_pct, downside_volatility_pct, metrics')
              .eq('platform', source)
              .eq('window', '30D')
              .gte('updated_at', freshnessISO)
              .order('updated_at', { ascending: false })
              .limit(1000))
            if (!fallback.error && fallback.data && fallback.data.length > (data?.length || 0)) {
              data = fallback.data
              error = fallback.error as typeof error
            }
          } catch {
            // Fallback also timed out — use primary result
          }
        }

        if (error) {
          // Retry once after 2s with smaller limit to recover from transient statement_timeout.
          logger.error(`[${season}] Query failed for ${source}: ${error.message} (code=${error.code}) — retrying with limit=1000`, { source, window: v2Window })
          await new Promise(r => setTimeout(r, 2000))
          const retry = await supabase
            .from('trader_snapshots_v2')
            .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, updated_at, sharpe_ratio, sortino_ratio, calmar_ratio, volatility_pct, downside_volatility_pct, metrics')
            .eq('platform', source)
            .eq('window', v2Window)
            .gte('updated_at', freshnessISO)
            .order('updated_at', { ascending: false })
            .limit(1000)
          if (retry.error) {
            logger.error(`[${season}] Retry also failed for ${source}: ${retry.error.message} — data NOT loaded (will cause false "stale" downstream)`)
            return rows
          }
          data = retry.data
        }
        if (!data?.length) return rows

        let totalJsonbFallbacks = 0
        for (const d of data) {
          // Supabase returns `numeric` columns as strings for high-precision values.
          // Must use Number() to convert, not `as number` (which is just a TS type assertion).
          // Fallback to metrics JSONB when columns are NULL (some platforms write only to JSONB).
          const m = (d.metrics as Record<string, unknown>) || {}
          let jsonbFallbackCount = 0
          const col = (key: string, jsonKey?: string) => {
            const v = d[key as keyof typeof d]
            if (v != null) { const n = Number(v); return Number.isFinite(n) ? n : null }
            const jk = jsonKey || key
            const jv = m[jk]
            if (jv != null) {
              const n = Number(jv)
              if (!Number.isFinite(n)) return null
              jsonbFallbackCount++
              return n
            }
            return null
          }
          rows.push({
            source: d.platform as string,
            source_trader_id: d.trader_key as string,
            roi: col('roi_pct', 'roi'),
            pnl: col('pnl_usd', 'pnl'),
            win_rate: col('win_rate'),
            max_drawdown: col('max_drawdown'),
            trades_count: col('trades_count'),
            followers: col('followers'),
            copiers: col('copiers'),
            arena_score: col('arena_score'),
            captured_at: d.updated_at as string,
            full_confidence_at: null,
            profitability_score: null,
            risk_control_score: null,
            execution_score: null,
            score_completeness: null,
            trading_style: null,
            avg_holding_hours: null,
            style_confidence: null,
            sharpe_ratio: d.sharpe_ratio != null ? Number(d.sharpe_ratio) : null,
            sortino_ratio: d.sortino_ratio != null ? Number(d.sortino_ratio) : null,
            profit_factor: null,
            calmar_ratio: d.calmar_ratio != null ? Number(d.calmar_ratio) : null,
            trader_type: null,
            metrics_estimated: false,
          })
          if (jsonbFallbackCount > 0) totalJsonbFallbacks++
        }
        if (totalJsonbFallbacks > 0) {
          logger.warn(`[${source}] ${totalJsonbFallbacks}/${data.length} traders used JSONB metrics fallback`)
        }
        return rows
      }),
    )

    results.forEach((rows, idx) => {
      const batchSource = batch[idx]
      if (rows.length > 0) {
        v2CountBySource.set(rows[0].source, rows.length)
      } else if (batchSource) {
        logger.warn(`[${season}] ${batchSource}: 0 traders fetched from snapshots_v2 (window=${v2Window}, fallback checked)`)
      }
      rows.forEach(addToTraderMap)
    })
  }

  return v2CountBySource
}
