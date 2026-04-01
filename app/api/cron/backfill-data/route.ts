/**
 * Data Backfill API
 *
 * Automatically identifies and fills data gaps for all traders.
 * Designed to run continuously until all gaps are filled.
 *
 * Query params:
 *   platform: Target specific platform (optional)
 *   period: Target specific period 7D|30D|90D (optional)
 *   limit: Max traders to process per call (default: 100)
 *   type: Type of backfill - snapshots|enrichment|all (default: all)
 *
 * This endpoint should be called repeatedly until gaps are zero.
 */

import { NextRequest, NextResponse } from 'next/server'
import { type SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { sleep } from '@/lib/cron/fetchers/shared'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'
import { runConnectorBatch } from '@/lib/pipeline/connector-db-adapter'
import { SOURCE_TO_CONNECTOR_MAP } from '@/lib/constants/exchanges'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ALL_PLATFORMS = [
  // CEX futures
  'binance_futures', /* 'binance_spot' REMOVED 2026-03-14 */ 'bybit', 'bitget_futures',
  'okx_futures', 'mexc', 'coinex', 'htx_futures', 'bingx',
  'gateio', 'xt', 'bitmart', 'btcc', 'bitunix', 'bitfinex',
  // CEX spot
  'bybit_spot', 'okx_spot',
  // Web3/DEX
  'binance_web3', 'okx_web3', 'hyperliquid', 'gmx', 'dydx',
  'gains', 'jupiter_perps', 'aevo', 'drift', 'paradex',
  // Bots
  'web3_bot',
]

// Platforms that don't support enrichment (wallet-based, CF-protected, or no enrichment API)
const NO_ENRICHMENT_PLATFORMS = new Set([
  // Wallet-based platforms (no equity curve API)
  'binance_web3', 'okx_web3', 'web3_bot',
  // CF-protected (enrichment not feasible)
  'bingx',
  // API removed/unavailable (2026-03-10)
  'bybit', 'bybit_spot',
  // No enrichment API available
  'bitfinex', 'coinex', 'xt', 'bitmart', 'btcc', 'bitunix', 'paradex', 'okx_spot',
])

const TIME_PERIODS = ['7D', '30D', '90D']

interface BackfillResult {
  platform: string
  period: string
  type: 'snapshot' | 'enrichment'
  tradersProcessed: number
  success: number
  failed: number
  errors: string[]
}

function isAuthorized(req: Request): boolean {
  const secret = env.CRON_SECRET
  if (!secret) return false

  const authHeader = req.headers.get('authorization')
  return authHeader === `Bearer ${secret}`
}

/**
 * Find traders missing data for a specific platform and period
 */
async function findMissingSnapshotTraders(
  supabase: SupabaseClient,
  platform: string,
  period: string,
  limit: number
): Promise<string[]> {
  // Get all traders for this platform from trader_sources
  const { data: allTraders } = await supabase
    .from('trader_sources')
    .select('source_trader_id')
    .eq('source', platform)
    .limit(1000)

  if (!allTraders || allTraders.length === 0) return []

  // Get traders that already have this period's snapshot
  const { data: existingSnapshots } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', platform)
    .eq('season_id', period)

  const existingIds = new Set(existingSnapshots?.map((s) => s.source_trader_id) || [])

  // Find traders missing this period
  const missingTraders = allTraders
    .filter((t) => !existingIds.has(t.source_trader_id))
    .slice(0, limit)
    .map((t) => t.source_trader_id)

  return missingTraders
}

/**
 * Find traders missing enrichment data
 */
async function findMissingEnrichmentTraders(
  supabase: SupabaseClient,
  platform: string,
  period: string,
  limit: number
): Promise<string[]> {
  // Get top traders by arena_score that should have enrichment
  const { data: topTraders } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', platform)
    .eq('season_id', period)
    .order('arena_score', { ascending: false })
    .limit(300) // Top 300 should be enriched

  if (!topTraders || topTraders.length === 0) return []

  // Get traders that already have equity curve for this period
  const { data: existingCurves } = await supabase
    .from('trader_equity_curve')
    .select('source_trader_id')
    .eq('source', platform)
    .eq('period', period)

  const existingIds = new Set(existingCurves?.map((c) => c.source_trader_id) || [])

  // Find top traders missing equity curves
  const missingTraders = topTraders
    .filter((t) => !existingIds.has(t.source_trader_id))
    .slice(0, limit)
    .map((t) => t.source_trader_id)

  return missingTraders
}

/**
 * Backfill snapshot data for missing traders
 */
async function backfillSnapshots(
  supabase: SupabaseClient,
  platform: string,
  period: string,
  traderIds: string[]
): Promise<BackfillResult> {
  const result: BackfillResult = {
    platform,
    period,
    type: 'snapshot',
    tradersProcessed: traderIds.length,
    success: 0,
    failed: 0,
    errors: [],
  }

  // Find connector for this platform
  const mapping = SOURCE_TO_CONNECTOR_MAP[platform]
  if (!mapping) {
    result.errors.push(`No connector mapping for ${platform}`)
    return result
  }

  const connector = await connectorRegistry.getOrInit(
    mapping.platform as import('@/lib/types/leaderboard').LeaderboardPlatform,
    mapping.marketType as import('@/lib/types/leaderboard').MarketType
  )

  if (!connector) {
    result.errors.push(`No connector registered for ${platform}`)
    return result
  }

  try {
    const fetchResult = await runConnectorBatch(connector, {
      supabase,
      windows: [period.toLowerCase() as 'all' | '7d' | '30d' | '90d'],
      limit: 500,
      sourceOverride: platform,
    })

    const periodResult = fetchResult.periods[period] || fetchResult.periods[period.toLowerCase()]
    if (periodResult) {
      result.success = periodResult.saved || 0
      if (periodResult.error) {
        result.errors.push(periodResult.error)
      }
    }
  } catch (err) {
    result.failed = traderIds.length
    result.errors.push(err instanceof Error ? err.message : String(err))
  }

  return result
}

/**
 * Trigger enrichment for specific traders.
 * Uses direct function call instead of HTTP sub-call to avoid:
 * - VERCEL_URL blocked by deployment protection (401)
 * - NEXT_PUBLIC_APP_URL killed by Cloudflare proxy timeout (524)
 */
async function backfillEnrichment(
  _supabase: SupabaseClient,
  platform: string,
  period: string,
  traderIds: string[]
): Promise<BackfillResult> {
  const result: BackfillResult = {
    platform,
    period,
    type: 'enrichment',
    tradersProcessed: traderIds.length,
    success: 0,
    failed: 0,
    errors: [],
  }

  try {
    // Direct function call — no HTTP overhead, no auth issues
    const { runEnrichment } = await import('@/lib/cron/enrichment-runner')
    const enrichResult = await runEnrichment({
      platform,
      period,
      limit: traderIds.length,
    })

    result.success = enrichResult.summary?.enriched || 0
    result.failed = enrichResult.summary?.failed || 0
    if (!enrichResult.ok) {
      result.errors.push('Enrichment returned ok=false')
    }
  } catch (err) {
    result.failed = traderIds.length
    result.errors.push(err instanceof Error ? err.message : String(err))
  }

  return result
}

export async function GET(req: NextRequest) {
  const startTime = Date.now()

  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  // Initialize connectors for backfill
  await initializeConnectors()

  const platformParam = req.nextUrl.searchParams.get('platform')
  const periodParam = req.nextUrl.searchParams.get('period')
  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '100')
  const type = req.nextUrl.searchParams.get('type') || 'all'

  const platforms = platformParam
    ? [platformParam].filter((p) => ALL_PLATFORMS.includes(p))
    : ALL_PLATFORMS

  const periods = periodParam
    ? [periodParam].filter((p) => TIME_PERIODS.includes(p))
    : TIME_PERIODS

  const results: BackfillResult[] = []
  let totalProcessed = 0
  let totalSuccess = 0
  let totalFailed = 0
  let gapsFound = 0

  // Process each platform and period
  for (const platform of platforms) {
    for (const period of periods) {
      // Find and backfill snapshot gaps
      if (type === 'all' || type === 'snapshots') {
        const missingSnapshotTraders = await findMissingSnapshotTraders(supabase, platform, period, limit)

        if (missingSnapshotTraders.length > 0) {
          gapsFound += missingSnapshotTraders.length
          logger.warn(`[backfill] Found ${missingSnapshotTraders.length} traders missing ${period} snapshots for ${platform}`)

          const snapshotResult = await backfillSnapshots(supabase, platform, period, missingSnapshotTraders)
          results.push(snapshotResult)
          totalProcessed += snapshotResult.tradersProcessed
          totalSuccess += snapshotResult.success
          totalFailed += snapshotResult.failed

          // Small delay between operations
          await sleep(1000)
        }
      }

      // Find and backfill enrichment gaps
      if (type === 'all' || type === 'enrichment') {
        // Skip platforms that don't support enrichment
        if (NO_ENRICHMENT_PLATFORMS.has(platform)) {
          logger.info(`[backfill] Skipping enrichment for ${platform} (not supported)`)
          continue
        }

        const missingEnrichmentTraders = await findMissingEnrichmentTraders(supabase, platform, period, limit)

        if (missingEnrichmentTraders.length > 0) {
          gapsFound += missingEnrichmentTraders.length
          logger.warn(`[backfill] Found ${missingEnrichmentTraders.length} traders missing ${period} enrichment for ${platform}`)

          const enrichResult = await backfillEnrichment(supabase, platform, period, missingEnrichmentTraders)
          results.push(enrichResult)
          totalProcessed += enrichResult.tradersProcessed
          totalSuccess += enrichResult.success
          totalFailed += enrichResult.failed

          // Small delay between operations
          await sleep(1000)
        }
      }
    }
  }

  const duration = Date.now() - startTime

  // Pipeline logging
  const plog = await PipelineLogger.start(`backfill-data-${type}`, { platforms: platformParam, period: periodParam })
  if (totalFailed > 0) {
    await plog.error(new Error(`${totalFailed} failures`), { totalSuccess, totalFailed, gapsFound })
  } else {
    await plog.success(totalSuccess, { gapsFound })
  }

  // Determine if there are more gaps to fill
  const hasMoreGaps = gapsFound > 0 && totalSuccess < gapsFound

  return NextResponse.json({
    ok: totalFailed === 0,
    duration,
    hasMoreGaps,
    gapsFound,
    summary: {
      processed: totalProcessed,
      success: totalSuccess,
      failed: totalFailed,
    },
    results,
    nextAction: hasMoreGaps
      ? 'Call this endpoint again to continue backfilling'
      : 'All gaps have been filled or no gaps found',
  })
}

export async function POST(req: NextRequest) {
  // Support POST for manual triggers
  return GET(req)
}
