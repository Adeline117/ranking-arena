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
import { getInlineFetcher } from '@/lib/cron/fetchers'
import { createSupabaseAdmin } from '@/lib/cron/utils'
import { recordFetchResult } from '@/lib/utils/pipeline-monitor'
import { logger } from '@/lib/logger'
import { runConnectorBatch } from '@/lib/connectors/connector-db-adapter'
import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'

export const dynamic = 'force-dynamic'
export const maxDuration = 600 // Vercel Pro max: 10 minutes (was 300s = 5min)
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX/Bybit geo-blocking

const GROUPS: Record<string, string[]> = {
  // Group A1: Binance (every 3h) — 2 platforms, parallel ~120s
  a: ['binance_futures', 'binance_spot'],
  // Group A2: Other high-priority CEX (every 3h)
  // bybit restored 2026-03-13: VPS Playwright scraper confirmed working (retCode:0)
  a2: ['bitget_futures', 'okx_futures', 'bybit'],
  // Group B: Top DEX (every 4h) — 3 platforms, ~110s parallel
  b: ['hyperliquid', 'gmx', 'jupiter_perps'],
  // Group C: Mid-priority (every 4h) — 3 platforms, ~70s parallel
  c: ['okx_web3', 'aevo', 'xt'],
  // Group D1: CEX (every 6h) — 2 platforms, parallel
  d1: ['gains', 'htx_futures'],
  // Group D2: DEX only (every 6h) — 1 platform (bybit_spot removed: api2.bybit.com 404 globally 2026-03-13)
  d2: ['dydx'], // bybit_spot removed from array 2026-03-13
  // Group E: CEX+DEX (every 6h) — 3 platforms (bitfinex: 1424 traders, was orphaned)
  e: ['coinex', 'binance_web3', 'bitfinex'],
  // Group F: Slow CEX (every 6h) — 2 platforms, parallel (~141s + ~60s = ~200s)
  f: ['mexc', 'bingx'],
  // Group H: Fast CEX (every 6h) — 2 platforms, parallel (~25s each)
  h: ['gateio', 'btcc'],
  // Group G1: DEX (every 6h) — 2 platforms, parallel
  g1: ['drift', 'bitunix'],
  // Group G2: DEX+CEX (every 6h) — 3 platforms
  // paradex removed: API now requires JWT auth since 2026-03
  // kwenta removed: Copin API stopped serving Kwenta data (2026-03-11)
  // blofin removed: openapi.blofin.com requires auth, VPS scraper endpoint missing (2026-03-11)
  // bitget_spot restored 2026-03-13: Connector with VPS scraper + direct API fallback
  g2: ['web3_bot', 'toobit', 'bitget_spot'],
  // Group I: Social trading (every 6h) — large dataset (2000 traders × 3 periods)
  i: ['etoro'],
}

interface BatchResult {
  platform: string
  status: 'success' | 'error'
  durationMs: number
  totalSaved?: number
  error?: string
  via?: 'connector' | 'inline'
}

/**
 * All active platforms now use the Connector framework.
 * Inline Fetcher is kept only as automatic fallback if a connector
 * is not found in the registry (e.g., newly added platform not yet registered).
 *
 * Migration completed 2026-03-13: all 24 active platforms switched.
 * DEAD_BLOCKED_PLATFORMS are skipped by cron groups (not in any group).
 */

/**
 * Map source names (used in cron groups) to connector registry keys.
 * Source names like 'htx_futures' map to connector platform 'htx' + marketType 'futures'.
 * Most DEX sources map to marketType 'perp', CEX to 'futures' or 'spot'.
 */
const SOURCE_TO_CONNECTOR: Record<string, { platform: string; marketType: string }> = {
  binance_futures: { platform: 'binance', marketType: 'futures' },
  binance_spot: { platform: 'binance_spot', marketType: 'spot' },
  binance_web3: { platform: 'binance_web3', marketType: 'web3' },
  bitget_futures: { platform: 'bitget', marketType: 'futures' },
  bitget_spot: { platform: 'bitget_spot', marketType: 'spot' },
  okx_futures: { platform: 'okx', marketType: 'futures' },
  okx_web3: { platform: 'okx_web3', marketType: 'web3' },
  htx_futures: { platform: 'htx', marketType: 'futures' },
  mexc: { platform: 'mexc', marketType: 'futures' },
  coinex: { platform: 'coinex', marketType: 'futures' },
  bingx: { platform: 'bingx', marketType: 'futures' },
  gateio: { platform: 'gateio', marketType: 'futures' },
  xt: { platform: 'xt', marketType: 'futures' },
  blofin: { platform: 'blofin', marketType: 'futures' },
  btcc: { platform: 'btcc', marketType: 'futures' },
  bitunix: { platform: 'bitunix', marketType: 'futures' },
  bitfinex: { platform: 'bitfinex', marketType: 'futures' },
  toobit: { platform: 'toobit', marketType: 'futures' },
  etoro: { platform: 'etoro', marketType: 'spot' },
  bybit: { platform: 'bybit', marketType: 'futures' },
  hyperliquid: { platform: 'hyperliquid', marketType: 'perp' },
  gmx: { platform: 'gmx', marketType: 'perp' },
  dydx: { platform: 'dydx', marketType: 'perp' },
  gains: { platform: 'gains', marketType: 'perp' },
  jupiter_perps: { platform: 'jupiter_perps', marketType: 'perp' },
  aevo: { platform: 'aevo', marketType: 'perp' },
  drift: { platform: 'drift', marketType: 'perp' },
  web3_bot: { platform: 'web3_bot', marketType: 'web3' },
}

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

  // Run a single platform: Connector first, Inline Fetcher fallback
  async function runPlatform(platform: string): Promise<BatchResult> {
    const start = Date.now()

    // Try Connector path first
    const mapping = SOURCE_TO_CONNECTOR[platform]
    const connector = (mapping && connectorsInitialized)
      ? connectorRegistry.get(
          mapping.platform as import('@/lib/types/leaderboard').LeaderboardPlatform,
          mapping.marketType as import('@/lib/types/leaderboard').MarketType
        )
      : null

    if (!connector) {
      // No connector registered → fall back to inline fetcher
      if (mapping) {
        logger.warn(`[batch-fetch-traders-${group}] No connector for ${platform}:${mapping.marketType}, falling back to inline`)
      }
      return runPlatformInline(platform, start)
    }

    // --- Connector path ---
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

  // Inline Fetcher path (extracted for reuse and connector fallback)
  async function runPlatformInline(platform: string, start: number): Promise<BatchResult> {
    const fetcher = getInlineFetcher(platform)
    if (!fetcher) {
      return { platform, status: 'error', durationMs: Date.now() - start, error: `No fetcher for ${platform}`, via: 'inline' }
    }

    const result = await Promise.race([
      fetcher(supabase, ['7D', '30D', '90D']),
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
      metadata: { periods: result.periods, batchGroup: group, via: 'inline' },
    })

    logger.info(`[batch-fetch-traders-${group}] ${platform} (inline): saved=${totalSaved} duration=${Date.now() - start}ms`)

    if (hasErrors && totalSaved === 0) {
      const errDetail = Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
      return { platform, status: 'error', durationMs: Date.now() - start, totalSaved, error: errDetail, via: 'inline' }
    }
    return { platform, status: 'success', durationMs: Date.now() - start, totalSaved, via: 'inline' }
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
