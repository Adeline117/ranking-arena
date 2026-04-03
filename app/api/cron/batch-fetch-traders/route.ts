/**
 * Batch fetch-traders dispatcher
 *
 * Calls fetcher functions DIRECTLY (in-process) instead of via HTTP,
 * avoiding Cloudflare timeouts and Vercel deployment protection issues.
 *
 * Consolidated from 18 groups → 6 super-groups (2026-03-31):
 *   group=a → binance_futures, binance_spot, okx_futures, okx_spot (every 3h, fast direct APIs)
 *   group=b → bybit, bybit_spot, bitget_futures (every 3h, VPS scraper)
 *   group=c → hyperliquid, gmx, bitunix (every 4h, DEX + fast CEX)
 *   group=d → gains, htx_futures, bitfinex, coinex, binance_web3, okx_web3, gateio, btcc (every 6h)
 *   group=e → drift, jupiter_perps, aevo, web3_bot, toobit, xt, etoro, dydx (every 6h)
 *   group=f → mexc, bingx, weex, woox, polymarket, copin (every 6h, VPS scraper slow)
 * Dead/blocked platforms:
 *   kucoin (copy trading discontinued 2026-03), bingx (empty data 2026-04), bingx_spot,
 *   weex (enrichment 75% fail rate), vertex (no API), apex_pro (no API), rabbitx (DNS dead),
 *   dydx (API 404), mux, synthetix, bitmart, whitebit, btse, pionex, paradex
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
import { runConnectorBatch } from '@/lib/pipeline/connector-db-adapter'
import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'
import { SOURCE_TO_CONNECTOR_MAP } from '@/lib/constants/exchanges'
import { PipelineState } from '@/lib/services/pipeline-state'
import { PipelineCheckpoint } from '@/lib/harness/pipeline-checkpoint'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { env } from '@/lib/env'
import { validatePlatform } from '@/lib/config/platforms'
import { triggerDownstreamRefresh } from '@/lib/cron/trigger-chain'

const DEAD_COUNTER_PREFIX = 'dead:consecutive:'
const DEAD_THRESHOLD = 10 // consecutive failures before circuit-breaking (restored from 3 — was causing cascade skips)
const DEAD_COUNTER_MAX_AGE_MS = 6 * 3600 * 1000 // Auto-reset counters older than 6h

export const runtime = 'nodejs' // Required: edge runtime has 30s timeout, nodejs supports maxDuration
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Vercel Pro: 300s max for serverless functions
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX/Bybit geo-blocking

const GROUPS: Record<string, string[]> = {
  // Group A1: Binance (every 3h) — split to fit 300s maxDuration
  a1: ['binance_futures', 'binance_spot'],
  // Group A2: OKX (every 3h)
  a2: ['okx_futures', 'okx_spot'],
  // Group B1: Bybit (VPS Playwright scraper, slow ~20-30s/page) — split for longer per-platform timeout
  b1: ['bybit', 'bybit_spot'],
  // Group B2: Bitget (VPS proxy, faster)
  b2: ['bitget_futures', 'bitget_spot'],
  // Group C: DEX + fast CEX (every 4h) — Hyperliquid, GMX (subgraph), Bitunix
  c: ['hyperliquid', 'gmx', 'bitunix'],
  // Group D1: Fast CEX (every 6h) — split from old group d (8 was too many, caused 524 timeout)
  d1: ['gains', 'htx_futures', 'bitfinex', 'coinex'],
  // Group D2: Web3 + Gate.io + BTCC (every 6h)
  d2: ['binance_web3', 'okx_web3', 'gateio', 'btcc'],
  // Group E: DEX + social trading (every 6h) — Solana DEX, eToro
  // DEAD removed 2026-04-01: vertex (no API), apex_pro (no API), rabbitx (DNS dead)
  e: ['drift', 'jupiter_perps', 'aevo', 'web3_bot', 'toobit', 'xt', 'etoro'],
  // Group F: VPS scraper slow platforms (every 6h)
  // bingx: DEAD (empty_data)
  // weex: RE-ENABLED — 117 traders in leaderboard, fresh data in snapshots_v2
  f: ['mexc', 'woox', 'polymarket', 'copin', 'weex'],
  // Group G: Copin + Mac Mini (every 8h)
  // bingx_spot: DEAD (no leaderboard), phemex: DEAD (API 404)
  // kucoin: moved to VPS scraper-cron (Vercel hnd1 IP blocked by KuCoin)
  // blofin: moved to Mac Mini crontab (CF challenge requires headless:new Chrome)
  // dydx: RECOVERED 2026-03-31 via Copin API (3339 traders)
  g: ['lbank', 'dydx'],
}

// Per-platform leaderboard limits — override the default 2000
// Binance: 9000+ traders but API returns only 20/page → 100 pages × 3 windows × 0.5s = 150s (exceeds 140s timeout)
// Reduced to 500 (25 pages × 3 windows × 0.5s = 37s) — still captures top 500 per period
const PLATFORM_LIMITS: Record<string, number> = {
  binance_futures: 500,
  binance_spot: 500,
  // VPS scraper-dependent platforms: keep low to avoid queue buildup
  bybit: 200,
  bybit_spot: 200,
}

interface BatchResult {
  platform: string
  status: 'success' | 'error'
  durationMs: number
  totalSaved?: number
  error?: string
  via?: 'connector' | 'checkpoint-skip'
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
      await plog.error(new Error('Safety timeout: function approaching 300s limit'))
    } catch { /* best effort */ }
  }, 280_000) // 280s safety margin for 300s maxDuration

  // Per-platform timeout: dynamic based on group size to maximize time per platform
  // Formula: (maxDuration - safetyMargin) / platformCount, clamped to 60-140s
  const dynamicTimeout = Math.min(140000, Math.max(60000, Math.floor((300000 - 20000) / platforms.length)))
  const PLATFORM_TIMEOUT_MS = parseInt(process.env.PLATFORM_FETCH_TIMEOUT_MS || String(dynamicTimeout), 10)

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

    // Circuit breaker: skip platforms with recent consecutive failures
    // Auto-reset counters older than DEAD_COUNTER_MAX_AGE_MS to allow retry
    try {
      const deadKey = `${DEAD_COUNTER_PREFIX}${platform}`
      // Check counter age — use getByPrefix to get updated_at
      const entries = await PipelineState.getByPrefix(deadKey)
      const entry = entries.find(e => e.key === deadKey)
      if (entry) {
        const age = Date.now() - new Date(entry.updated_at).getTime()
        const recentFailures = typeof entry.value === 'number' ? entry.value : 0
        if (age > DEAD_COUNTER_MAX_AGE_MS) {
          // Counter is stale — reset it to allow retry
          logger.info(`[batch-fetch-traders-${group}] Resetting stale dead counter for ${platform} (age: ${Math.round(age / 3600000)}h, failures: ${recentFailures})`)
          await PipelineState.del(deadKey)
        } else if (recentFailures >= DEAD_THRESHOLD) {
          logger.warn(`[batch-fetch-traders-${group}] Skipping ${platform}: ${recentFailures} consecutive failures (threshold: ${DEAD_THRESHOLD})`)
          return { platform, status: 'error', durationMs: 0, error: `Skipped: ${recentFailures} consecutive failures (circuit breaker)` }
        }
      }
    } catch (err) {
      logger.warn(`[batch-fetch-traders-${group}] Failed to check dead counter for ${platform}`, { error: err instanceof Error ? err.message : String(err) })
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
        runConnectorBatch(connector, { supabase, windows: ['7d', '30d', '90d'], sourceOverride: platform, platformTimeBudgetMs: PLATFORM_TIMEOUT_MS, limit: PLATFORM_LIMITS[platform] }),
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

      // Detect broken connectors: success with 0 traders is suspicious
      if (totalSaved === 0 && !hasErrors) {
        logger.warn(`[batch-fetch-traders-${group}] ${platform}: connector returned SUCCESS but 0 traders — API may have changed`)
      }

      if ((hasErrors && totalSaved === 0) || (totalSaved === 0 && !hasErrors)) {
        // Track consecutive failure for dead platform detection
        try {
          const deadKey = `${DEAD_COUNTER_PREFIX}${platform}`
          const count = await PipelineState.incr(deadKey)
          if (count >= DEAD_THRESHOLD) {
            sendRateLimitedAlert({ title: `Dead platform detected: ${platform}`, message: `${platform} has failed ${count} consecutive times. Consider adding to DEAD_BLOCKED_PLATFORMS.`, level: 'critical', details: { platform, consecutiveFailures: count, group } }, `dead-platform:${platform}`, 12 * 60 * 60 * 1000).catch(err => logger.warn(`[batch-fetch-traders-${group}] Failed to send dead platform alert for ${platform}`, { error: err instanceof Error ? err.message : String(err) }))
          }
        } catch (counterErr) {
          logger.warn(`[batch-fetch-traders-${group}] Failed to update dead counter for ${platform}`, { error: counterErr instanceof Error ? counterErr.message : String(counterErr) })
        }
        const errDetail = Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
        return { platform, status: 'error', durationMs: Date.now() - start, totalSaved, error: errDetail, via: 'connector' }
      }

      // Success: reset dead platform counter
      PipelineState.del(`${DEAD_COUNTER_PREFIX}${platform}`).catch(err => logger.warn(`[batch-fetch-traders-${group}] State del failed for ${platform}`, { error: err instanceof Error ? err.message : String(err) }))

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
      try {
        const deadKey = `${DEAD_COUNTER_PREFIX}${platform}`
        const count = await PipelineState.incr(deadKey)
        if (count >= DEAD_THRESHOLD) {
          sendRateLimitedAlert({ title: `Dead platform detected: ${platform}`, message: `${platform} has failed ${count} consecutive times. Consider adding to DEAD_BLOCKED_PLATFORMS.\nLast error: ${errMsg.substring(0, 200)}`, level: 'critical', details: { platform, consecutiveFailures: count, group } }, `dead-platform:${platform}`, 12 * 60 * 60 * 1000).catch(err => logger.warn(`[batch-fetch-traders-${group}] Failed to send dead platform alert for ${platform}`, { error: err instanceof Error ? err.message : String(err) }))
        }
      } catch (counterErr) {
        logger.warn(`[batch-fetch-traders-${group}] Failed to update dead counter for ${platform}`, { error: counterErr instanceof Error ? counterErr.message : String(counterErr) })
      }

      return { platform, status: 'error', durationMs: Date.now() - start, error: errMsg, via: 'connector' }
    }
  }

  // ── Checkpoint: start or resume from prior crash ─────────────
  const checkpoint = await PipelineCheckpoint.startOrResume('fetch', group)
  const resumedCount = checkpoint.completed_platforms.length
  if (resumedCount > 0) {
    logger.info(`[batch-fetch-traders-${group}] Resuming from checkpoint: ${resumedCount} platforms already done (trace=${checkpoint.trace_id})`)
  }

  // Run platforms with concurrency limit (DeFiLlama PromisePool pattern)
  // Prevents overwhelming VPS proxy with too many concurrent scraper requests
  const CONCURRENCY = Math.min(platforms.length, 3) // Max 3 concurrent
  const results: BatchResult[] = []
  for (let i = 0; i < platforms.length; i += CONCURRENCY) {
    const batch = platforms.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(async (platform) => {
      // Skip platforms already completed in a prior run (checkpoint resume)
      if (PipelineCheckpoint.isCompleted(checkpoint, platform)) {
        logger.info(`[batch-fetch-traders-${group}] Skipping ${platform}: already completed in checkpoint`)
        return { platform, status: 'success' as const, durationMs: 0, totalSaved: 0, via: 'checkpoint-skip' as const }
      }

      await PipelineCheckpoint.markInProgress(checkpoint, platform)
      const result = await runPlatform(platform)

      if (result.status === 'success') {
        await PipelineCheckpoint.markCompleted(checkpoint, platform, result.totalSaved ?? 0)
      } else {
        await PipelineCheckpoint.markFailed(checkpoint, platform, result.error ?? 'unknown')
      }

      return result
    }))
    results.push(...batchResults)
  }

  clearTimeout(safetyTimer)
  const succeeded = results.filter((r) => r.status === 'success').length
  const failed = results.filter((r) => r.status === 'error').length

  // ── Finalize checkpoint → produce trace metadata for downstream ──
  const traceMetadata = await PipelineCheckpoint.finalize(checkpoint, Date.now() - overallStart)

  if (failed === 0) {
    await plog.success(succeeded, { results, trace_id: traceMetadata.trace_id })
  } else if (succeeded > 0) {
    // Partial success: some platforms failed but others worked — log as success with warning
    await plog.success(succeeded, { results, warning: `${failed}/${results.length} platforms failed`, trace_id: traceMetadata.trace_id })
  } else {
    // Total failure: all platforms failed
    await plog.error(
      new Error(`${failed}/${results.length} platforms failed`),
      { results, trace_id: traceMetadata.trace_id }
    )
  }

  // Trigger downstream refresh with trace metadata (structured handoff)
  if (succeeded > 0) {
    triggerDownstreamRefresh(`batch-fetch-traders-${group}`, traceMetadata)
  }

  return NextResponse.json({
    ok: succeeded === results.length,
    group,
    trace_id: traceMetadata.trace_id,
    platforms: platforms.length,
    succeeded,
    failed,
    resumed: resumedCount,
    totalDurationMs: Date.now() - overallStart,
    results,
  })
}
// Trigger deployment 1775071214
