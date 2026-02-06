/**
 * POST /api/cron/fetch-bybit-traders
 *
 * Fetches trader data from Bybit using official API
 * Replaces web scraping for Bybit exchange
 *
 * Schedule: Every 15 minutes for top traders
 * Priority: P0 (Tier 1 exchange)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { BybitAdapter } from '@/lib/adapters/bybit-adapter'
import { ExchangeRateLimiters } from '@/lib/ratelimit/exchange-limiter'
import { logger } from '@/lib/logger'
import { calculateArenaScore } from '@/lib/utils/arena-score'
import type { Period } from '@/lib/utils/arena-score'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const BATCH_SIZE = 50 // Process 50 traders at a time
const TOP_TRADERS_LIMIT = 200 // Fetch top 200 traders

export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  let fetched = 0
  let inserted = 0
  let updated = 0
  let errors = 0

  try {
    console.log('[Fetch Bybit Traders] Starting...')

    // Initialize Bybit adapter
    const adapter = new BybitAdapter({
      apiKey: process.env.BYBIT_API_KEY!,
      apiSecret: process.env.BYBIT_API_SECRET!,
    })

    // Get rate limiter
    const limiter = ExchangeRateLimiters.get('bybit')

    // Initialize Supabase client
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Health check
    const isHealthy = await adapter.healthCheck()
    if (!isHealthy) {
      logger.apiError('/api/cron/fetch-bybit-traders', new Error('Bybit API health check failed'), {})
      return NextResponse.json(
        { error: 'Bybit API is not healthy' },
        { status: 503 }
      )
    }

    console.log('[Fetch Bybit Traders] Health check passed')

    // Fetch leaderboard
    const leaderboard = await limiter.execute(
      () =>
        adapter.fetchLeaderboard({
          platform: 'bybit',
          limit: TOP_TRADERS_LIMIT,
          sortBy: 'roi',
        }),
      'cron-fetch-leaderboard'
    )

    console.log(`[Fetch Bybit Traders] Fetched ${leaderboard.traders.length} traders from API`)

    // Process traders in batches
    for (let i = 0; i < leaderboard.traders.length; i += BATCH_SIZE) {
      const batch = leaderboard.traders.slice(i, i + BATCH_SIZE)

      for (const trader of batch) {
        try {
          // Check if trader exists
          const { data: existing } = await supabase
            .from('trader_sources')
            .select('id')
            .eq('source', 'bybit')
            .eq('source_trader_id', trader.traderId)
            .single()

          const traderData = {
            source: 'bybit',
            source_trader_id: trader.traderId,
            nickname: trader.nickname,
            avatar_url: trader.avatar,
            description: trader.description,
            verified: trader.verified,
            last_updated: new Date().toISOString(),
          }

          if (existing) {
            // Update existing trader
            const { error: updateError } = await supabase
              .from('trader_sources')
              .update(traderData)
              .eq('id', existing.id)

            if (updateError) {
              logger.dbError('update-trader', updateError, { traderId: trader.traderId })
              errors++
            } else {
              updated++
            }
          } else {
            // Insert new trader
            const { error: insertError } = await supabase
              .from('trader_sources')
              .insert(traderData)

            if (insertError) {
              logger.dbError('insert-trader', insertError, { traderId: trader.traderId })
              errors++
            } else {
              inserted++
            }
          }

          // Calculate Arena Score
          const period: Period = trader.periodDays === 30 ? '30D' : '7D'
          const arenaScore = calculateArenaScore(
            {
              roi: trader.roi,
              pnl: trader.pnl,
              maxDrawdown: trader.maxDrawdown,
              winRate: trader.winRate,
            },
            period
          )

          // Insert/update snapshot
          // Note: Using season_id (uppercase) to match /api/rankings query
          const { error: snapshotError } = await supabase
            .from('trader_snapshots')
            .upsert(
              {
                source: 'bybit',
                source_trader_id: trader.traderId,
                season_id: period,
                roi: trader.roi,
                pnl: trader.pnl,
                followers: trader.followers,
                copiers: trader.followers, // Bybit uses followers as copiers
                trades_count: trader.tradesCount,
                win_rate: trader.winRate,
                max_drawdown: trader.maxDrawdown,
                arena_score: arenaScore.totalScore,
                return_score: arenaScore.returnScore,
                pnl_score: arenaScore.pnlScore,
                drawdown_score: arenaScore.drawdownScore,
                stability_score: arenaScore.stabilityScore,
                captured_at: new Date().toISOString(),
              },
              {
                onConflict: 'source,source_trader_id,season_id',
              }
            )

          if (snapshotError) {
            logger.dbError('upsert-snapshot', snapshotError, { traderId: trader.traderId })
            errors++
          }

          fetched++
        } catch (error) {
          logger.error('Error processing trader', { traderId: trader.traderId }, error instanceof Error ? error : new Error(String(error)))
          errors++
        }
      }

      // Log progress
      console.log(`[Fetch Bybit Traders] Progress: ${fetched}/${leaderboard.traders.length} processed`)
    }

    const duration = Date.now() - startTime

    // Log rate limiter status
    const limiterStatus = await limiter.getStatus('cron-fetch-leaderboard')
    console.log('[Fetch Bybit Traders] Rate limiter status:', limiterStatus)

    return NextResponse.json({
      success: true,
      platform: 'bybit',
      fetched,
      inserted,
      updated,
      errors,
      duration: `${duration}ms`,
      rateLimitRemaining: limiterStatus.remaining,
    })
  } catch (error) {
    logger.apiError('/api/cron/fetch-bybit-traders', error, {})
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
        fetched,
        inserted,
        updated,
        errors,
      },
      { status: 500 }
    )
  }
}
