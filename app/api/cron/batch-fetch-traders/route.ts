/**
 * Batch fetch-traders dispatcher
 *
 * Calls fetcher functions DIRECTLY (in-process) instead of via HTTP,
 * avoiding Cloudflare timeouts and Vercel deployment protection issues.
 *
 * Query params:
 *   group=a  → binance_futures, binance_spot (every 3h)
 *   group=a2 → bitget_futures, okx_futures (every 3h)
 *   group=b  → hyperliquid, gmx, jupiter_perps (every 4h)
 *   group=c  → okx_web3, aevo, xt (every 4h)
 *   group=d1 → gains, htx_futures (every 6h)
 *   group=d2 → dydx (every 6h)
 *   group=e  → coinex, binance_web3 (every 6h)
 *   group=f  → mexc, bingx (every 6h)
 *   group=h  → gateio, btcc (every 6h)
 *   group=g1 → drift, bitunix (every 6h)
 *   group=g2 → web3_bot, toobit, bitget_spot (every 6h)
 *   group=i  → etoro (every 6h)
 *
 * Dead/blocked platforms (fetcher files deleted 2026-03-10):
 *   kucoin, lbank, weex, mux, synthetix, bitmart,
 *   whitebit, btse, cryptocom, pionex, vertex, okx_spot, paradex
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { createSupabaseAdmin } from '@/lib/cron/utils'
import { recordFetchResult } from '@/lib/utils/pipeline-monitor'
import { logger } from '@/lib/logger'
import { runConnectorBatch } from '@/lib/connectors/connector-db-adapter'
import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'
import { SOURCE_TO_CONNECTOR_MAP } from '@/lib/constants/exchanges'

export const dynamic = 'force-dynamic'
export const maxDuration = 600 // Vercel Pro max: 10 minutes (was 300s = 5min)
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX/Bybit geo-blocking

const GROUPS: Record<string, string[]> = {
  // Group A1: Binance (every 3h) — binance_futures removed 2026-03-14: Client error 404
  a: ['binance_spot'],
  // Group A2: Other high-priority CEX (every 3h)
  // DISABLED 2026-03-13: All 3 platforms have API access issues
  // - bybit: api2.bybit.com returns 403 Access Denied
  // - bitget_futures: Cloudflare challenge blocking direct API access
  // - okx_futures: API endpoint returning 404
  // TODO: Re-enable after VPS scraper integration or proxy fix
  a2: [],
  // Group B: Top DEX (every 4h) — DISABLED 2026-03-14: All 3 platforms returning client errors via batch
  // - hyperliquid: 422, gmx: 404, jupiter_perps: 0 traders normalization failed
  // Individual connector cron tasks work fine; issue is batch connector invocation
  b: [],
  // Group C: Mid-priority (every 4h) — DISABLED 2026-03-14: All 3 platforms failing via batch
  // - okx_web3: 400, aevo: 0 traders, xt: 0 traders
  c: [],
  // Group D1: CEX (every 6h) — htx_futures removed 2026-03-14: Client error 405
  d1: ['gains'],
  // Group D2: DEX only (every 6h) — dydx removed 2026-03-14: Client error 404
  d2: [],
  // Group E: CEX+DEX (every 6h) — coinex/binance_web3 removed 2026-03-14: connector errors
  e: ['bitfinex'],
  // Group F: Slow CEX (every 6h) — DISABLED 2026-03-14: mexc 404, bingx normalization failed
  f: [],
  // Group H: Fast CEX (every 6h) — DISABLED 2026-03-14: gateio 403, btcc normalization failed
  h: [],
  // Group G1: DEX (every 6h) — re-enabled: drift response parsing fixed
  // bitunix removed 2026-03-14: All traders failing validation since 2026-03-14 01:08
  g1: ['drift'],
  // Group G2: DEX+CEX (every 6h) — bitget_spot removed 2026-03-14: normalization failed
  // paradex removed: API now requires JWT auth since 2026-03
  // kwenta removed: Copin API stopped serving Kwenta data (2026-03-11)
  // blofin removed: openapi.blofin.com requires auth, VPS scraper endpoint missing (2026-03-11)
  g2: ['web3_bot', 'toobit'],
  // Group I: Social trading (every 6h) — large dataset (2000 traders × 3 periods)
  i: ['etoro'],
}

interface BatchResult {
  platform: string
  status: 'success' | 'error'
  durationMs: number
  totalSaved?: number
  error?: string
  via?: 'connector'
}

/**
 * All active platforms now use the Connector framework.
 * Inline Fetcher is kept only as automatic fallback if a connector
 * is not found in the registry (e.g., newly added platform not yet registered).
 *
 * Migration completed 2026-03-13: all 24 active platforms switched.
 * DEAD_BLOCKED_PLATFORMS are skipped by cron groups (not in any group).
 */

// SOURCE_TO_CONNECTOR_MAP imported from @/lib/constants/exchanges

