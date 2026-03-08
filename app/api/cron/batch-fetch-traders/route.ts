/**
 * Batch fetch-traders dispatcher
 *
 * Calls fetcher functions DIRECTLY (in-process) instead of via HTTP,
 * avoiding Cloudflare timeouts and Vercel deployment protection issues.
 *
 * Query params:
 *   group=a  → binance_futures, binance_spot (every 3h)
 *   group=a2 → bybit, bitget_futures, okx_futures (every 3h)
 *   group=b  → hyperliquid, gmx, jupiter_perps (every 4h)
 *   group=c  → okx_web3, aevo, xt (every 4h)
 *   group=d  → gains, htx_futures, dydx, bybit_spot, toobit (every 6h)
 *   group=e  → coinex, binance_web3 (every 6h)
 *   group=f  → mexc, bingx (every 6h)
 *   group=h  → gateio, bitmart (every 6h)
 *   group=g  → drift, bitunix, web3_bot, uniswap, pancakeswap, paradex (every 6h)
 *
 * Dead/blocked platforms removed:
 *   - kucoin: APIs return 404, feature discontinued
 *   - lbank: needs session auth, crashes headless browser
 *   - bitget_spot: no public API (all endpoints return 404)
 *   - blofin: needs credentials (BLOFIN env vars not set)
 *   - phemex: CloudFront blocks all our IPs (VPS SG, Vercel hnd1, scraper) since ~2026-03-06
 *   - weex: copy-trade API returning 521 (origin down) since 2026-03
 *   - mux: requires THEGRAPH_API_KEY (not set), Copin has 0 traders
 *   - kwenta: Copin stale (last data April 2025), TheGraph needs API key
 *   - synthetix: Copin stale (last data April 2025), TheGraph needs API key
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { getInlineFetcher } from '@/lib/cron/fetchers'
import { createSupabaseAdmin } from '@/lib/cron/utils'
import { recordFetchResult } from '@/lib/utils/pipeline-monitor'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX/Bybit geo-blocking

const GROUPS: Record<string, string[]> = {
  // Group A1: Binance (every 3h) — 2 platforms, parallel ~120s
  a: ['binance_futures', 'binance_spot'],
  // Group A2: Other high-priority CEX (every 3h) — 3 platforms, parallel ~100s
  a2: ['bybit', 'bitget_futures', 'okx_futures'],
  // Group B: Top DEX (every 4h) — 3 platforms, ~110s parallel
  b: ['hyperliquid', 'gmx', 'jupiter_perps'],
  // Group C: Mid-priority (every 4h) — 3 platforms, ~70s parallel
  c: ['okx_web3', 'aevo', 'xt'],
  // Group D: CEX+DEX (every 6h) — 5 platforms (phemex: CloudFront blocked)
  d: ['gains', 'htx_futures', 'dydx', 'bybit_spot', 'toobit'],
  // Group E: Lower-priority DEX (every 6h) — 2 platforms
  e: ['coinex', 'binance_web3'],
  // Group F: Slow CEX (every 6h) — 2 platforms, parallel (~141s + ~60s = ~200s)
  f: ['mexc', 'bingx'],
  // Group H: Fast CEX (every 6h) — 2 platforms, parallel (~25s each)
  h: ['gateio', 'bitmart'],
  // Group G: New CEX + DEX (every 6h) — 6 platforms
  g: ['drift', 'bitunix', 'web3_bot', 'uniswap', 'pancakeswap', 'paradex'],
}

interface BatchResult {
  platform: string
  status: 'success' | 'error'
  durationMs: number
  totalSaved?: number
  error?: string
}

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

  // Per-platform timeout: 240s leaves 60s buffer for logging/cleanup within 300s limit
  const PLATFORM_TIMEOUT_MS = 240_000

  // Run a single platform fetch and return the result
  async function runPlatform(platform: string): Promise<BatchResult> {
    const start = Date.now()
    try {
      const fetcher = getInlineFetcher(platform)
      if (!fetcher) {
        return { platform, status: 'error', durationMs: Date.now() - start, error: `No fetcher for ${platform}` }
      }

      // Wrap fetcher in a timeout to prevent stuck jobs
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
        metadata: { periods: result.periods, batchGroup: group },
      })

      logger.info(`[batch-fetch-traders-${group}] ${platform}: saved=${totalSaved} duration=${Date.now() - start}ms`)

      if (hasErrors && totalSaved === 0) {
        const errDetail = Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
        return { platform, status: 'error', durationMs: Date.now() - start, totalSaved, error: errDetail }
      }
      return { platform, status: 'success', durationMs: Date.now() - start, totalSaved }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(`[batch-fetch-traders-${group}] ${platform} error: ${errMsg}`)

      try {
        await recordFetchResult(supabase, platform, {
          success: false, durationMs: Date.now() - start, recordCount: 0, error: errMsg,
        })
      } catch (metricErr) {
        logger.warn(`[batch-fetch-traders-${group}] Failed to record metric for ${platform}`, { error: metricErr instanceof Error ? metricErr.message : String(metricErr) })
      }

      return { platform, status: 'error', durationMs: Date.now() - start, error: errMsg }
    }
  }

  // Small groups (≤3): run in parallel to maximize use of 300s budget
  // Large groups: run sequentially with delays to avoid upstream rate limits
  let results: BatchResult[]
  if (platforms.length <= 3) {
    results = await Promise.all(platforms.map(runPlatform))
  } else {
    results = []
    for (const platform of platforms) {
      results.push(await runPlatform(platform))
      if (platforms.indexOf(platform) < platforms.length - 1) {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

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
