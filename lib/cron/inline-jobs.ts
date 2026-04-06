/**
 * Core logic for batch-5min sub-jobs, extracted for inline execution.
 * Avoids HTTP sub-calls that go through Cloudflare (100s timeout) or
 * Vercel deployment protection (401).
 */

import { getConnector } from '@/connectors'
import { calculateArenaScore as calculateArenaScoreV1 } from '@/workers/arena-score'
import type { Platform, MarketType, Window, LeaderboardEntry } from '@/connectors/base/types'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { del as cacheDelete } from '@/lib/cache'
import { decrypt } from '@/lib/crypto/encryption'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { BybitAdapter } from '@/lib/adapters/bybit-adapter'
import { logger } from '@/lib/logger'
import { validateSnapshot } from '@/lib/pipeline/validate-snapshot'
import { createLogger } from '@/lib/utils/logger'
import { calculateArenaScore } from '@/lib/utils/arena-score'
import type { Period } from '@/lib/utils/arena-score'
import type { TraderData } from '@/lib/adapters/types'

/** Truncate timestamp to hour boundary for partitioned upsert dedup */
function truncateToHour(isoOrDate?: string | Date | null): string {
  const d = isoOrDate ? new Date(isoOrDate) : new Date()
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString()
}

const hotScoreLogger = createLogger('refresh-hot-scores')

export interface InlineJobResult {
  name: string
  status: 'success' | 'error'
  durationMs: number
  detail?: Record<string, unknown>
  error?: string
}

