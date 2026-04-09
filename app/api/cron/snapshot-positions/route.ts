/**
 * Hourly position snapshot for Binance Futures top traders.
 *
 * Unlike batch-enrich (runs every 4h, does everything), this only:
 * 1. Gets top 50 Binance traders from leaderboard_ranks
 * 2. Fetches their current open positions
 * 3. Saves any new positions to trader_position_history
 *
 * Lightweight: ~50 API calls, should complete in <60s
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { isAuthorized } from '@/lib/cron/utils'
import { fetchBinancePositionHistory } from '@/lib/cron/fetchers/enrichment-binance'
import { upsertPositionHistory } from '@/lib/cron/fetchers/enrichment-db'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const CONCURRENCY = 5
const DELAY_BETWEEN_BATCHES_MS = 1000

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('snapshot-positions')
  const startedAt = Date.now()
  // Time budget: bail out before maxDuration (120s) to guarantee plog finalization
  const TIME_BUDGET_MS = 100_000

  try {
    const supabase = getSupabaseAdmin()

    // Query helper with retry — the default Supabase fetch has a 30s AbortSignal,
    // and this query sometimes loses the race against other cron writes (e.g.
    // compute-leaderboard 30D runs at :15, snapshot-positions at :17). Adding
    //   - .not('arena_score', 'is', null)  → lets planner use partial indexes
    //   - .gt('arena_score', 0)             → skips rows with zero score
    //   - retry with exponential backoff    → recovers from transient timeouts
    const queryTraders = async (attempt: number): Promise<Array<{ source_trader_id: string }>> => {
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id')
        .eq('source', 'binance_futures')
        .eq('season_id', '90D')
        .not('arena_score', 'is', null)
        .gt('arena_score', 0)
        .order('arena_score', { ascending: false })
        .limit(50)
      if (error) {
        if (attempt >= 3) throw new Error(`Failed to query traders (attempt ${attempt}): ${error.message}`)
        const backoffMs = 2000 * attempt
        logger.warn(`[snapshot-positions] query attempt ${attempt} failed (${error.message}), retrying in ${backoffMs}ms`)
        await sleep(backoffMs)
        return queryTraders(attempt + 1)
      }
      return data || []
    }

    let traders: Array<{ source_trader_id: string }>
    try {
      traders = await queryTraders(1)
    } catch (queryErr) {
      // Query genuinely failed after 3 attempts — mark as error so plog doesn't
      // leave a 'running' row for cleanup-stuck-logs to sweep 30min later.
      throw queryErr instanceof Error ? queryErr : new Error(String(queryErr))
    }

    if (!traders || traders.length === 0) {
      await plog.success(0, { reason: 'no traders found' })
      return NextResponse.json({ ok: true, traders: 0, positions: 0 })
    }

    const traderIds = traders.map((t) => t.source_trader_id)
    let totalPositions = 0
    let successCount = 0
    let failCount = 0

    // Process in batches of CONCURRENCY with delay between batches
    let timedOut = false
    for (let i = 0; i < traderIds.length; i += CONCURRENCY) {
      // Time budget check — finalize plog.success(partial) before Vercel kills us
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        logger.warn(`[snapshot-positions] time budget exceeded at trader ${i}/${traderIds.length}, finalizing partial`)
        timedOut = true
        break
      }
      const batch = traderIds.slice(i, i + CONCURRENCY)

      const results = await Promise.allSettled(
        batch.map(async (traderId) => {
          const positions = await fetchBinancePositionHistory(traderId)
          if (positions.length > 0) {
            const { saved, error } = await upsertPositionHistory(
              supabase,
              'binance_futures',
              traderId,
              positions
            )
            if (error) {
              logger.warn(`[snapshot-positions] upsert failed for ${traderId}: ${error}`)
              return { traderId, saved: 0, error }
            }
            return { traderId, saved }
          }
          return { traderId, saved: 0 }
        })
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          successCount++
          totalPositions += result.value.saved
        } else {
          failCount++
          logger.warn(`[snapshot-positions] failed: ${result.reason}`)
        }
      }

      // Delay between batches (skip after last batch)
      if (i + CONCURRENCY < traderIds.length) {
        await sleep(DELAY_BETWEEN_BATCHES_MS)
      }
    }

    if (timedOut) {
      await plog.partialSuccess(totalPositions, [`time_budget_exceeded:${successCount}/${traderIds.length}`], {
        traders: traderIds.length,
        success: successCount,
        failed: failCount,
        positions: totalPositions,
        timedOut: true,
      })
    } else {
      await plog.success(totalPositions, {
        traders: traderIds.length,
        success: successCount,
        failed: failCount,
        positions: totalPositions,
      })
    }

    return NextResponse.json({
      ok: true,
      timedOut,
      traders: traderIds.length,
      success: successCount,
      failed: failCount,
      positions: totalPositions,
    })
  } catch (error) {
    await plog.error(error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error(`[snapshot-positions] ${message}`)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
