/**
 * Connector → Supabase DB Write Adapter
 *
 * Bridges the Connector class framework (typed return objects) to the
 * production DB write path (upsertTraders → 4 tables).
 *
 * This adapter:
 * 1. Takes DiscoverResult from a Connector's discoverLeaderboard()
 * 2. Normalizes each trader's raw data via the connector's normalize()
 * 3. Transforms to TraderData format (Zod-validated)
 * 4. Calls upsertTraders() to write to trader_sources, trader_profiles_v2,
 *    trader_snapshots (v1), and trader_snapshots_v2
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PlatformConnector } from './types'
import type { DiscoverResult } from '@/lib/types/leaderboard'
import {
  type TraderData,
  type FetchResult,
  type WriteConsistency,
  upsertTraders,
  calculateArenaScore,
  getSupabaseClient,
} from '@/lib/cron/fetchers/shared'
import { dataLogger } from '@/lib/utils/logger'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import {
  ENRICHMENT_PLATFORM_CONFIGS,
  NO_ENRICHMENT_PLATFORMS,
  runEnrichment,
} from '@/lib/cron/enrichment-runner'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdapterOptions {
  /** Override Supabase client (for testing). Falls back to getSupabaseClient() */
  supabase?: SupabaseClient
  /** If true, skip DB writes and return what would be written */
  dryRun?: boolean
  /** Calculate Arena Score for each trader (default: true) */
  calculateScore?: boolean
  /**
   * Override the source name used in DB writes (trader_sources.source, etc).
   * Needed when connector.platform differs from the cron group source name.
   * E.g., connector platform='htx' but DB source='htx_futures'.
   */
  sourceOverride?: string
}

export interface AdapterResult {
  source: string
  window: string
  total: number
  saved: number
  skipped: number
  error?: string
  dryRunData?: TraderData[]
  writeConsistency?: WriteConsistency
}

// ---------------------------------------------------------------------------
// Core Adapter
// ---------------------------------------------------------------------------

/**
 * Convert a Connector's DiscoverResult into TraderData[] and write to Supabase.
 *
 * @param connector  The platform connector instance (for normalize() and metadata)
 * @param result     DiscoverResult from connector.discoverLeaderboard()
 * @param options    Adapter options
 */