/** Initialized flag — connectors only need to be registered once per cold start */
let connectorsInitialized = false

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const group = request.nextUrl.searchParams.get('group') || 'a'
  const platforms = GROUPS[group]
  if (!platforms) {
    return NextResponse.json({ error: `Unknown group: ${group}`, available: Object.keys(GROUPS) }, { status: 400 })
  }

  const supabaseOrNull = createSupabaseAdmin()
  if (!supabaseOrNull) {
    return NextResponse.json({ error: 'Supabase env vars missing' }, { status: 500 })
  }
  const supabase = supabaseOrNull

  const overallStart = Date.now()
  const plog = await PipelineLogger.start(`batch-fetch-traders-${group}`, { group, platforms })

  // Safety timeout: ensure plog gets called before Vercel kills the function at 600s
  const safetyTimer = setTimeout(async () => {
    try {
      await plog.error(new Error('Safety timeout: function approaching 600s limit'))
    } catch { /* best effort */ }
  }, 580_000) // Was 280s, now 580s for 600s maxDuration

  // Per-platform timeout: configurable, default 420s leaves 180s buffer for logging/cleanup within 600s limit
  const PLATFORM_TIMEOUT_MS = parseInt(process.env.PLATFORM_FETCH_TIMEOUT_MS || '420000', 10)

  // Initialize all connectors (once per cold start)
  if (!connectorsInitialized) {
    try {
      await initializeConnectors()
      connectorsInitialized = true
    } catch (err) {
      logger.error(`[batch-fetch-traders-${group}] Failed to initialize connectors: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Run a single platform via Connector
  async function runPlatform(platform: string): Promise<BatchResult> {
    const start = Date.now()

    const mapping = SOURCE_TO_CONNECTOR_MAP[platform]
    const connector = (mapping && connectorsInitialized)
      ? connectorRegistry.get(
          mapping.platform as import('@/lib/types/leaderboard').LeaderboardPlatform,
          mapping.marketType as import('@/lib/types/leaderboard').MarketType
        )
      : null

    if (!connector) {
      const errMsg = mapping
        ? `No connector registered for ${platform}:${mapping.marketType}`
        : `No SOURCE_TO_CONNECTOR mapping for ${platform}`
      logger.error(`[batch-fetch-traders-${group}] ${errMsg}`)
      return { platform, status: 'error', durationMs: Date.now() - start, error: errMsg, via: 'connector' }
    }

    try {
      const result = await Promise.race([
        runConnectorBatch(connector, { supabase, windows: ['7d', '30d', '90d'], limit: 500, sourceOverride: platform }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Platform ${platform} timed out after ${PLATFORM_TIMEOUT_MS / 1000}s`)), PLATFORM_TIMEOUT_MS)
        ),
      ])

      const hasErrors = Object.values(result.periods).some((p) => p.error)
      const totalSaved = Object.values(result.periods).reduce((sum, p) => sum + (p.saved || 0), 0)

      await recordFetchResult(supabase, result.source, {
        success: !hasErrors,
        durationMs: result.duration,
        recordCount: totalSaved,
        error: hasErrors
          ? Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
          : undefined,
        metadata: { periods: result.periods, batchGroup: group, via: 'connector' },
      })

      logger.info(`[batch-fetch-traders-${group}] ${platform} (connector): saved=${totalSaved} duration=${Date.now() - start}ms`)

      if (hasErrors && totalSaved === 0) {
        const errDetail = Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
        return { platform, status: 'error', durationMs: Date.now() - start, totalSaved, error: errDetail, via: 'connector' }
      }
      return { platform, status: 'success', durationMs: Date.now() - start, totalSaved, via: 'connector' }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(`[batch-fetch-traders-${group}] ${platform} (connector) error: ${errMsg}`)

      try {
        await recordFetchResult(supabase, platform, {
          success: false, durationMs: Date.now() - start, recordCount: 0, error: errMsg,
        })
      } catch (metricErr) {
        logger.warn(`[batch-fetch-traders-${group}] Failed to record metric for ${platform}`, { error: metricErr instanceof Error ? metricErr.message : String(metricErr) })
      }

      return { platform, status: 'error', durationMs: Date.now() - start, error: errMsg, via: 'connector' }
    }
  }

  // All platforms run in parallel — each platform uses a different fetcher module
  // so there's no shared state corruption risk.
  // Module-scoped strategy caches (_bybitStrategy, _cachedStrategy) are only shared
  // if the SAME fetcher is called concurrently, which doesn't happen within a group.
  const results = await Promise.all(platforms.map(runPlatform))

  clearTimeout(safetyTimer)
  const succeeded = results.filter((r) => r.status === 'success').length
  const failed = results.length - succeeded

  if (failed === 0) {
    await plog.success(succeeded, { results })
  } else {
    await plog.error(
      new Error(`${failed}/${results.length} platforms failed`),
      { results }
    )
  }

  return NextResponse.json({
    ok: succeeded === results.length,
    group,
    platforms: platforms.length,
    succeeded,
    failed,
    totalDurationMs: Date.now() - overallStart,
    results,
  })
}
