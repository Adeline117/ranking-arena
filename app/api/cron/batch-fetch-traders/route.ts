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
 *   group=e1 → drift, aevo, web3_bot, toobit (every 8h)
 *   group=e2 → jupiter_perps, xt, etoro (every 8h, +2min stagger)
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
// Circuit breaker: skip platforms after N consecutive zero-trader fetches.
// Was threshold=20, max_age=30min — but since cron intervals are 1-8h,
// the 30min auto-reset meant the counter ALWAYS reset between runs and
// could never reach 20. The circuit breaker was effectively a no-op.
// Fix: threshold=3 (reasonable for 1-8h intervals), max_age=12h (retry daily).
const DEAD_THRESHOLD = 3
const DEAD_COUNTER_MAX_AGE_MS = 12 * 60 * 60 * 1000 // 12h — retry after half a day

export const runtime = 'nodejs' // Required: edge runtime has 30s timeout, nodejs supports maxDuration
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Vercel Pro: 300s max for serverless functions
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX/Bybit geo-blocking

const GROUPS: Record<string, string[]> = {
  // Group A1: Binance (every 3h) — split to fit 300s maxDuration
  a1: ['binance_futures', 'binance_spot'],
  // Group A2: OKX (every 3h)
  a2: ['okx_futures', 'okx_spot'],
  // Group B1: Bybit futures only (VPS Playwright scraper, slow ~30s/page)
  // bybit_spot split to b1b to avoid 300s Vercel timeout (was sequential 240s+180s=420s)
  b1: ['bybit'],
  // Group B1B: Bybit spot (separated to fit 300s limit)
  b1b: ['bybit_spot'],
  // Group B2: Bitget (VPS proxy, faster)
  // bitget_spot: DEAD (permanently disabled, no leaderboard API)
  b2: ['bitget_futures'],
  // Group C: DEX (every 4h) — GMX (subgraph), Bitunix
  c: ['gmx', 'bitunix'],
  // Group C_HL: Hyperliquid solo (every 1h) — #1 DEX by trader count (33K+), API has 99.98% rate limit headroom
  c_hl: ['hyperliquid'],
  // Group D1: Fast CEX (every 6h) — split from old group d (8 was too many, caused 524 timeout)
  // gains resurrected 2026-04-08 — now uses /open-trades endpoint (leaderboard was 404)
  // 2026-04-09: SPLIT into d1a/d1b — 4 platforms × ~120s each was tripping the
  //   280s safety timeout (gains 90s, htx 120s, bitfinex 90s, coinex 120s).
  //   `d1` kept as a legacy alias for any manual invocations / backfills.
  d1: ['gains', 'htx_futures', 'bitfinex', 'coinex'],
  d1a: ['gains', 'bitfinex'],
  d1b: ['htx_futures', 'coinex'],
  // Group D2: Web3 + Gate.io + BTCC (every 6h)
  d2: ['binance_web3', 'okx_web3', 'gateio', 'btcc'],
  // Group E1: DEX + social (every 12h) — split from E (7 platforms exceeded 300s limit)
  // drift(120s) + aevo(90s) + toobit(90s) = ~120s with concurrency=3
  // web3_bot: REMOVED — excluded from scoring (commit 51d8de5fc), zero ranking impact
  e1: ['drift', 'aevo', 'toobit'],
  // Group E2: CEX scrapers (every 8h) — jupiter + xt + etoro
  // jupiter(90s) + xt(90s) + etoro(90s) = ~90s with concurrency=3
  e2: ['jupiter_perps', 'xt', 'etoro'],
  // Group F: VPS scraper slow platforms (every 6h)
  // bingx: DEAD (empty_data)
  // weex: RE-ENABLED — 117 traders in leaderboard, fresh data in snapshots_v2
  // 2026-04-09: SPLIT into f1/f2 — 5 platforms at concurrency=3 plus VPS pool
  //   contention was tripping the 280s safety timeout. f1 = mexc/woox/polymarket
  //   (fits one concurrency round), f2 = copin/weex (slow scrapers).
  //   `f` kept as a legacy alias for any manual invocations / backfills.
  f: ['mexc', 'woox', 'polymarket', 'copin', 'weex'],
  f1: ['mexc', 'woox', 'polymarket'],
  f2: ['copin', 'weex'],
  // Group G: Copin + Mac Mini (every 8h)
  // bingx_spot: DEAD (no leaderboard), phemex: DEAD (API 404)
  // lbank: DEAD (API 404 since 2026-04, copy-trading endpoint removed)
  // kucoin: moved to VPS scraper-cron (Vercel hnd1 IP blocked by KuCoin)
  // blofin: moved to Mac Mini crontab (CF challenge requires headless:new Chrome)
  // dydx: RECOVERED 2026-03-31 via Copin API (3339 traders)
  g: ['dydx'],
}