export async function writeDiscoverResult(
  connector: PlatformConnector,
  result: DiscoverResult,
  options: AdapterOptions = {}
): Promise<AdapterResult> {
  const { dryRun = false, calculateScore = true, sourceOverride } = options
  const platform = sourceOverride || connector.platform
  const marketType = connector.marketType
  const window = result.window.toUpperCase() // '7d' → '7D'
  const capturedAt = result.fetched_at || new Date().toISOString()

  const traderDataArray: TraderData[] = []
  let skipped = 0

  for (const trader of result.traders) {
    try {
      // Use connector's normalize() to extract metrics from raw data
      const normalized = trader.raw ? connector.normalize(trader.raw) : {}

      // Extract metrics with fallbacks
      const roi = safeNum(normalized.roi)
      const pnl = safeNum(normalized.pnl)
      const winRate = clampOpt(safeNum(normalized.win_rate), 0, 100)
      const maxDrawdown = clampOpt(safeNum(normalized.max_drawdown), 0, 100)
      const followers = nonNegOpt(safeNum(normalized.followers))
      const tradesCount = nonNegOpt(safeNum(normalized.trades_count))
      const aum = nonNegOpt(safeNum(normalized.aum))
      const sharpeRatio = safeNum(normalized.sharpe_ratio)
      const rank = safeInt(normalized.platform_rank ?? normalized.rank)

      // Calculate Arena Score: use ROI if available, PnL-only fallback otherwise
      let arenaScore: number | null = null
      if (calculateScore) {
        if (roi != null) {
          arenaScore = calculateArenaScore(roi, pnl, maxDrawdown, winRate, window)
        } else if (pnl != null && pnl > 0) {
          // PnL-only score (max 40 points) — better than null
          arenaScore = calculateArenaScore(0, pnl, maxDrawdown, winRate, window)
        }
      }

      const traderData: TraderData = {
        source: platform,
        source_trader_id: trader.trader_key,
        handle: trader.display_name || safeStr(normalized.display_name) || null,
        profile_url: trader.profile_url || safeStr(normalized.profile_url) || null,
        avatar_url: safeStr(normalized.avatar_url) || null,
        season_id: window,
        rank: rank,
        roi,
        pnl,
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        followers,
        trades_count: tradesCount,
        aum,
        sharpe_ratio: sharpeRatio,
        arena_score: arenaScore,
        captured_at: capturedAt,
      }

      traderDataArray.push(traderData)
    } catch (err) {
      skipped++
      if (skipped <= 5) {
        dataLogger.warn(
          `[adapter] Failed to normalize trader ${trader.trader_key} from ${platform}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  if (traderDataArray.length === 0) {
    return {
      source: platform,
      window,
      total: result.traders.length,
      saved: 0,
      skipped,
      // Only report as error if there were traders to normalize (avoids false positive on empty API response)
      error: result.traders.length > 0 ? `All ${result.traders.length} traders failed normalization` : undefined,
    }
  }

  // Dry run: return data without writing
  if (dryRun) {
    return {
      source: platform,
      window,
      total: result.traders.length,
      saved: traderDataArray.length,
      skipped,
      dryRunData: traderDataArray,
    }
  }

  // Get Supabase client
  const supabase = options.supabase || getSupabaseClient()
  if (!supabase) {
    return {
      source: platform,
      window,
      total: result.traders.length,
      saved: 0,
      skipped,
      error: 'Supabase client not available (missing env vars)',
    }
  }

  // Write to DB via shared upsertTraders()
  const { saved, error, write_consistency } = await upsertTraders(supabase, traderDataArray)

  return {
    source: platform,
    window,
    total: result.traders.length,
    saved,
    skipped,
    error,
    writeConsistency: write_consistency,
  }
}

// ---------------------------------------------------------------------------
// Batch execution: run a connector for all windows and write results
// ---------------------------------------------------------------------------

export interface BatchRunOptions extends AdapterOptions {
  /** Windows to fetch (default: ['7d', '30d', '90d']) */
  windows?: string[]
  /** Max traders per window (default: 500) */
  limit?: number
  /**
   * If true, fire-and-forget enrichment for top 10 traders (90D window only)
   * after the main fetch+save completes. Only runs if the platform has enrichment support.
   * Default: false
   */
  inlineEnrich?: boolean
}

/**
 * Run a connector's discoverLeaderboard() for multiple windows and write all results.
 * This replaces the PlatformFetcher function signature for the migration.
 *
 * Returns a FetchResult compatible with the existing pipeline logging format.
 */
export async function runConnectorBatch(
  connector: PlatformConnector,
  options: BatchRunOptions = {}
): Promise<FetchResult> {
  const { windows = ['7d', '30d', '90d'], limit = 500, sourceOverride, inlineEnrich = false } = options
  const startTime = Date.now()
  const platform = sourceOverride || connector.platform
  const periods: FetchResult['periods'] = {}

  // Aggregate write consistency across all windows
  const aggregatedConsistency: WriteConsistency = {
    trader_sources: 'ok',
    trader_snapshots_v2: 'ok',
  }

  // Get Supabase client once for all windows
  const supabase = options.supabase || getSupabaseClient()

  let anySaved = false

  // Fetch all windows in parallel — rate limiter handles per-platform concurrency
  const windowResults = await Promise.allSettled(
    windows.map(async (window) => {
      const windowUpper = window.toUpperCase()
      try {
        // Fetch leaderboard for this window
        const result = await connector.discoverLeaderboard(
          window as '7d' | '30d' | '90d',
          limit
        )

        // Write to DB
        const writeResult = await writeDiscoverResult(connector, result, {
          ...options,
          supabase: supabase || undefined,
        })

        return { windowUpper, writeResult }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        dataLogger.error(`[${platform}] Failed to fetch ${windowUpper}: ${errMsg}`)
        return { windowUpper, error: errMsg }
      }
    })
  )

  // Collect results from parallel execution
  for (const settled of windowResults) {
    if (settled.status === 'rejected') continue
    const { windowUpper, writeResult, error } = settled.value as {
      windowUpper: string
      writeResult?: AdapterResult
      error?: string
    }

    if (error) {
      periods[windowUpper] = { total: 0, saved: 0, error }
      continue
    }

    if (writeResult) {
      periods[windowUpper] = {
        total: writeResult.total,
        saved: writeResult.saved,
        error: writeResult.error,
      }

      if (writeResult.saved > 0) anySaved = true

      // Merge write consistency: any failure taints the aggregate
      if (writeResult.writeConsistency) {
        for (const key of Object.keys(aggregatedConsistency) as (keyof WriteConsistency)[]) {
          if (writeResult.writeConsistency[key] === 'failed') {
            aggregatedConsistency[key] = 'failed'
          }
        }
      }
    }
  }

  // Fire-and-forget inline enrichment for top 10 traders (90D only)
  if (inlineEnrich && anySaved) {
    const hasEnrichmentSupport =
      platform in ENRICHMENT_PLATFORM_CONFIGS && !NO_ENRICHMENT_PLATFORMS.has(platform)

    if (hasEnrichmentSupport) {
      // Do not await — fire and forget so it never blocks the main result
      runEnrichment({ platform, period: '90D', limit: 10 }).catch((err) => {
        dataLogger.warn(
          `[adapter] Inline enrichment failed for ${platform}: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }

  return {
    source: platform,
    periods,
    duration: Date.now() - startTime,
    write_consistency: aggregatedConsistency,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  if (!Number.isFinite(n)) return null
  return n
}

function safeInt(v: unknown): number | null {
  const n = safeNum(v)
  if (n == null) return null
  return Math.round(n)
}

function safeStr(v: unknown): string | null {
  if (v == null) return null
  const s = String(v)
  return s.length > 0 ? s : null
}

function clampOpt(v: number | null, min: number, max: number): number | null {
  if (v == null) return null
  return Math.max(min, Math.min(max, v))
}

function nonNegOpt(v: number | null): number | null {
  if (v == null) return null
  return v < 0 ? null : v
}
