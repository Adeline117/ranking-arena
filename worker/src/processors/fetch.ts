/**
 * Fetch processor — fetches leaderboard data for a single platform.
 *
 * Reuses existing connector framework (runConnectorBatch) — zero duplication.
 * Each platform runs as an independent job with no timeout pressure.
 */

import type { Job } from 'bullmq'
import type { FetchPlatformData } from '../queues'

export async function processFetch(job: Job<FetchPlatformData>): Promise<{
  platform: string
  totalSaved: number
  durationMs: number
}> {
  const { platform, windows } = job.data
  const start = Date.now()

  job.log(`Fetching ${platform} windows=[${windows.join(',')}]`)

  // Dynamic imports — only load heavy modules when job runs
  const { runConnectorBatch } = await import('@/lib/pipeline/connector-db-adapter')
  const { connectorRegistry, initializeConnectors } = await import('@/lib/connectors/registry')
  const { SOURCE_TO_CONNECTOR_MAP } = await import('@/lib/constants/exchanges')
  const { createSupabaseAdmin } = await import('@/lib/cron/utils')
  const { recordFetchResult } = await import('@/lib/utils/pipeline-monitor')

  const supabase = createSupabaseAdmin()
  if (!supabase) throw new Error('Supabase env vars missing')

  await initializeConnectors()

  const mapping = SOURCE_TO_CONNECTOR_MAP[platform]
  if (!mapping) throw new Error(`No connector mapping for ${platform}`)

  type LP = import('@/lib/types/leaderboard').LeaderboardPlatform
  type MT = import('@/lib/types/leaderboard').MarketType

  const connector = await connectorRegistry.getOrInit(
    mapping.platform as LP,
    mapping.marketType as MT
  )
  if (!connector) throw new Error(`No connector for ${platform}:${mapping.marketType}`)

  const result = await runConnectorBatch(connector, {
    supabase,
    windows: windows as any[],
    limit: 500,
    sourceOverride: platform,
  })

  const totalSaved = Object.values(result.periods).reduce(
    (sum, p) => sum + ((p as any).saved || 0),
    0
  )
  const hasErrors = Object.values(result.periods).some((p) => (p as any).error)

  await recordFetchResult(supabase, result.source, {
    success: !hasErrors,
    durationMs: result.duration,
    tradersCount: totalSaved,
  })

  const durationMs = Date.now() - start
  job.log(`Done: ${totalSaved} traders saved in ${durationMs}ms`)

  if (hasErrors) {
    const errors = Object.entries(result.periods)
      .filter(([, p]) => (p as any).error)
      .map(([w, p]) => `${w}: ${(p as any).error}`)
    job.log(`Errors: ${errors.join('; ')}`)
  }

  return { platform, totalSaved, durationMs }
}