// Per-platform leaderboard limits — override the default 2000
// Binance: 20/page via VPS proxy (~2s/page) → 10 pages × 3 windows × 2s = 60s
// Was 500 (75 VPS calls = 150s+) which caused persistent timeouts since 2026-04-04
const PLATFORM_LIMITS: Record<string, number> = {
  // Binance: reduced from 200 to 100 — 200 caused 23 errors/day via VPS proxy timeout
  // 100 traders × 3 windows = 15 pages × 2s = ~30s (well within 150s timeout)
  binance_futures: 100,
  binance_spot: 100,
  // VPS scraper: pool=5 browsers, ~30s/page. Keep limit low to avoid saturating pool.
  // Was 100 → 100 traders × 3 windows = ~6 VPS calls, each takes 30-120s.
  // With pool=5 and queue, this creates 30+ minutes of VPS work per job.
  // Reduced to 50: 50 traders × 3 windows = ~3 VPS calls = ~90s (fits 240s timeout)
  bybit: 50,
  bybit_spot: 50,
  // Copin API has max 1000 traders per statisticType — no point requesting 2000
  dydx: 1000,
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
  // Single-window mode: ?windows=7D to only fetch one window (Phase 4: staggered refresh)
  // Reduces per-run time by 66% while maintaining same refresh frequency per window
  const windowsParam = request.nextUrl.searchParams.get('windows')
  const windowFilter = windowsParam ? windowsParam.split(',').map(w => w.trim().toLowerCase()) : null
  // Manual circuit breaker reset: ?reset=bybit to clear dead counter before running
  const resetPlatform = request.nextUrl.searchParams.get('reset')
  if (resetPlatform) {
    try {
      await PipelineState.del(`${DEAD_COUNTER_PREFIX}${resetPlatform}`)
      logger.info(`[batch-fetch-traders] Manual reset of dead counter for ${resetPlatform}`)
    } catch { /* non-blocking */ }
  }

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

  // Safety timeout: ensure plog gets called before Vercel kills the function at 300s.
  // 2026-04-09: track via plogFinalized so the post-completion finalization
  // (success/partialSuccess/error below) does not double-log on top of the
  // safety-timeout entry. Without this we got both a "Safety timeout" error
  // log AND a subsequent success log for the same run, polluting alerts.
  let plogFinalized = false
  const safetyTimer = setTimeout(async () => {
    if (plogFinalized) return
    plogFinalized = true
    try {
      await plog.error(new Error('Safety timeout: function approaching 300s limit'))
    } catch { /* best effort */ }
  }, 280_000) // 280s safety margin for 300s maxDuration

  // Per-platform timeout: FIXED to prevent cascade timeouts
  // 2026-04-03: Dynamic timeout caused issues - bybit 140s still too short, others wasted time
  // FIX: Use platform-specific timeouts based on actual performance data:
  //   - VPS scrapers (bybit): 180s (Playwright slow ~30s/page × 6 windows)
  //   - Fast CEX APIs: 60s (direct API calls)
  //   - Medium CEX: 90s (some need more time)
  const PLATFORM_TIMEOUT_MS = 90000 // Default: 90s for most platforms

  // Initialize all connectors (once per cold start)
  if (!connectorsInitialized) {
    try {
      await initializeConnectors()
      connectorsInitialized = true
    } catch (err) {
      logger.error(`[batch-fetch-traders-${group}] Failed to initialize connectors: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Platform-specific timeouts (2026-04-06 audit: many platforms were timing out)
  // Rule: timeout = 1.5× observed p95 duration. VPS-dependent platforms need more.
  const PLATFORM_TIMEOUTS: Record<string, number> = {
    // VPS Playwright scrapers: very slow (30s/page × multiple windows)
    bybit: 240000,
    bybit_spot: 180000,
    // VPS proxy paginated: Binance 200 traders × 3 windows via proxy
    binance_futures: 150000,
    binance_spot: 150000,
    // VPS proxy: need extra headroom for proxy latency
    okx_futures: 120000,
    mexc: 120000,
    bitget_futures: 200000, // Was 120s: 3 windows × 1 VPS call/window × 60s = 180s needed
    // DEX subgraph/API: sometimes slow due to chain indexer lag
    hyperliquid: 240000, // Was 120s — HL API consistently >120s with 2000 trader limit
    gmx: 120000,
    drift: 120000,
    // Medium APIs
    htx_futures: 120000,
    gateio: 120000,
    okx_web3: 120000,
    // Fast direct APIs
    okx_spot: 120000, // Was 60s — too tight: fetch + enrich both need budget. Observed enrich timing out at 22s
    bitunix: 180000, // Was 120s but observed 137s during outage — 180s gives 30% headroom
    coinex: 120000,  // Was 90s — same enrichment squeeze pattern
    dydx: 240000, // Copin API: 500/page × 2 pages × 3 windows + DB writes (upsert 3000 rows). Needs generous timeout.
    // Platforms that timed out at 90s default (pipeline health 2026-04-13):
    gains: 120000, // /open-trades endpoint can be slow; 4 enrichment timeouts in 48h
    etoro: 120000, // sapi rankings can be slow; 4 enrichment timeouts in 48h
    weex: 150000,  // VPS scraper, described as "slow" in group comments
    // Others: default 90s (PLATFORM_TIMEOUT_MS)
  }

  // Run a single platform via Connector
  async function runPlatform(platform: string): Promise<BatchResult> {
    const start = Date.now()
    const timeoutMs = PLATFORM_TIMEOUTS[platform] || PLATFORM_TIMEOUT_MS

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
        runConnectorBatch(connector, { supabase, windows: windowFilter || ['7d', '30d', '90d'], sourceOverride: platform, platformTimeBudgetMs: timeoutMs, limit: PLATFORM_LIMITS[platform], configuredLimit: PLATFORM_LIMITS[platform] }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Platform ${platform} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
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

      // Per-platform count drop detection: alert if >50% drop from last known good
      if (totalSaved > 0) {
        const lastCountKey = `fetch:last-count:${platform}`
        PipelineState.get(lastCountKey).then(async (prev) => {
          const prevCount = typeof prev === 'number' ? prev : 0
          if (prevCount > 50 && totalSaved < prevCount * 0.5) {
            await sendRateLimitedAlert({
              title: `${platform} count dropped ${Math.round((1 - totalSaved / prevCount) * 100)}%`,
              message: `${platform}: ${prevCount} → ${totalSaved} traders (${Math.round((1 - totalSaved / prevCount) * 100)}% drop). May indicate API change or partial outage.`,
              level: 'warning',
              details: { platform, prevCount, newCount: totalSaved, group },
            }, `count-drop:${platform}`, 3 * 3600 * 1000)
          }
          await PipelineState.set(lastCountKey, totalSaved)
        }).catch(err => logger.warn(`[batch-fetch-traders-${group}] Count drop tracking failed for ${platform}`, { error: err instanceof Error ? err.message : String(err) }))
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
    const batchResults: BatchResult[] = await Promise.all(batch.map(async (platform): Promise<BatchResult> => {
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

  if (plogFinalized) {
    // Safety timer already wrote a "Safety timeout" entry — don't double-log.
    logger.warn(`[batch-fetch-traders-${group}] Skipping plog finalization, safety timer already finalized`)
  } else {
    plogFinalized = true
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