// ---------------------------------------------------------------------------
// 1. run-worker: Process pending refresh_jobs
// ---------------------------------------------------------------------------
export async function runWorkerInline(): Promise<InlineJobResult> {
  const start = Date.now()
  const name = 'run-worker'
  try {
    const supabase = getSupabaseAdmin()
    const workerId = `vercel-${Date.now()}`
    const MAX_JOBS = 3
    const results: Array<{ job_id: string; platform: string; status: string; error?: string }> = []

    interface RefreshJob {
      id: string
      platform: string
      market_type: string
      job_type: string
      trader_key?: string
      status: string
      attempts?: number
      max_attempts?: number
    }

    // Try to claim a job — if the RPC or table doesn't exist, gracefully skip
    let firstJob: RefreshJob | null = null
    try {
      const { data: jobs, error: rpcError } = await supabase.rpc('claim_refresh_job', {
        p_worker_id: workerId,
        p_platforms: null,
        p_job_types: null,
      })
      if (rpcError) {
        // RPC doesn't exist or refresh_jobs table missing — v2 job queue not deployed
        return { name, status: 'success', durationMs: Date.now() - start, detail: { skipped: true, reason: 'claim_refresh_job RPC not available' } }
      }
      firstJob = jobs?.[0] ?? null
    } catch (err) {
      // RPC function doesn't exist — gracefully skip, but log the actual error
      logger.warn('[inline-jobs] claim_refresh_job RPC error:', err instanceof Error ? err.message : String(err))
      return { name, status: 'success', durationMs: Date.now() - start, detail: { skipped: true, reason: 'claim_refresh_job RPC not available' } }
    }

    if (!firstJob) {
      return { name, status: 'success', durationMs: Date.now() - start, detail: { jobs_processed: 0 } }
    }
    let job: RefreshJob | null = firstJob

    for (let i = 0; i < MAX_JOBS; i++) {
      if (i > 0) {
        const { data: jobs, error: claimErr } = await supabase.rpc('claim_refresh_job', {
          p_worker_id: workerId,
          p_platforms: null,
          p_job_types: null,
        })
        if (claimErr) {
          logger.warn(`[inline-jobs] claim_refresh_job RPC failed on iteration ${i}: ${claimErr.message}`)
          break
        }
        job = jobs?.[0] ?? null
      }
      if (!job) break

      try {
        // Check circuit breaker
        const { data: health } = await supabase
          .from('platform_health')
          .select('status')
          .eq('platform', job.platform)
          .maybeSingle()

        if (health?.status === 'circuit_open') {
          await supabase
            .from('refresh_jobs')
            .update({ status: 'pending', locked_at: null, locked_by: null, next_run_at: new Date(Date.now() + 300000).toISOString(), last_error: 'Circuit breaker open' })
            .eq('id', job.id)
          results.push({ job_id: job.id, platform: job.platform, status: 'deferred', error: 'Circuit open' })
          continue
        }

        const connector = getConnector(job.platform as Platform, job.market_type as MarketType)
        if (!connector) throw new Error(`No connector for ${job.platform}:${job.market_type}`)

        if (job.job_type === 'DISCOVER') {
          const windows: Window[] = ['7d', '30d', '90d']
          for (const window of windows) {
            const result = await connector.discoverLeaderboard(window, 100)
            if (result.success && result.data?.length) {
              await upsertLeaderboardData(supabase, job.platform as Platform, job.market_type as MarketType, window, result.data, result.provenance)
            }
          }
        } else if (job.job_type === 'SNAPSHOT' && job.trader_key) {
          // Ensure trader_sources exists before writing snapshots (prevents orphans)
          const canonicalMT = SOURCE_TYPE_MAP[job.platform] || job.market_type
          await supabase.from('trader_sources').upsert({
            source: job.platform,
            source_trader_id: job.trader_key,
            handle: job.trader_key,
            source_type: canonicalMT,
          }, { onConflict: 'source,source_trader_id' })

          const windows: Window[] = ['7d', '30d', '90d']
          for (const window of windows) {
            const result = await connector.fetchTraderSnapshot(job.trader_key, window)
            if (result.success && result.data) {
              // Validate snapshot data before writing
              const snapRow = {
                platform: result.data.platform ?? job.platform,
                trader_key: result.data.trader_key ?? job.trader_key,
                roi_pct: result.data.metrics.roi_pct,
                pnl_usd: result.data.metrics.pnl_usd,
                win_rate: result.data.metrics.win_rate,
                max_drawdown: result.data.metrics.max_drawdown,
              }
              const validation = validateSnapshot(snapRow)
              if (!validation.valid) {
                logger.warn(`[inline-jobs] SNAPSHOT rejected ${job.platform}/${job.trader_key}/${window}: ${validation.reasons.join(', ')}`)
                continue
              }
              const arenaScore = result.data.metrics.roi_pct != null
                ? calculateArenaScoreV1(result.data.metrics.roi_pct, result.data.metrics.pnl_usd, result.data.metrics.max_drawdown, result.data.metrics.win_rate, window)
                : null
              const { error: snapInsertErr } = await supabase.from('trader_snapshots_v2').upsert({
                ...result.data, as_of_ts: truncateToHour(),
                market_type: canonicalMT,
                roi_pct: result.data.metrics.roi_pct,
                pnl_usd: result.data.metrics.pnl_usd,
                win_rate: result.data.metrics.win_rate,
                max_drawdown: result.data.metrics.max_drawdown,
                trades_count: result.data.metrics.trades_count,
                followers: result.data.metrics.followers,
                copiers: result.data.metrics.copiers,
                sharpe_ratio: result.data.metrics.sharpe_ratio,
                arena_score: arenaScore,
              }, { onConflict: 'platform,market_type,trader_key,window,as_of_ts' })
              if (snapInsertErr) {
                logger.warn(`[inline-jobs] SNAPSHOT upsert error: ${snapInsertErr.message}`)
                throw new Error(`SNAPSHOT upsert failed: ${snapInsertErr.message}`)
              }
            }
          }
        } else if (job.job_type === 'PROFILE' && job.trader_key) {
          const result = await connector.fetchTraderProfile(job.trader_key)
          if (result.success && result.data) {
            // Override market_type with canonical value from SOURCE_TYPE_MAP
            const canonicalMT = SOURCE_TYPE_MAP[job.platform] || job.market_type
            const { error: profileErr } = await supabase.from('trader_profiles_v2').upsert(
              { ...result.data, market_type: canonicalMT },
              { onConflict: 'platform,market_type,trader_key' }
            )
            if (profileErr) {
              logger.warn(`[inline-jobs] PROFILE upsert error: ${profileErr.message}`)
              throw new Error(`PROFILE upsert failed: ${profileErr.message}`)
            }
          }
        }

        await supabase
          .from('refresh_jobs')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('id', job.id)

        await supabase.from('platform_health').upsert({
          platform: job.platform, status: 'healthy', consecutive_failures: 0,
          last_success_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }, { onConflict: 'platform' })

        results.push({ job_id: job.id, platform: job.platform, status: 'completed' })
      } catch (error: unknown) {
        const errorMsg = (error as Error).message
        const attempts = job.attempts ?? 0
        const maxAttempts = job.max_attempts ?? 3
        const backoffMs = Math.min(60000, 5000 * Math.pow(2, attempts))
        await supabase
          .from('refresh_jobs')
          .update({
            status: attempts >= maxAttempts ? 'dead' : 'failed',
            last_error: errorMsg,
            next_run_at: new Date(Date.now() + backoffMs).toISOString(),
            locked_at: null, locked_by: null,
          })
          .eq('id', job.id)
        results.push({ job_id: job.id, platform: job.platform, status: 'failed', error: errorMsg })
      }
    }

    return { name, status: 'success', durationMs: Date.now() - start, detail: { worker_id: workerId, jobs_processed: results.length, results } }
  } catch (err) {
    return { name, status: 'error', durationMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}

async function upsertLeaderboardData(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  platform: Platform, _market_type: MarketType, window: Window,
  entries: LeaderboardEntry[], provenance: Record<string, unknown>,
) {
  // Resolve canonical market_type from SOURCE_TYPE_MAP to avoid duplicates
  // (connector uses 'perp' for DEX, but SOURCE_TYPE_MAP uses 'web3')
  const market_type = (SOURCE_TYPE_MAP[platform] || _market_type) as MarketType
  const now = new Date().toISOString()
  const sources = entries.map(e => ({
    platform, market_type, trader_key: e.trader_key,
    display_name: e.display_name, profile_url: e.profile_url,
    last_seen_at: now, is_active: true, raw: e.raw,
  }))
  const BATCH_SIZE = 25
  
  // Batch upsert sources
  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch = sources.slice(i, i + BATCH_SIZE)
    const { error: srcUpsertErr } = await supabase.from('trader_sources_v2').upsert(batch, { onConflict: 'platform,market_type,trader_key' })
    if (srcUpsertErr?.message?.includes('ON CONFLICT')) {
      // Unique constraint on (platform, market_type, trader_key) missing.
      // Fall back to plain inserts — duplicates ignored if they error.
      for (const src of batch) {
        const { error: insertErr } = await supabase.from('trader_sources_v2').insert(src)
        if (insertErr && !insertErr.message.includes('duplicate key')) {
          logger.warn(`[inline-jobs] trader_sources_v2 insert fallback error: ${insertErr.message}`)
        }
      }
    }
  }

  const snapshots = entries
    .filter(e => e.metrics.roi_pct != null || Object.keys(e.metrics).length > 0)
    .map(e => {
      const roi = e.metrics.roi_pct ?? null
      const arenaScore = roi != null
        ? calculateArenaScoreV1(roi, e.metrics.pnl_usd ?? null, e.metrics.max_drawdown ?? null, e.metrics.win_rate ?? null, window)
        : null
      return {
        platform, market_type, trader_key: e.trader_key, window, as_of_ts: truncateToHour(),
        metrics: e.metrics, roi_pct: roi, pnl_usd: e.metrics.pnl_usd ?? null,
        win_rate: e.metrics.win_rate ?? null, max_drawdown: e.metrics.max_drawdown ?? null,
        trades_count: e.metrics.trades_count ?? null, followers: e.metrics.followers ?? null,
        copiers: e.metrics.copiers ?? null, sharpe_ratio: e.metrics.sharpe_ratio ?? null,
        arena_score: arenaScore, quality_flags: { missing_roi: roi == null }, provenance,
      }
    })
  
  // Batch upsert snapshots with smaller batch size
  for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
    const batch = snapshots.slice(i, i + BATCH_SIZE)
    const { error: batchErr } = await supabase.from('trader_snapshots_v2').upsert(
      batch,
      { onConflict: 'platform,market_type,trader_key,window,as_of_ts' }
    )
    if (batchErr) logger.warn(`[inline-jobs] DISCOVER upsert batch ${i} error: ${batchErr.message}`)
  }
}

