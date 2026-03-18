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

  try {
    const supabase = getSupabaseAdmin()

    // Get top 50 binance_futures traders by arena_score
    const { data: traders, error: queryError } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id')
      .eq('source', 'binance_futures')
      .eq('season_id', '90D')
      .order('arena_score', { ascending: false })
      .limit(50)

    if (queryError) {
      throw new Error(`Failed to query traders: ${queryError.message}`)
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
    for (let i = 0; i < traderIds.length; i += CONCURRENCY) {
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

    await plog.success(totalPositions, {
      traders: traderIds.length,
      success: successCount,
      failed: failCount,
      positions: totalPositions,
    })

    return NextResponse.json({
      ok: true,
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
