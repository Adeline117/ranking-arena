/**
 * Batch fetch-traders dispatcher
 *
 * Calls fetcher functions DIRECTLY (in-process) instead of via HTTP,
 * avoiding Cloudflare timeouts and Vercel deployment protection issues.
 *
 * Query params:
 *   group=a  → binance_futures, binance_spot (every 3h)
 *   group=a2 → bybit, bitget_futures, okx_futures (every 3h)
 *   group=b  → hyperliquid, gmx (every 4h)
 *   group=c  → okx_futures (every 4h)
 *   group=d1 → gains, htx_futures (every 6h)
 *   group=d2 → EMPTY (dydx DEAD since 2026-03)
 *   group=e  → bitfinex, coinex, binance_web3 (every 6h)
 *   group=f  → mexc, bingx (every 6h)
 *   group=h  → gateio, btcc (every 6h)
 *   group=g1 → drift, jupiter_perps (every 6h)
 *   group=g2 → web3_bot, toobit (every 6h)
 *   group=i  → etoro (every 6h)
 *
 * Dead/blocked platforms:
 *   kucoin, mux, synthetix, bitmart,
 *   whitebit, btse, cryptocom, pionex, vertex, okx_spot, paradex
 * Mac Mini only (crontab feeds data directly):
 *   phemex (CloudFront blocks VPS), lbank (browser crashes on VPS), blofin (API needs auth)
 * Restored 2026-03-15:
 *   dydx (via Copin API), gmx (via Subsquid), htx (via futures.htx.com)
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
  // Group A: Binance (every 3h) — new /friendly/ API via VPS proxy (2026-03-15)
  a: ['binance_futures', 'binance_spot'],
  // Group A2: OKX only (every 3h) — direct API works
  a2: ['okx_futures'],
  // Group A3: Bybit (every 3h) — VPS scraper, needs own group (Playwright slow)
  a3: ['bybit'],
  // Group A4: Bitget (every 3h) — VPS scraper, needs own group
  a4: ['bitget_futures'],
  // Group B: Top DEX (every 4h) + GMX (switched to subgraph 2026-03-15)
  b: ['hyperliquid', 'gmx'],
  // Group C: Mid-priority (every 4h) — okx_futures moved to a2, bitunix re-enabled
  c: ['bitunix'],
  // Group D1: CEX (every 6h) — VPS proxy enabled
  d1: ['gains', 'htx_futures'],
  // Group E: CEX+DEX (every 6h) — coinex URL fixed + VPS proxy
  e: ['bitfinex', 'coinex', 'binance_web3'],
  // Group F: MEXC only (every 6h) — VPS scraper, slow
  f: ['mexc'],
  // Group F2: BingX (every 6h) — VPS scraper
  f2: ['bingx'],
  // Group H: CEX (every 6h) — VPS proxy enabled 2026-03-15
  h: ['gateio', 'btcc'],
  // Group G1: DEX (every 6h)
  g1: ['drift', 'jupiter_perps', 'aevo'],
  // Group G2: DEX+CEX+scraper (every 6h)
  g2: ['web3_bot', 'toobit', 'xt'],
  // Group J: Restored via VPS scraper (every 6h)
  j: ['weex'],
  // Group I: Social trading + restored platforms (every 6h)
  // dYdX restored via Copin API (2026-03-15)
  // blofin/phemex: Mac Mini feeds data, connector as backup
  i: ['etoro', 'dydx'],
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