// ---------------------------------------------------------------------------
// 2. refresh-hot-scores: Update post hot_score via RPC with fallback
// ---------------------------------------------------------------------------
const HOT_POSTS_CACHE_KEY = 'hot_posts:top50'

export async function refreshHotScoresInline(): Promise<InlineJobResult> {
  const start = Date.now()
  const name = 'refresh-hot-scores'
  try {
    const supabase = getSupabaseAdmin()

    // Step 1: Velocity + report counts (non-blocking)
    const { error: velErr } = await supabase.rpc('update_post_velocity')
    if (velErr) hotScoreLogger.warn('Velocity update failed', { error: velErr.message })

    const { error: repErr } = await supabase.rpc('update_post_report_counts')
    if (repErr) hotScoreLogger.warn('Report count update failed', { error: repErr.message })

    // Step 2: Incremental refresh
    const { data: incCount, error: incErr } = await supabase.rpc('refresh_hot_scores_incremental')
    if (!incErr && incCount !== null) {
      try { await cacheDelete(HOT_POSTS_CACHE_KEY) } catch { /* non-critical */ }
      return { name, status: 'success', durationMs: Date.now() - start, detail: { method: 'incremental', count: incCount } }
    }

    // Step 3: Full refresh
    const { data: fullCount, error: fullErr } = await supabase.rpc('refresh_hot_scores')
    if (!fullErr && fullCount !== null) {
      try { await cacheDelete(HOT_POSTS_CACHE_KEY) } catch { /* non-critical */ }
      return { name, status: 'success', durationMs: Date.now() - start, detail: { method: 'full', count: fullCount } }
    }

    // Step 4: Direct update fallback
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days — keep fallback fast
    const { data: posts, error: fetchErr } = await supabase
      .from('posts')
      .select('id, like_count, comment_count, repost_count, view_count, created_at, poll_id')
      .gte('created_at', cutoff)

    if (fetchErr || !posts) {
      return { name, status: 'error', durationMs: Date.now() - start, error: fetchErr?.message || 'No posts for fallback' }
    }

    // Calculate scores and prepare batch upsert
    const now = new Date().toISOString()

    // Fetch poll vote counts for posts with polls
    const pollPostIds = posts.filter(p => (p as Record<string, unknown>).poll_id).map(p => p.id)
    const pollVotes = new Map<string, number>()
    if (pollPostIds.length > 0) {
      const { data: polls } = await supabase
        .from('polls')
        .select('post_id, options')
        .in('post_id', pollPostIds.slice(0, 200))
      for (const poll of (polls || [])) {
        let total = 0
        const opts = (poll.options || []) as Array<{ votes?: number }>
        opts.forEach(o => { total += o.votes || 0 })
        pollVotes.set(poll.post_id, total)
      }
    }

    const updates = posts.map(post => {
      const ageHours = (Date.now() - new Date(post.created_at).getTime()) / 3_600_000
      const pv = pollVotes.get(post.id) || 0
      const engagement = (post.like_count ?? 0) * 3 + (post.comment_count ?? 0) * 5 + (post.repost_count ?? 0) * 2 + (post.view_count ?? 0) * 0.1 + pv * 0.5
      // Freshness boost: new posts get a baseline score
      const freshness = ageHours < 2 ? 10 : ageHours < 6 ? 5 : ageHours < 12 ? 2 : 0
      // Quality multiplier: poll posts get 1.5x
      const quality = pv > 0 ? 1.5 : 1.0
      const score = (engagement / Math.pow(ageHours + 2, 1.5) + freshness) * quality
      return {
        id: post.id,
        hot_score: Math.round(score * 100) / 100,
        last_hot_refresh_at: now,
      }
    })

    // Batch upsert instead of loop
    const BATCH_SIZE = 25
    let errors = 0
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE)
      const { error: upErr } = await supabase
        .from('posts')
        .upsert(batch, { onConflict: 'id', ignoreDuplicates: false })
      if (upErr) {
        hotScoreLogger.error(`Batch ${i} failed:`, upErr)
        errors++
      }
    }

    if (errors > posts.length / 2) {
      return { name, status: 'error', durationMs: Date.now() - start, error: `${errors}/${posts.length} updates failed` }
    }

    try { await cacheDelete(HOT_POSTS_CACHE_KEY) } catch { /* non-critical */ }
    return { name, status: 'success', durationMs: Date.now() - start, detail: { method: 'fallback', count: posts.length } }
  } catch (err) {
    return { name, status: 'error', durationMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// 3. sync-traders: Sync authorized trader data from exchanges
// ---------------------------------------------------------------------------
export async function syncTradersInline(): Promise<InlineJobResult> {
  const start = Date.now()
  const name = 'trader-sync'
  try {
    const supabase = getSupabaseAdmin()

    const { data: authorizations, error: authErr } = await supabase
      .from('trader_authorizations')
      .select('id, platform, trader_id, encrypted_api_key, encrypted_api_secret, status')
      .eq('status', 'active')

    if (authErr) {
      return { name, status: 'error', durationMs: Date.now() - start, error: authErr.message }
    }

    if (!authorizations || authorizations.length === 0) {
      return { name, status: 'success', durationMs: Date.now() - start, detail: { synced: 0, total: 0 } }
    }

    let synced = 0
    let errors = 0

    for (const auth of authorizations) {
      try {
        const apiKey = decrypt(auth.encrypted_api_key)
        const apiSecret = decrypt(auth.encrypted_api_secret)
        const platformLower = auth.platform.toLowerCase()

        let traderData: TraderData | null = null
        if (platformLower.includes('bybit')) {
          const adapter = new BybitAdapter({ apiKey, apiSecret })
          traderData = await adapter.fetchTraderDetail({ platform: 'bybit', traderId: auth.trader_id })
        }

        if (!traderData) {
          throw new Error(`Platform ${auth.platform} not supported or trader not found`)
        }

        // Store synced data
        const period: Period = traderData.periodDays === 30 ? '30D' : '7D'
        const arenaScoreResult = calculateArenaScore({ roi: traderData.roi, pnl: traderData.pnl, maxDrawdown: traderData.maxDrawdown, winRate: traderData.winRate }, period)

        // Write to v2 only (v1 writes removed 2026-03-18)
        const { error: snapErr } = await supabase.from('trader_snapshots_v2').upsert({
          platform: auth.platform, market_type: 'futures', trader_key: auth.trader_id, window: period, as_of_ts: truncateToHour(),
          roi_pct: traderData.roi, pnl_usd: traderData.pnl, followers: traderData.followers,
          trades_count: traderData.tradesCount,
          win_rate: traderData.winRate, max_drawdown: traderData.maxDrawdown,
          arena_score: arenaScoreResult.totalScore,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'platform,market_type,trader_key,window,as_of_ts' })
        if (snapErr) logger.warn(`[Sync] snapshot upsert failed for ${auth.platform}/${auth.trader_id}: ${snapErr.message}`)

        const { error: srcErr } = await supabase.from('trader_sources').upsert({
          source: auth.platform, source_trader_id: auth.trader_id,
          nickname: traderData.nickname, avatar_url: traderData.avatar,
          description: traderData.description, verified: traderData.verified,
          last_updated: new Date().toISOString(),
        }, { onConflict: 'source,source_trader_id' })
        if (srcErr) logger.warn(`[Sync] source upsert failed for ${auth.platform}/${auth.trader_id}: ${srcErr.message}`)

        await supabase.from('authorization_sync_logs').insert({
          authorization_id: auth.id, sync_status: 'success', records_synced: 1, synced_data: traderData,
        })

        const { error: authErr } = await supabase.from('trader_authorizations').update({
          last_verified_at: new Date().toISOString(), verification_error: null,
        }).eq('id', auth.id)
        if (authErr) logger.warn(`[Sync] authorization update failed for ${auth.id}: ${authErr.message}`)

        synced++
      } catch (error) {
        logger.error('[Sync] Failed', { authorizationId: auth.id, platform: auth.platform }, error instanceof Error ? error : new Error(String(error)))
        await supabase.from('authorization_sync_logs').insert({
          authorization_id: auth.id, sync_status: 'failed', error_message: error instanceof Error ? error.message : String(error),
        })
        await supabase.from('trader_authorizations').update({
          verification_error: error instanceof Error ? error.message : String(error),
        }).eq('id', auth.id)
        errors++
      }
    }

    return { name, status: 'success', durationMs: Date.now() - start, detail: { synced, errors, total: authorizations.length } }
  } catch (err) {
    return { name, status: 'error', durationMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}
