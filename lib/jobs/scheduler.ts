/**
 * Job Scheduler
 *
 * Manages periodic job creation:
 * - Discovery jobs (find new traders)
 * - Preheat jobs (refresh top N)
 * - Long-tail refresh (active but not top)
 *
 * Designed to be called from Vercel cron or standalone worker.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { LeaderboardPlatform, MarketType, Window } from '../types/leaderboard'

 
type AnySupabaseClient = SupabaseClient<any, any, any>
import { createRefreshJob, createPreheatJobs } from './processor'
import { PLATFORM_CAPABILITIES } from '../connectors/capabilities'

// ============================================
// Scheduling Configuration
// ============================================

interface ScheduleConfig {
  /** Top N traders to preheat per platform */
  preheatTopN: number
  /** How often to discover new traders (ms) */
  discoveryInterval: number
  /** How often to refresh top N (ms) */
  preheatInterval: number
  /** How often to refresh long-tail (ms) */
  longTailInterval: number
}

const _DEFAULT_SCHEDULE: ScheduleConfig = {
  preheatTopN: 500,
  discoveryInterval: 3600000,      // 1 hour
  preheatInterval: 900000,         // 15 minutes
  longTailInterval: 14400000,      // 4 hours
}

// ============================================
// Scheduler Functions
// ============================================

/**
 * Run a full discovery cycle across all platforms.
 * Creates DISCOVER jobs for each platform/market/window combination.
 */
export async function scheduleDiscovery(): Promise<number> {
  let created = 0

  for (const cap of PLATFORM_CAPABILITIES) {
    for (const marketType of cap.market_types) {
      for (const window of cap.native_windows) {
        const id = await createRefreshJob({
          jobType: 'DISCOVER',
          platform: cap.platform as LeaderboardPlatform,
          marketType: marketType as MarketType,
          window: window as Window,
          priority: 30,
        })
        if (id) created++
      }
    }
  }

  return created
}

/**
 * Schedule preheat jobs for top N traders across all platforms.
 */
export async function schedulePreheat(topN: number = 500): Promise<number> {
  let total = 0

  for (const cap of PLATFORM_CAPABILITIES) {
    for (const marketType of cap.market_types) {
      const count = await createPreheatJobs(
        cap.platform as LeaderboardPlatform,
        marketType as MarketType,
        topN
      )
      total += count
    }
  }

  return total
}

/**
 * Schedule long-tail refresh for active traders not in top N.
 * @deprecated Reads trader_sources for scheduling-specific columns (is_active, last_seen_at).
 *             Not migratable to unified layer (scheduling infrastructure).
 */
export async function scheduleLongTailRefresh(
  platform: LeaderboardPlatform,
  marketType: MarketType,
  batchSize: number = 100
): Promise<number> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) return 0

  const supabase: AnySupabaseClient = createClient(supabaseUrl, supabaseServiceKey)

  // Find traders that haven't been refreshed in 4+ hours
  const staleThreshold = new Date(Date.now() - 14400000).toISOString()

  const { data: staleTraders } = await supabase
    .from('trader_sources')
    .select('source_trader_id')
    .eq('source', platform)
    .eq('market_type', marketType)
    .eq('is_active', true)
    .lt('last_seen_at', staleThreshold)
    .limit(batchSize)

  if (!staleTraders || staleTraders.length === 0) return 0

  let created = 0
  const windows: Window[] = ['7d', '30d', '90d']

  for (const trader of staleTraders) {
    for (const window of windows) {
      const id = await createRefreshJob({
        jobType: 'SNAPSHOT_REFRESH',
        platform,
        marketType,
        traderKey: trader.source_trader_id,
        window,
        priority: 40, // SCHEDULED_LONG_TAIL
      })
      if (id) created++
    }
  }

  return created
}

/**
 * Get queue statistics for monitoring.
 */
export async function getQueueStats(): Promise<{
  pending: number
  running: number
  failed: number
  byPlatform: Record<string, { pending: number; running: number; failed: number }>
}> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return { pending: 0, running: 0, failed: 0, byPlatform: {} }
  }

  const supabase: AnySupabaseClient = createClient(supabaseUrl, supabaseServiceKey)

  const { data } = await supabase
    .from('refresh_jobs')
    .select('status, platform')
    .in('status', ['pending', 'running', 'failed'])

  if (!data) return { pending: 0, running: 0, failed: 0, byPlatform: {} }

  const stats = { pending: 0, running: 0, failed: 0, byPlatform: {} as Record<string, { pending: number; running: number; failed: number }> }

  for (const job of data) {
    if (job.status === 'pending') stats.pending++
    else if (job.status === 'running') stats.running++
    else if (job.status === 'failed') stats.failed++

    if (!stats.byPlatform[job.platform]) {
      stats.byPlatform[job.platform] = { pending: 0, running: 0, failed: 0 }
    }
    const ps = stats.byPlatform[job.platform]
    if (job.status === 'pending') ps.pending++
    else if (job.status === 'running') ps.running++
    else if (job.status === 'failed') ps.failed++
  }

  return stats
}
