/**
 * Trigger.dev Phase 2 — batch-fetch-traders fan-out tasks
 *
 * Replaces the monolithic Vercel cron `batch-fetch-traders?group=X` with
 * trigger.dev scheduled tasks that fan out to per-platform child tasks.
 *
 * Benefits over Vercel crons:
 * - 15-minute timeout per platform (vs Vercel 300s/800s limit)
 * - Automatic retry with exponential backoff (3 attempts)
 * - Per-platform observability: individual run history, logs, traces
 * - Fan-out: each platform runs as an independent child task
 * - No concurrency issues: trigger.dev manages parallelism
 *
 * Runs ALONGSIDE existing Vercel crons as canary — both systems fire
 * and we compare results. Vercel crons remain the source of truth.
 */

import {
  task,
  schedules,
  batch as triggerBatch,
  logger as triggerLogger,
} from '@trigger.dev/sdk/v3'

// ─── Platform Groups (mirrors batch-fetch-traders route.ts) ──────────────────

const PLATFORM_GROUPS: Record<string, string[]> = {
  a: ['binance_futures', 'binance_spot'],
  a2: ['okx_futures'],
  a3: ['bybit'],
  a4: ['bitget_futures'],
  b: ['hyperliquid', 'gmx'],
  c: ['bitunix'],
  d1: ['gains', 'htx_futures'],
  e: ['bitfinex', 'coinex', 'binance_web3', 'okx_web3'],
  f: ['mexc'],
  f2: ['bingx'],
  h: ['gateio', 'btcc'],
  g1: ['drift', 'jupiter_perps', 'aevo'],
  g2: ['web3_bot', 'toobit', 'xt'],
  i: ['etoro', 'dydx'],
  j: ['weex'],
}

/** All unique platforms across all groups */
const ALL_PLATFORMS = [...new Set(Object.values(PLATFORM_GROUPS).flat())]

// ─── Per-Platform Child Task ─────────────────────────────────────────────────

interface FetchPlatformPayload {
  platform: string
  group: string
}

interface FetchPlatformResult {
  platform: string
  group: string
  status: 'success' | 'error'
  totalSaved: number
  durationMs: number
  error?: string
}

export const fetchPlatformTask = task({
  id: 'fetch-platform',
  // 15 min timeout per platform (vs 300s/800s Vercel limit)
  maxDuration: 900,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 10_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
  },
  run: async (payload: FetchPlatformPayload): Promise<FetchPlatformResult> => {
    const { platform, group } = payload
    const start = Date.now()

    triggerLogger.info(`Fetching ${platform} (group ${group})`)

    // Dynamic imports to avoid loading heavy dependencies at module level
    const { runConnectorBatch } = await import(
      '@/lib/pipeline/connector-db-adapter'
    )
    const { connectorRegistry, initializeConnectors } = await import(
      '@/lib/connectors/registry'
    )
    const { SOURCE_TO_CONNECTOR_MAP } = await import(
      '@/lib/constants/exchanges'
    )
    const { createSupabaseAdmin } = await import('@/lib/cron/utils')
    const { recordFetchResult } = await import(
      '@/lib/utils/pipeline-monitor'
    )

    const supabase = createSupabaseAdmin()
    if (!supabase) {
      throw new Error('Supabase env vars missing')
    }

    // Initialize connectors
    await initializeConnectors()

    // Resolve connector
    const mapping = SOURCE_TO_CONNECTOR_MAP[platform]
    if (!mapping) {
      throw new Error(`No SOURCE_TO_CONNECTOR mapping for ${platform}`)
    }

    type LP = import('@/lib/types/leaderboard').LeaderboardPlatform
    type MT = import('@/lib/types/leaderboard').MarketType

    const connector = await connectorRegistry.getOrInit(
      mapping.platform as LP,
      mapping.marketType as MT
    )
    if (!connector) {
      throw new Error(
        `No connector registered for ${platform}:${mapping.marketType}`
      )
    }

    // Run the fetch
    const result = await runConnectorBatch(connector, {
      supabase,
      windows: ['7d', '30d', '90d'],
      limit: 500,
      sourceOverride: platform,
    })

    const hasErrors = Object.values(result.periods).some((p) => p.error)
    const totalSaved = Object.values(result.periods).reduce(
      (sum, p) => sum + (p.saved || 0),
      0
    )

    // Record fetch result for pipeline monitoring
    await recordFetchResult(supabase, result.source, {
      success: !hasErrors,
      durationMs: result.duration,
      recordCount: totalSaved,
      error: hasErrors
        ? Object.entries(result.periods)
            .filter(([, p]) => p.error)
            .map(([k, p]) => `${k}: ${p.error}`)
            .join('; ')
        : undefined,
      metadata: {
        periods: result.periods,
        batchGroup: group,
        via: 'trigger.dev',
      },
    })

    triggerLogger.info(`${platform} complete`, {
      totalSaved,
      durationMs: Date.now() - start,
      periods: result.periods,
    })

    if (hasErrors && totalSaved === 0) {
      const errDetail = Object.entries(result.periods)
        .filter(([, p]) => p.error)
        .map(([k, p]) => `${k}: ${p.error}`)
        .join('; ')
      throw new Error(`All periods failed for ${platform}: ${errDetail}`)
    }

    return {
      platform,
      group,
      status: hasErrors ? 'error' : 'success',
      totalSaved,
      durationMs: Date.now() - start,
      error: hasErrors
        ? Object.entries(result.periods)
            .filter(([, p]) => p.error)
            .map(([k, p]) => `${k}: ${p.error}`)
            .join('; ')
        : undefined,
    }
  },
})

