/**
 * Batch fetch-traders dispatcher
 *
 * Calls fetcher functions DIRECTLY (in-process) instead of via HTTP,
 * avoiding Cloudflare timeouts and Vercel deployment protection issues.
 *
 * Query params:
 *   group=a  → binance_futures, binance_spot (every 3h)
 *   group=a2 → okx_futures (every 3h, via VPS proxy)
 *   group=a3 → bybit (every 3h, VPS scraper)
 *   group=a4 → bitget_futures (every 3h, VPS scraper)
 *   group=b  → hyperliquid, gmx (every 4h)
 *   group=c  → bitunix (every 4h)
 *   group=d1 → gains, htx_futures (every 6h)
 *   group=e  → bitfinex, coinex, binance_web3 (every 6h)
 *   group=e2 → okx_web3 (every 6h, slow platform, separated to avoid timeout)
 *   group=f  → mexc (every 6h, VPS scraper)
 *   group=f2 → bingx (every 6h, VPS scraper)
 *   group=h  → gateio, btcc (every 6h)
 *   group=g1 → drift, jupiter_perps, aevo (every 6h)
 *   group=g2 → web3_bot, toobit, xt, crypto_com (every 6h)
 *   group=i  → etoro, dydx (every 6h)
 * Dead/blocked platforms:
 *   kucoin, mux, synthetix, bitmart, weex,
 *   whitebit, btse, pionex, vertex, okx_spot, paradex
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
import * as cache from '@/lib/cache'
import { sendAlert } from '@/lib/alerts/send-alert'
import { env } from '@/lib/env'
import { validatePlatform } from '@/lib/config/platforms'

const DEAD_COUNTER_PREFIX = 'dead:consecutive:'
const DEAD_COUNTER_TTL = 7 * 24 * 60 * 60 // 7 days in seconds
const DEAD_THRESHOLD = 10 // consecutive failures before alerting

export const dynamic = 'force-dynamic'
export const maxDuration = 800 // Vercel Pro max: 10 minutes (was 300s = 5min)
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX/Bybit geo-blocking

const GROUPS: Record<string, string[]> = {
  // Group A: Binance (every 3h) — new /friendly/ API via VPS proxy (2026-03-15)
  a: ['binance_futures', 'binance_spot'],
  // Group A2: OKX futures + spot (every 3h) — direct API works
  a2: ['okx_futures', 'okx_spot'],
  // Group A3: Bybit futures + spot (every 3h) — VPS scraper
  a3: ['bybit', 'bybit_spot'],
  // Group A4: Bitget (every 3h) — leaderboard fetch only, enrichment disabled (detail API hangs)
  a4: ['bitget_futures'],
  // Group B: Top DEX (every 4h) + GMX (switched to subgraph 2026-03-15)
  b: ['hyperliquid', 'gmx'],
  // Group C: Mid-priority (every 4h) — okx_futures moved to a2, bitunix re-enabled
  c: ['bitunix'],
  // Group D1: CEX (every 6h) — VPS proxy enabled
  d1: ['gains', 'htx_futures'],
  // Group E: Fast CEX+DEX (every 6h) — coinex URL fixed + VPS proxy
  e: ['bitfinex', 'coinex', 'binance_web3'],
  // Group E2: OKX Web3 only (every 6h) — slow platform, separated to avoid timeout
  e2: ['okx_web3'],
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
  // crypto_com: REMOVED — copy-trading feature shut down, /exchange/copy-trading redirects to /exchange/ — 2026-03-19
  // Group I: Social trading + restored platforms (every 6h)
  i: ['etoro', 'dydx'],
  // Group K: Restored via VPS scraper (every 6h) — new APIs discovered 2026-03-19
  k: ['kucoin', 'weex'],
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
  const cronSecret = env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const group = request.nextUrl.searchParams.get('group') || 'a'
  const groupPlatforms = GROUPS[group]
  if (!groupPlatforms) {
    return NextResponse.json({ error: `Unknown group: ${group}`, available: Object.keys(GROUPS) }, { status: 400 })
  }
  // Randomize execution order to prevent timing pattern detection (DeFiLlama pattern)
  const platforms = [...groupPlatforms].sort(() => Math.random() - 0.5)

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
      await plog.error(new Error('Safety timeout: function approaching 800s limit'))
    } catch { /* best effort */ }
  }, 780_000) // Was 280s, now 580s for 800s maxDuration

  // Per-platform timeout: configurable, default 700s for scraper groups buffer for logging/cleanup within 800s limit
  const PLATFORM_TIMEOUT_MS = parseInt(process.env.PLATFORM_FETCH_TIMEOUT_MS || '750000', 10)

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
    
    // 🚨 Blacklist check - prevent disabled platforms
    try {
      validatePlatform(platform)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(`[${platform}] ${errMsg}`)
      return { platform, status: 'error', error: errMsg, durationMs: 0 }
    }

    const mapping = SOURCE_TO_CONNECTOR_MAP[platform]
    const connector = mapping
      ? await connectorRegistry.getOrInit(
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
        // Track consecutive failure for dead platform detection
        const deadKey = `${DEAD_COUNTER_PREFIX}${platform}`
        const count = await cache.incr(deadKey) ?? 0
        if (count === 1) await cache.set(deadKey, count, { ttl: DEAD_COUNTER_TTL, skipMemory: true })
        if (count >= DEAD_THRESHOLD) {
          sendAlert({ title: `Dead platform detected: ${platform}`, message: `${platform} has failed ${count} consecutive times. Consider adding to DEAD_BLOCKED_PLATFORMS.`, level: 'critical', details: { platform, consecutiveFailures: count, group } }).catch(() => {})
        }
        const errDetail = Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
        return { platform, status: 'error', durationMs: Date.now() - start, totalSaved, error: errDetail, via: 'connector' }
      }

      // Success: reset dead platform counter
      cache.del(`${DEAD_COUNTER_PREFIX}${platform}`).catch(() => {})

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

      // Track consecutive failure for dead platform detection
      const deadKey = `${DEAD_COUNTER_PREFIX}${platform}`
      const count = await cache.incr(deadKey) ?? 0
      if (count === 1) await cache.set(deadKey, count, { ttl: DEAD_COUNTER_TTL, skipMemory: true })
      if (count >= DEAD_THRESHOLD) {
        sendAlert({ title: `Dead platform detected: ${platform}`, message: `${platform} has failed ${count} consecutive times. Consider adding to DEAD_BLOCKED_PLATFORMS.\nLast error: ${errMsg.substring(0, 200)}`, level: 'critical', details: { platform, consecutiveFailures: count, group } }).catch(() => {})
      }

      return { platform, status: 'error', durationMs: Date.now() - start, error: errMsg, via: 'connector' }
    }
  }

  // Run platforms with concurrency limit (DeFiLlama PromisePool pattern)
  // Prevents overwhelming VPS proxy with too many concurrent scraper requests
  const CONCURRENCY = Math.min(platforms.length, 3) // Max 3 concurrent
  const results: BatchResult[] = []
  for (let i = 0; i < platforms.length; i += CONCURRENCY) {
    const batch = platforms.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(runPlatform))
    results.push(...batchResults)
  }

  clearTimeout(safetyTimer)
  const succeeded = results.filter((r) => r.status === 'success').length
  const failed = results.length - succeeded

  if (failed === 0) {
    await plog.success(succeeded, { results })
  } else if (succeeded > 0) {
    // Partial success: some platforms failed but others worked — log as success with warning
    await plog.success(succeeded, { results, warning: `${failed}/${results.length} platforms failed` })
  } else {
    // Total failure: all platforms failed
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
