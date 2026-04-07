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
import { VALIDATION_BOUNDS as VB } from './types'
import type { PlatformConnector } from '@/lib/connectors/types'
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
import {
  ENRICHMENT_PLATFORM_CONFIGS,
  NO_ENRICHMENT_PLATFORMS,
  runEnrichment,
} from '@/lib/cron/enrichment-runner'
import {
  upsertEquityCurve,
  upsertAssetBreakdown,
} from '@/lib/cron/fetchers/enrichment-db'
import type { EquityCurvePoint, AssetBreakdown } from '@/lib/cron/fetchers/enrichment-types'

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
  /** Trader keys that were successfully written — used for inline enrichment */
  savedTraderKeys: string[]
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
  const _marketType = connector.marketType
  const window = result.window.toUpperCase() // '7d' → '7D'
  const capturedAt = result.fetched_at || new Date().toISOString()

  const traderDataArray: TraderData[] = []
  let skipped = 0
  let boundaryWarnings = 0

  for (const trader of result.traders) {
    try {
      // Use connector's normalize() to extract metrics from raw data
      const normalized = trader.raw ? connector.normalize(trader.raw) : {}

      // Output validation: ensure trader_key is present and metrics are valid types
      if (!trader.trader_key || typeof trader.trader_key !== 'string' || trader.trader_key.trim() === '') {
        dataLogger.warn(`[adapter] Skipping trader with invalid trader_key from ${platform}: ${JSON.stringify(trader.trader_key)}`)
        skipped++
        continue
      }
      if (normalized.roi !== undefined && normalized.roi !== null && typeof normalized.roi !== 'number') {
        dataLogger.warn(`[adapter] Skipping trader ${trader.trader_key} from ${platform}: roi is not a number (${typeof normalized.roi})`)
        skipped++
        continue
      }
      if (normalized.pnl !== undefined && normalized.pnl !== null && typeof normalized.pnl !== 'number') {
        dataLogger.warn(`[adapter] Skipping trader ${trader.trader_key} from ${platform}: pnl is not a number (${typeof normalized.pnl})`)
        skipped++
        continue
      }

      // Extract metrics with boundary validation
      const rawRoi = safeNum(normalized.roi)
      const rawPnl = safeNum(normalized.pnl)
      const rawWinRate = safeNum(normalized.win_rate)
      const rawMaxDrawdown = safeNum(normalized.max_drawdown)
      const rawSharpe = safeNum(normalized.sharpe_ratio)

      // --- Boundary validation with warning logging ---
      // Bounds imported from VALIDATION_BOUNDS (single source of truth in types.ts)
      const roi = validateBound(rawRoi, VB.roi_pct.min, VB.roi_pct.max, 'roi', platform, trader.trader_key, boundaryWarnings)
      if (roi === BOUNDARY_VIOLATED) { boundaryWarnings++; }
      const roiVal = roi === BOUNDARY_VIOLATED ? null : roi

      // PnL: keep all values but warn on extreme (|PnL| > $10M)
      if (rawPnl != null && Math.abs(rawPnl) > 10_000_000 && boundaryWarnings < 10) {
        dataLogger.warn(`[adapter][${platform}] Extreme PnL $${rawPnl.toFixed(0)} for trader ${trader.trader_key} (kept)`)
      }
      const pnl = rawPnl

      // Win Rate: must be 0-100%, null out if outside
      const winRate = validateBound(rawWinRate, VB.win_rate_pct.min, VB.win_rate_pct.max, 'win_rate', platform, trader.trader_key, boundaryWarnings)
      if (winRate === BOUNDARY_VIOLATED) { boundaryWarnings++; }
      const winRateVal = winRate === BOUNDARY_VIOLATED ? null : winRate

      // Max Drawdown: must be 0-100%, null out if outside
      const mdd = validateBound(rawMaxDrawdown, VB.max_drawdown_pct.min, VB.max_drawdown_pct.max, 'max_drawdown', platform, trader.trader_key, boundaryWarnings)
      if (mdd === BOUNDARY_VIOLATED) { boundaryWarnings++; }
      const maxDrawdown = mdd === BOUNDARY_VIOLATED ? null : mdd

      // Sharpe Ratio: uses VALIDATION_BOUNDS (±10)
      const sharpe = validateBound(rawSharpe, VB.sharpe_ratio.min, VB.sharpe_ratio.max, 'sharpe_ratio', platform, trader.trader_key, boundaryWarnings)
      if (sharpe === BOUNDARY_VIOLATED) { boundaryWarnings++; }
      const sharpeRatio = sharpe === BOUNDARY_VIOLATED ? null : sharpe

      const followers = nonNegOpt(safeNum(normalized.followers))
      const copiers = nonNegOpt(safeNum(normalized.copiers))
      const tradesCount = nonNegOpt(safeNum(normalized.trades_count))
      const aum = nonNegOpt(safeNum(normalized.aum))
      const rank = safeInt(normalized.platform_rank ?? normalized.rank)

      // Calculate Arena Score: use ROI if available, PnL-only fallback otherwise
      let arenaScore: number | null = null
      if (calculateScore) {
        if (roiVal != null) {
          arenaScore = calculateArenaScore(roiVal, pnl, maxDrawdown, winRateVal, window)
        } else if (pnl != null && pnl > 0) {
          // PnL-only score (max 40 points) — better than null
          arenaScore = calculateArenaScore(0, pnl, maxDrawdown, winRateVal, window)
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
        roi: roiVal,
        pnl,
        win_rate: winRateVal,
        max_drawdown: maxDrawdown,
        followers,
        copiers,
        trades_count: tradesCount,
        aum,
        sharpe_ratio: sharpeRatio,
        arena_score: arenaScore,
        captured_at: capturedAt,
      }

      traderDataArray.push(traderData)
    } catch (err) {
      skipped++
      if (skipped <= 20) {
        dataLogger.warn(
          `[adapter] Failed to normalize trader ${trader.trader_key} from ${platform}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  if (skipped > 0) {
    dataLogger.warn(
      `[adapter] Normalization summary for ${platform}/${window}: ${skipped} of ${result.traders.length} traders skipped`
    )
  }

  if (traderDataArray.length === 0) {
    return {
      source: platform,
      window,
      total: result.traders.length,
      saved: 0,
      skipped,
      savedTraderKeys: [],
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
      savedTraderKeys: traderDataArray.map(t => t.source_trader_id),
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
      savedTraderKeys: [],
      error: 'Supabase client not available (missing env vars)',
    }
  }

  // Connector health check: compare against previous run to detect degradation
  try {
    const { checkConnectorHealth } = await import('./connector-health-monitor')
    const healthCheck = await checkConnectorHealth(platform, window, traderDataArray as unknown as Record<string, unknown>[])
    if (healthCheck.severity === 'critical') {
      dataLogger.error(`[adapter] BLOCKED write for ${platform}/${window}: ${healthCheck.reasons.join('; ')}`)
      try {
        const { sendRateLimitedAlert } = await import('@/lib/alerts/send-alert')
        await sendRateLimitedAlert({
          title: `Connector 退化: ${platform}/${window}`,
          message: healthCheck.reasons.join('\n'),
          level: 'critical',
          details: { platform, window, rowCount: traderDataArray.length },
        }, `connector-degrade:${platform}:${window}`, 3600_000)
      } catch { /* alert non-critical */ }
      return {
        source: platform, window, total: traderDataArray.length, saved: 0,
        skipped: traderDataArray.length, error: 'Blocked by health monitor: ' + healthCheck.reasons[0],
        savedTraderKeys: [],
      }
    }
    if (healthCheck.severity === 'warning') {
      dataLogger.warn(`[adapter] Health warning for ${platform}/${window}: ${healthCheck.reasons.join('; ')}`)
    }
  } catch (err) {
    dataLogger.warn(`[adapter] Health check failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`)
  }

  // Write to DB via shared upsertTraders()
  const { saved, error, write_consistency } = await upsertTraders(supabase, traderDataArray)

  // --- Inline enrichment: write timeseries & asset data from leaderboard API ---
  // Some connectors return equity curve / asset breakdown data directly in the
  // leaderboard response (via _ prefixed fields in normalize output). Write these
  // to enrichment tables so traders get charts without needing a separate enrichment run.
  try {
    await writeInlineEnrichment(supabase, platform, window, result.traders, connector)
  } catch (err) {
    dataLogger.warn(`[adapter] Inline enrichment failed for ${platform}/${window}: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    source: platform,
    window,
    total: result.traders.length,
    saved,
    skipped,
    savedTraderKeys: saved > 0 ? traderDataArray.map(t => t.source_trader_id) : [],
    error,
    writeConsistency: write_consistency,
  }
}

/**
 * Write inline enrichment data (equity curves, asset breakdowns) extracted
 * from leaderboard API responses. This avoids needing a separate enrichment
 * run for platforms that include timeseries data in their leaderboard API.
 */
async function writeInlineEnrichment(
  supabase: SupabaseClient,
  platform: string,
  window: string,
  traders: DiscoverResult['traders'],
  connector: PlatformConnector,
) {
  let equityCurveCount = 0
  let assetBreakdownCount = 0

  for (const trader of traders) {
    if (!trader.raw) continue
    const normalized = connector.normalize(trader.raw) as Record<string, unknown>
    const traderKey = trader.trader_key

    // --- Equity Curve from various platform formats ---

    // binance_web3: dailyPNL array [{realizedPnl, dt}]
    if (normalized._daily_pnl && Array.isArray(normalized._daily_pnl)) {
      const dailyPnl = normalized._daily_pnl as Array<{ realizedPnl: number | string; dt: string }>
      if (dailyPnl.length >= 2) {
        let cumPnl = 0
        const curve: EquityCurvePoint[] = dailyPnl.map(d => {
          const dayPnl = Number(d.realizedPnl) || 0
          cumPnl += dayPnl
          return { date: d.dt, roi: 0, pnl: cumPnl }
        })
        await upsertEquityCurve(supabase, platform, traderKey, window, curve)
        equityCurveCount++
      }
    }

    // mexc: curveTime[] + curveValues[] (ROI) + pnlCurveValues[] (PnL)
    if (normalized._curve_time && normalized._curve_values) {
      const times = normalized._curve_time as number[]
      const values = normalized._curve_values as number[]
      const pnlValues = normalized._pnl_curve_values as number[] | undefined
      if (Array.isArray(times) && Array.isArray(values) && times.length >= 2) {
        const curve: EquityCurvePoint[] = times.map((ts, i) => ({
          date: new Date(ts).toISOString().split('T')[0],
          roi: values[i] ?? null,
          pnl: pnlValues?.[i] ?? null,
        }))
        await upsertEquityCurve(supabase, platform, traderKey, window, curve)
        equityCurveCount++
      }
    }

    // coinex: profit_rate_series [[timestamp, "rate"], ...]
    if (normalized._profit_rate_series && Array.isArray(normalized._profit_rate_series)) {
      const series = normalized._profit_rate_series as Array<[number, string]>
      if (series.length >= 2) {
        const curve: EquityCurvePoint[] = series.map(([ts, rate]) => ({
          date: new Date(ts * 1000).toISOString().split('T')[0],
          roi: Number(rate) * 100, // decimal → percentage
          pnl: null,
        }))
        await upsertEquityCurve(supabase, platform, traderKey, window, curve)
        equityCurveCount++
      }
    }

    // htx_futures: profitList (30 daily cumulative return values as strings)
    if (platform === 'htx_futures' && normalized._profit_list && Array.isArray(normalized._profit_list)) {
      const profitList = normalized._profit_list as string[]
      if (profitList.length >= 2) {
        const now = new Date()
        const curve: EquityCurvePoint[] = profitList.map((val, i) => {
          const date = new Date(now.getTime() - (profitList.length - 1 - i) * 86400000)
          return {
            date: date.toISOString().split('T')[0],
            roi: Number(val) || 0,
            pnl: null,
          }
        })
        await upsertEquityCurve(supabase, platform, traderKey, window, curve)
        equityCurveCount++
      }
    }

    // gateio: profit_list (array of daily ROI ratios, e.g. 0.0954 = 9.54%)
    if (platform === 'gateio' && normalized._profit_list && Array.isArray(normalized._profit_list)) {
      const profitList = normalized._profit_list as number[]
      if (profitList.length >= 2) {
        const now = new Date()
        const curve: EquityCurvePoint[] = profitList.map((val, i) => {
          const date = new Date(now.getTime() - (profitList.length - 1 - i) * 86400000)
          return {
            date: date.toISOString().split('T')[0],
            roi: (Number(val) || 0) * 100, // ratio → percentage
            pnl: null,
          }
        })
        await upsertEquityCurve(supabase, platform, traderKey, window, curve)
        equityCurveCount++
      }
    }

    // --- Asset Breakdown from various platform formats ---

    // binance_web3: topEarningTokens [{tokenSymbol, realizedPnl, profitRate}]
    if (normalized._top_earning_tokens && Array.isArray(normalized._top_earning_tokens)) {
      const tokens = normalized._top_earning_tokens as Array<{ tokenSymbol: string; realizedPnl: number }>
      if (tokens.length > 0) {
        const totalPnl = tokens.reduce((sum, t) => sum + Math.abs(Number(t.realizedPnl) || 0), 0)
        if (totalPnl > 0) {
          const assets: AssetBreakdown[] = tokens.map(t => ({
            symbol: t.tokenSymbol,
            weightPct: (Math.abs(Number(t.realizedPnl) || 0) / totalPnl) * 100,
          }))
          await upsertAssetBreakdown(supabase, platform, traderKey, window, assets)
          assetBreakdownCount++
        }
      }
    }

    // mexc: contractRateList [{contractId, symbol, rate, ...}]
    if (normalized._contract_rate_list && Array.isArray(normalized._contract_rate_list)) {
      const contracts = normalized._contract_rate_list as Array<{ symbol?: string; symbolDisplay?: string; rate?: number }>
      if (contracts.length > 0) {
        const assets: AssetBreakdown[] = contracts
          .filter(c => (c.symbol || c.symbolDisplay) && c.rate != null)
          .map(c => ({
            symbol: (c.symbolDisplay || c.symbol || '').replace('_USDT', '').replace('USDT', ''),
            weightPct: (Number(c.rate) || 0) * 100,
          }))
        if (assets.length > 0) {
          await upsertAssetBreakdown(supabase, platform, traderKey, window, assets)
          assetBreakdownCount++
        }
      }
    }

    // okx_web3: traderInsts [instrument strings like "BTC-USDT-SWAP"]
    if (normalized._trader_insts && Array.isArray(normalized._trader_insts)) {
      const insts = normalized._trader_insts as string[]
      if (insts.length > 0) {
        // Equal weight since OKX doesn't provide allocation percentages
        const weightPer = 100 / insts.length
        const assets: AssetBreakdown[] = insts.slice(0, 20).map(inst => ({
          symbol: inst.split('-')[0] || inst,
          weightPct: weightPer,
        }))
        // Deduplicate by symbol, summing weights
        const deduped = new Map<string, number>()
        for (const a of assets) {
          deduped.set(a.symbol, (deduped.get(a.symbol) || 0) + a.weightPct)
        }
        const dedupedAssets: AssetBreakdown[] = Array.from(deduped.entries()).map(([symbol, weightPct]) => ({ symbol, weightPct }))
        await upsertAssetBreakdown(supabase, platform, traderKey, window, dedupedAssets)
        assetBreakdownCount++
      }
    }
  }

  if (equityCurveCount > 0 || assetBreakdownCount > 0) {
    dataLogger.info(`[adapter] Inline enrichment for ${platform}/${window}: ${equityCurveCount} equity curves, ${assetBreakdownCount} asset breakdowns`)
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
   * Run enrichment (equity curve, stats, positions) for all fetched traders
   * immediately after leaderboard write. New traders get complete profiles in one pass.
   * Default: true
   */
  inlineEnrich?: boolean
  /**
   * Total time budget for this platform in ms (from batch-fetch route).
   * Used to allocate remaining time to inline enrichment after fetch+write.
   * Default: 120000 (120s)
   */
  platformTimeBudgetMs?: number
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
  const { windows = ['7d', '30d', '90d'], limit = 2000, sourceOverride, inlineEnrich = true, platformTimeBudgetMs = 120_000 } = options
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

  // ═══ Phase 1: Fetch all windows, collect DiscoverResults ═══
  // Sequential to avoid concurrent upsert deadlocks (40P01)
  const fetchedWindows: Array<{ window: string; windowUpper: string; result?: DiscoverResult; error?: string }> = []
  for (const window of windows) {
    const windowUpper = window.toUpperCase()
    try {
      const result = await connector.discoverLeaderboard(
        window as '7d' | '30d' | '90d',
        limit
      )
      fetchedWindows.push({ window, windowUpper, result })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      dataLogger.error(`[${platform}] Failed to fetch ${windowUpper}: ${errMsg}`)
      fetchedWindows.push({ window, windowUpper, error: errMsg })
    }
  }

  // ═══ Phase 2: Cross-window union — ensure every trader appears in ALL windows ═══
  // If a trader appears in 7D but not 90D (common: new traders), clone their entry
  // into the missing windows so 90D is always a superset of 7D/30D.
  {
    // Build union of all trader keys across all fetched windows
    const traderByKey = new Map<string, import('@/lib/types/leaderboard').TraderSource>()
    const tradersInWindow = new Map<string, Set<string>>() // window → set of trader_keys

    for (const fw of fetchedWindows) {
      if (!fw.result?.traders) continue
      const keySet = new Set<string>()
      for (const t of fw.result.traders) {
        const key = t.trader_key.startsWith('0x') ? t.trader_key.toLowerCase() : t.trader_key
        keySet.add(key)
        if (!traderByKey.has(key)) traderByKey.set(key, t)
      }
      tradersInWindow.set(fw.windowUpper, keySet)
    }

    // For each successfully fetched window, add traders missing from that window
    let totalBackfilled = 0
    for (const fw of fetchedWindows) {
      if (!fw.result?.traders) continue
      const existingKeys = tradersInWindow.get(fw.windowUpper)!
      const missingTraders: import('@/lib/types/leaderboard').TraderSource[] = []

      for (const [key, donor] of traderByKey) {
        if (!existingKeys.has(key)) {
          // Clone the trader entry for this window (metrics stay from the donor window)
          missingTraders.push({ ...donor, trader_key: key })
        }
      }

      if (missingTraders.length > 0) {
        fw.result.traders.push(...missingTraders)
        totalBackfilled += missingTraders.length
      }
    }

    if (totalBackfilled > 0) {
      dataLogger.info(`[${platform}] Cross-window union: backfilled ${totalBackfilled} trader-window entries (${traderByKey.size} unique traders)`)
    }
  }

  // ═══ Phase 3: Write all windows to DB ═══
  const windowResults: Array<{ windowUpper: string; writeResult?: AdapterResult; error?: string }> = []
  for (const fw of fetchedWindows) {
    if (fw.error) {
      windowResults.push({ windowUpper: fw.windowUpper, error: fw.error })
      continue
    }
    if (!fw.result) continue
    try {
      const writeResult = await writeDiscoverResult(connector, fw.result, {
        ...options,
        supabase: supabase || undefined,
      })
      windowResults.push({ windowUpper: fw.windowUpper, writeResult })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      windowResults.push({ windowUpper: fw.windowUpper, error: errMsg })
    }
  }

  // Collect results
  for (const { windowUpper, writeResult, error } of windowResults) {
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

  // --- Inline enrichment: enrich ALL fetched traders immediately ---
  // Collects equity curves, stats detail, positions, derived metrics in one pass.
  // New traders get complete profiles without waiting for batch-enrich cron.
  if (inlineEnrich && anySaved) {
    const hasEnrichmentSupport =
      platform in ENRICHMENT_PLATFORM_CONFIGS && !NO_ENRICHMENT_PLATFORMS.has(platform)

    if (hasEnrichmentSupport) {
      // Collect unique trader keys across all windows
      const allTraderKeys = new Set<string>()
      for (const { writeResult } of windowResults) {
        if (writeResult?.savedTraderKeys) {
          for (const key of writeResult.savedTraderKeys) allTraderKeys.add(key)
        }
      }

      if (allTraderKeys.size > 0) {
        const traderKeys = Array.from(allTraderKeys)
        const fetchElapsed = Date.now() - startTime
        const enrichBudgetMs = Math.max(10_000, platformTimeBudgetMs - fetchElapsed - 5_000)

        dataLogger.info(
          `[adapter] Inline enrichment for ${platform}: ${traderKeys.length} traders, ` +
          `budget ${Math.round(enrichBudgetMs / 1000)}s (fetch took ${Math.round(fetchElapsed / 1000)}s)`
        )

        // Only enrich 90D inline — it fetches the longest equity curve (90 days,
        // covering 30D/7D range) and stats/positions are period-independent.
        // Running all 3 periods burns 3x API quota and triggers rate limits (429).
        // batch-enrich cron fills 30D/7D equity curves on its regular schedule.
        const remainingBudget = Math.max(5_000, platformTimeBudgetMs - (Date.now() - startTime) - 5_000)

        try {
          await runEnrichment({
            platform,
            period: '90D',
            limit: traderKeys.length,
            traderKeys,
            timeBudgetMs: remainingBudget,
          })
        } catch (err) {
          dataLogger.warn(
            `[adapter] Inline enrichment ${platform}/90D failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
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

// ---------------------------------------------------------------------------
// Boundary Validation
// ---------------------------------------------------------------------------

/** Sentinel value indicating a boundary violation (value nulled out) */
const BOUNDARY_VIOLATED = Symbol('BOUNDARY_VIOLATED')

/**
 * Validate a numeric value is within expected bounds.
 * Returns the value if valid, null if input is null, or BOUNDARY_VIOLATED if out of range.
 * Logs a warning (up to 10 per batch) for violations.
 */
function validateBound(
  value: number | null,
  min: number,
  max: number,
  field: string,
  platform: string,
  traderKey: string,
  warningCount: number,
): number | null | typeof BOUNDARY_VIOLATED {
  if (value == null) return null
  if (value >= min && value <= max) return value
  // Out of bounds — log warning and return sentinel
  if (warningCount < 10) {
    dataLogger.warn(
      `[adapter][${platform}] ${field} out of bounds: ${value} (expected ${min}..${max}) for trader ${traderKey} — set to null`
    )
  }
  return BOUNDARY_VIOLATED
}

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

function nonNegOpt(v: number | null): number | null {
  if (v == null) return null
  return v < 0 ? null : v
}