// ─── Fan-Out Orchestrator ────────────────────────────────────────────────────

/**
 * Shared fan-out logic: triggers fetchPlatformTask for each platform in a group
 * and waits for all to complete. Used by all group schedules.
 */
async function fanOutGroup(group: string): Promise<{
  group: string
  platforms: string[]
  results: Array<{ ok: boolean; platform: string; output?: FetchPlatformResult; error?: string }>
}> {
  const platforms = PLATFORM_GROUPS[group]
  if (!platforms || platforms.length === 0) {
    throw new Error(`Unknown or empty group: ${group}`)
  }

  triggerLogger.info(`Fan-out group ${group}`, { platforms })

  // Fan out: trigger all platform tasks in parallel and wait for results
  const batchResult = await triggerBatch.triggerAndWait<typeof fetchPlatformTask>(
    platforms.map((platform) => ({
      id: 'fetch-platform',
      payload: { platform, group },
    }))
  )

  const results = batchResult.runs.map((run) => {
    if (run.ok) {
      return {
        ok: true,
        platform: run.output.platform,
        output: run.output,
      }
    }
    // Extract platform name from the payload in the run
    const platformName = platforms[batchResult.runs.indexOf(run)] ?? 'unknown'
    return {
      ok: false,
      platform: platformName,
      error: run.error instanceof Error ? run.error.message : String(run.error),
    }
  })

  const succeeded = results.filter((r) => r.ok).length
  const failed = results.length - succeeded

  triggerLogger.info(`Group ${group} complete`, {
    succeeded,
    failed,
    total: results.length,
  })

  if (failed > 0 && succeeded === 0) {
    throw new Error(
      `All ${failed} platforms failed in group ${group}: ${results
        .filter((r) => !r.ok)
        .map((r) => `${r.platform}: ${r.error}`)
        .join('; ')}`
    )
  }

  return { group, platforms, results }
}

// ─── Scheduled Tasks (one per group, matching Vercel cron schedules) ─────────

// Group A: Binance (every 3h)
export const fetchTradersGroupA = schedules.task({
  id: 'fetch-traders-group-a',
  cron: '0 */3 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('a'),
})

// Group A2: OKX (every 3h, offset 10min)
export const fetchTradersGroupA2 = schedules.task({
  id: 'fetch-traders-group-a2',
  cron: '10 */3 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('a2'),
})

// Group A3: Bybit (every 3h, offset 20min)
export const fetchTradersGroupA3 = schedules.task({
  id: 'fetch-traders-group-a3',
  cron: '20 */3 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('a3'),
})

// Group A4: Bitget (every 3h, offset 30min)
export const fetchTradersGroupA4 = schedules.task({
  id: 'fetch-traders-group-a4',
  cron: '30 */3 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('a4'),
})

// Group B: Hyperliquid + GMX (every 4h)
export const fetchTradersGroupB = schedules.task({
  id: 'fetch-traders-group-b',
  cron: '0 */4 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('b'),
})

// Group C: Bitunix (every 4h, offset 15min)
export const fetchTradersGroupC = schedules.task({
  id: 'fetch-traders-group-c',
  cron: '15 */4 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('c'),
})

// Group D1: Gains + HTX (every 6h)
export const fetchTradersGroupD1 = schedules.task({
  id: 'fetch-traders-group-d1',
  cron: '20 */6 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('d1'),
})

// Group E: Bitfinex + CoinEx + Web3 (every 6h)
export const fetchTradersGroupE = schedules.task({
  id: 'fetch-traders-group-e',
  cron: '36 */6 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('e'),
})

// Group F: MEXC (every 6h)
export const fetchTradersGroupF = schedules.task({
  id: 'fetch-traders-group-f',
  cron: '42 */6 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('f'),
})

// Group F2: BingX (every 6h)
export const fetchTradersGroupF2 = schedules.task({
  id: 'fetch-traders-group-f2',
  cron: '48 */6 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('f2'),
})

// Group H: Gate.io + BTCC (every 6h)
export const fetchTradersGroupH = schedules.task({
  id: 'fetch-traders-group-h',
  cron: '54 */6 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('h'),
})

// Group G1: Drift + Jupiter + Aevo (every 6h)
export const fetchTradersGroupG1 = schedules.task({
  id: 'fetch-traders-group-g1',
  cron: '8 1,7,13,19 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('g1'),
})

// Group G2: Web3 Bot + Toobit + XT (every 6h)
export const fetchTradersGroupG2 = schedules.task({
  id: 'fetch-traders-group-g2',
  cron: '16 1,7,13,19 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('g2'),
})

// Group I: eToro + dYdX (every 6h)
export const fetchTradersGroupI = schedules.task({
  id: 'fetch-traders-group-i',
  cron: '24 2,8,14,20 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('i'),
})

// Group J: Weex (every 6h)
export const fetchTradersGroupJ = schedules.task({
  id: 'fetch-traders-group-j',
  cron: '36 3,9,15,21 * * *',
  maxDuration: 900,
  run: async () => fanOutGroup('j'),
})
