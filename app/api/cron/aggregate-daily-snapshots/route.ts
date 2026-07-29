/**
 * GET /api/cron/aggregate-daily-snapshots
 *
 * Aggregates end-of-day trader snapshots into daily records for historical analysis.
 * Core daily snapshot collection: fetch yesterday's data, gap-fill from leaderboard_ranks,
 * compute daily_return_pct, and upsert to trader_daily_snapshots.
 *
 * Derived metrics (Sharpe/MDD/WR) are computed inside the atomic leaderboard build.
 * Cleanup and metric refresh are handled by /api/cron/cleanup-data (01:00 UTC).
 *
 * Schedule: Daily at 00:05 UTC (Vercel cron sends GET)
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { safeParseInt } from '@/lib/utils/safe-parse'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { PipelineLogger, type PipelineLogHandle } from '@/lib/services/pipeline-logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import { validateBeforeWrite, logRejectedWrites } from '@/lib/pipeline/validate-before-write'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PER_PLATFORM_FALLBACK_LIMIT = 10_000
const GAP_FILL_LIMIT = 50_000

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Include days_back in lock name so different variants can run independently
  const daysBack = Math.min(
    Math.max(safeParseInt(request.nextUrl.searchParams.get('days_back'), 1), 1),
    30
  )
  const lockName =
    daysBack > 1 ? `aggregate-daily-snapshots:days_back=${daysBack}` : 'aggregate-daily-snapshots'
  const releaseLock = await acquireCronLock(lockName, { ttlSeconds: 300 })
  if (!releaseLock) {
    return NextResponse.json({ status: 'skipped', reason: 'already running' })
  }

  try {
    const supabase = getSupabaseAdmin()

    const startTime = Date.now()
    const plog = await PipelineLogger.start('aggregate-daily-snapshots')

    try {
      let totalInserted = 0
      let totalErrors = 0

      for (let dayOffset = daysBack; dayOffset >= 1; dayOffset--) {
        const targetDate = new Date()
        targetDate.setUTCDate(targetDate.getUTCDate() - dayOffset)
        const dateStr = targetDate.toISOString().split('T')[0]
        const { inserted, errors } = await aggregateForDate(supabase, dateStr, plog)
        if (errors > 0) {
          throw new Error(`${errors} snapshot writes failed for ${dateStr}`)
        }
        totalInserted += inserted
        totalErrors += errors
        logger.info(`[aggregate] ${dateStr}: inserted=${inserted}, errors=${errors}`)
      }

      const duration = `${Date.now() - startTime}ms`
      if (totalErrors > 0) {
        await plog.error(new Error(`${totalErrors} upsert errors across ${daysBack} days`), {
          inserted: totalInserted,
          errors: totalErrors,
          days: daysBack,
        })
      } else {
        await plog.success(totalInserted, { days: daysBack })
      }
      return NextResponse.json({
        success: true,
        days: daysBack,
        inserted: totalInserted,
        errors: totalErrors,
        duration,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('[aggregate-daily-snapshots] Fatal error:', { error: message })
      await plog.error(error instanceof Error ? error : new Error(message))
      return NextResponse.json({ success: false, error: message }, { status: 500 })
    }
  } finally {
    await releaseLock()
  }
}

async function aggregateForDate(
  supabase: SupabaseClient,
  dateStr: string,
  _plog: PipelineLogHandle
): Promise<{ inserted: number; errors: number }> {
  const readDb = getReadReplica() // Read replica for heavy SELECT queries

  // Step 1: Fetch ALL yesterday's snapshots in one query using RPC or direct query
  // Use distinct on (source, source_trader_id) ordered by captured_at desc to get latest per trader
  const { data: snapshots, error: snapshotError } = await readDb.rpc(
    'get_latest_snapshots_for_date',
    { target_date: dateStr }
  )

  const snapshotMap: Map<
    string,
    {
      source: string
      source_trader_id: string
      roi: number | null
      pnl: number | null
      win_rate: number | null
      max_drawdown: number | null
      followers: number | null
      trades_count: number | null
    }
  > = new Map()

  const useLeaderboardFallback = snapshotError !== null || snapshots === null
  const yesterday = new Date()
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  const isLatestSnapshotDate = dateStr === yesterday.toISOString().split('T')[0]
  if (useLeaderboardFallback && !isLatestSnapshotDate) {
    throw new Error(
      `Historical snapshot source unavailable for ${dateStr}; current ranks cannot backfill past dates`
    )
  }
  if (useLeaderboardFallback) {
    logger.warn('[aggregate] Historical snapshot RPC unavailable; using sealed rank fallback', {
      date: dateStr,
      error: snapshotError?.message,
    })
  } else {
    for (const s of snapshots) {
      if (
        !isPublicRankingSourceAllowed(s.source) ||
        typeof s.source_trader_id !== 'string' ||
        s.source_trader_id.length === 0
      ) {
        continue
      }
      snapshotMap.set(`${s.source}:${s.source_trader_id}`, s)
    }
  }

  // Step 2: Fill gaps from one immutable published 90D generation. If the
  // retired historical RPC is unavailable, the same sealed read becomes the
  // explicit fallback; it must never mix partial per-source generations.
  const sealedRankRows = await readSealedRankingAuthorityGeneration(
    readDb,
    '90D',
    async (publication) => {
      const authoritySources = publication.proofs.map((proof) => proof.source)
      // A current publication can fill yesterday's end-of-day snapshot only.
      // Reusing it for an older backfill date would rewrite history with
      // today's metrics, so historical dates rely solely on their dated RPC.
      if (!isLatestSnapshotDate) return []

      if (useLeaderboardFallback) {
        const batches = await Promise.all(
          authoritySources.map(async (source) => {
            const { data, error } = await readDb
              .from('leaderboard_ranks')
              .select(
                'source, source_trader_id, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank'
              )
              .eq('source', source)
              .eq('season_id', '90D')
              .filter('rank_publication_id', 'eq', publication.scoreCohortId)
              .not('arena_score', 'is', null)
              .order('rank', { ascending: true })
              .order('source_trader_id', { ascending: true })
              .limit(PER_PLATFORM_FALLBACK_LIMIT)

            if (error || data === null) {
              throw new Error(
                `sealed aggregate fallback failed for ${source}: ${error?.message ?? 'null payload'}`
              )
            }
            if (
              data.some((row) => row.source !== source || !isPublicRankingSourceAllowed(row.source))
            ) {
              throw new Error(`sealed aggregate fallback crossed source boundary for ${source}`)
            }
            const proof = publication.proofs.find((candidate) => candidate.source === source)
            if ((proof?.published_rank_count ?? 0) > 0 && data.length === 0) {
              throw new Error(`sealed aggregate fallback returned no rows for ${source}`)
            }
            return data
          })
        )
        return batches.flat()
      }

      const { data, error } = await readDb
        .from('leaderboard_ranks')
        .select(
          'source, source_trader_id, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank'
        )
        .in('source', authoritySources)
        .eq('season_id', '90D')
        .filter('rank_publication_id', 'eq', publication.scoreCohortId)
        .not('arena_score', 'is', null)
        .order('rank', { ascending: true })
        .order('source', { ascending: true })
        .order('source_trader_id', { ascending: true })
        .limit(GAP_FILL_LIMIT)

      if (error || data === null) {
        throw new Error(`sealed aggregate gap fill failed: ${error?.message ?? 'null payload'}`)
      }
      if (data.some((row) => !isPublicRankingSourceAllowed(row.source))) {
        throw new Error('sealed aggregate gap fill crossed the public source boundary')
      }
      const publishedCount = publication.proofs.reduce(
        (total, proof) => total + proof.published_rank_count,
        0
      )
      if (publishedCount > 0 && data.length === 0) {
        throw new Error('sealed aggregate gap fill returned no published rows')
      }
      return data
    },
    { timeoutMs: 10_000 }
  )

  let filled = 0
  for (const lr of sealedRankRows.value) {
    const key = `${lr.source}:${lr.source_trader_id}`
    if (!snapshotMap.has(key)) {
      snapshotMap.set(key, {
        source: lr.source,
        source_trader_id: lr.source_trader_id,
        roi: lr.roi,
        pnl: lr.pnl,
        win_rate: lr.win_rate,
        max_drawdown: lr.max_drawdown,
        followers: lr.followers,
        trades_count: lr.trades_count,
      })
      filled++
    } else {
      const existing = snapshotMap.get(key)!
      if (existing.roi == null && lr.roi != null) existing.roi = lr.roi
      if (existing.pnl == null && lr.pnl != null) existing.pnl = lr.pnl
    }
  }
  if (filled > 0) {
    logger.info(`[aggregate] Filled ${filled} traders from sealed leaderboard generation`)
  }

  if (snapshotMap.size === 0) {
    throw new Error(`No authoritative public snapshot rows available for ${dateStr}`)
  }

  // Step 3: Fetch ALL previous daily snapshots in one query
  const platforms = [...new Set(Array.from(snapshotMap.values()).map((s) => s.source))]

  const { data: prevSnapshots, error: prevError } = await readDb.rpc('get_latest_prev_snapshots', {
    target_platforms: platforms,
    before_date: dateStr,
  })

  if (prevError || prevSnapshots === null) {
    throw new Error(
      `get_latest_prev_snapshots failed for ${dateStr}: ${prevError?.message ?? 'null payload'}`
    )
  }

  const prevDataMap = new Map<string, { pnl: number | null; roi: number | null }>()
  if (prevSnapshots) {
    for (const ps of prevSnapshots) {
      const key = `${ps.platform}:${ps.trader_key}`
      prevDataMap.set(key, {
        pnl: ps.pnl != null ? parseFloat(String(ps.pnl)) : null,
        roi: ps.roi != null ? parseFloat(String(ps.roi)) : null,
      })
    }
  }

  // Step 4: Build upsert records with daily_return_pct
  const records: Array<{
    platform: string
    trader_key: string
    date: string
    roi: number | null
    pnl: number | null
    daily_return_pct: number | null
    win_rate: number | null
    max_drawdown: number | null
    followers: number | null
    trades_count: number | null
    cumulative_pnl: number | null
  }> = []

  for (const [key, snapshot] of snapshotMap) {
    const currentPnl = snapshot.pnl != null ? parseFloat(String(snapshot.pnl)) : null
    const currentRoi = snapshot.roi != null ? parseFloat(String(snapshot.roi)) : null
    const prev = prevDataMap.get(key)

    // Data validation: skip records with extreme values that exceed DB schema limits
    if (
      (currentRoi != null && (Math.abs(currentRoi) > 99999999 || !Number.isFinite(currentRoi))) ||
      (currentPnl != null &&
        (Math.abs(currentPnl) > 9999999999999999 || !Number.isFinite(currentPnl))) ||
      (snapshot.win_rate != null &&
        (Math.abs(parseFloat(String(snapshot.win_rate))) > 999 ||
          !Number.isFinite(parseFloat(String(snapshot.win_rate))))) ||
      (snapshot.max_drawdown != null &&
        (Math.abs(parseFloat(String(snapshot.max_drawdown))) > 999 ||
          !Number.isFinite(parseFloat(String(snapshot.max_drawdown)))))
    ) {
      logger.warn(
        `[aggregate] Skipping record with extreme value: ${key}, roi=${currentRoi}, pnl=${currentPnl}`
      )
      continue
    }

    // Compute daily return: prefer ROI delta, fallback to PnL delta
    let dailyReturnPct: number | null = null
    if (currentRoi != null && prev?.roi != null) {
      const rawReturn = currentRoi - prev.roi
      dailyReturnPct = Math.max(-1000, Math.min(1000, rawReturn))
    } else if (currentPnl != null && prev?.pnl != null && Math.abs(prev.pnl) > 0.01) {
      const rawReturn = ((currentPnl - prev.pnl) / Math.abs(prev.pnl)) * 100
      dailyReturnPct = Math.max(-1000, Math.min(1000, rawReturn))
    }

    records.push({
      platform: snapshot.source,
      trader_key: snapshot.source_trader_id,
      date: dateStr,
      roi: snapshot.roi != null ? parseFloat(String(snapshot.roi)) : null,
      pnl: currentPnl,
      daily_return_pct: dailyReturnPct,
      win_rate: snapshot.win_rate != null ? parseFloat(String(snapshot.win_rate)) : null,
      max_drawdown:
        snapshot.max_drawdown != null ? parseFloat(String(snapshot.max_drawdown)) : null,
      followers: snapshot.followers ?? null,
      trades_count: snapshot.trades_count ?? null,
      cumulative_pnl: currentPnl,
    })
  }

  // Step 5: Batch upsert daily snapshots
  // ROOT CAUSE FIX (2026-04-08): UPSERT_BATCH was 500 → exceeded Supabase
  // statement_timeout (30s) on busy DB. Reduced batch + retry with smaller
  // sub-batches on timeout to ensure progress.
  let inserted = 0
  let errors = 0

  const safeUpsert = async (
    batch: typeof records
  ): Promise<{ ok: boolean; sub_inserted: number; sub_errors: number }> => {
    const { valid: validBatch, rejected } = validateBeforeWrite(batch, 'trader_daily_snapshots')
    if (rejected.length) await logRejectedWrites(rejected, supabase)
    if (validBatch.length === 0) return { ok: false, sub_inserted: 0, sub_errors: batch.length }

    const { error: upsertError } = await supabase
      .from('trader_daily_snapshots')
      .upsert(validBatch, { onConflict: 'platform,trader_key,date' })

    if (!upsertError) return { ok: true, sub_inserted: validBatch.length, sub_errors: 0 }

    // ROOT CAUSE FIX (2026-04-09): Previously transient errors triggered split-and-retry
    // but non-transient errors (numeric overflow, NULL violation, check constraint) caused
    // the entire batch (250 rows) to be counted as errors and skipped — single bad row
    // poisoned 250 records. Audit found pipeline_logs reporting 998 errors / day with NO
    // detail on which rows. Fix: any persistent error triggers split-down to isolate the
    // bad row, log full error + sample row payload to logger.dbError + pipeline_rejected_writes,
    // then continue with remaining good rows.
    const errMsg = upsertError.message || ''

    // For batches > 1, split-and-retry regardless of error transience.
    // Splits happen log2(250) ≈ 8 times max → bounded extra round trips.
    if (validBatch.length > 1) {
      const mid = Math.floor(validBatch.length / 2)
      const a = await safeUpsert(validBatch.slice(0, mid))
      const b = await safeUpsert(validBatch.slice(mid))
      return {
        ok: a.ok && b.ok,
        sub_inserted: a.sub_inserted + b.sub_inserted,
        sub_errors: a.sub_errors + b.sub_errors,
      }
    }

    // Single-row failure: this is the bad row. Log it + record in pipeline_rejected_writes
    // so we can see exactly what's failing without grepping vercel logs.
    const badRow = validBatch[0] as Record<string, unknown>
    logger.dbError('upsert-daily-snapshots-row', upsertError, {
      row: {
        platform: badRow.platform,
        trader_key: badRow.trader_key,
        date: badRow.date,
        roi: badRow.roi,
        pnl: badRow.pnl,
        daily_return_pct: badRow.daily_return_pct,
        win_rate: badRow.win_rate,
        max_drawdown: badRow.max_drawdown,
        followers: badRow.followers,
        trades_count: badRow.trades_count,
        cumulative_pnl: badRow.cumulative_pnl,
      },
      errorCode: upsertError.code,
      errorMessage: errMsg.slice(0, 200),
    })
    // Best-effort persist to pipeline_rejected_writes — non-blocking on failure
    try {
      await supabase.from('pipeline_rejected_writes').insert({
        platform: String(badRow.platform ?? 'unknown'),
        trader_key: String(badRow.trader_key ?? 'unknown'),
        target_table: 'trader_daily_snapshots',
        field: '*',
        value: JSON.stringify({
          roi: badRow.roi,
          pnl: badRow.pnl,
          daily_return_pct: badRow.daily_return_pct,
          win_rate: badRow.win_rate,
          max_drawdown: badRow.max_drawdown,
          cumulative_pnl: badRow.cumulative_pnl,
        }).slice(0, 500),
        reason: `upsert failed: ${errMsg.slice(0, 180)}`,
        metadata: { code: upsertError.code, date: badRow.date },
      })
    } catch (_persistErr) {
      /* don't block on logging failure */
    }
    return { ok: false, sub_inserted: 0, sub_errors: 1 }
  }

  // Reduced from 500 to 250 — empirically fits within 30s statement_timeout
  const ACTUAL_UPSERT_BATCH = 250
  for (let i = 0; i < records.length; i += ACTUAL_UPSERT_BATCH) {
    const batch = records.slice(i, i + ACTUAL_UPSERT_BATCH)
    const result = await safeUpsert(batch)
    inserted += result.sub_inserted
    errors += result.sub_errors
  }

  return { inserted, errors }
}
