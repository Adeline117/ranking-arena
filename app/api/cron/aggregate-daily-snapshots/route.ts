/**
 * POST /api/cron/aggregate-daily-snapshots
 *
 * Aggregates end-of-day trader snapshots into daily records for historical analysis.
 * This provides real data for advanced metrics calculation instead of synthetic data.
 *
 * Process:
 * 1. For each active trader, find the last snapshot of the previous day
 * 2. Calculate daily return percentage by comparing with the previous day's snapshot
 * 3. Store the aggregated daily snapshot
 *
 * Schedule: Daily at 00:05 UTC
 * Priority: High (required for accurate metrics)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const BATCH_SIZE = 100

export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const startTime = Date.now()
  let processed = 0
  let inserted = 0
  let errors = 0

  try {
    // Calculate yesterday's date
    const yesterday = new Date()
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const dateStr = yesterday.toISOString().split('T')[0]

    console.log(`[Aggregate Daily Snapshots] Processing date: ${dateStr}`)

    // Get all active traders from trader_sources
    const { data: traders, error: fetchError } = await supabase
      .from('trader_sources')
      .select('source, source_trader_id')
      .not('source_trader_id', 'is', null)

    if (fetchError) {
      console.error('[Aggregate Daily Snapshots] Error fetching traders:', fetchError)
      return NextResponse.json(
        { error: 'Failed to fetch traders', details: fetchError.message },
        { status: 500 }
      )
    }

    if (!traders || traders.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No traders to process',
        date: dateStr,
        processed: 0,
        inserted: 0,
      })
    }

    console.log(`[Aggregate Daily Snapshots] Found ${traders.length} traders to process`)

    // Process traders in batches
    for (let i = 0; i < traders.length; i += BATCH_SIZE) {
      const batch = traders.slice(i, i + BATCH_SIZE)

      for (const trader of batch) {
        try {
          // Get the end-of-day snapshot (closest to 23:59:59 UTC)
          const { data: snapshots, error: snapshotError } = await supabase
            .from('trader_snapshots')
            .select('roi, pnl, win_rate, max_drawdown, followers, trades_count, window')
            .eq('source', trader.source)
            .eq('source_trader_id', trader.source_trader_id)
            .gte('captured_at', `${dateStr}T00:00:00Z`)
            .lt('captured_at', `${dateStr}T23:59:59Z`)
            .order('captured_at', { ascending: false })
            .limit(1)

          if (snapshotError) {
            console.error(`[Aggregate Daily Snapshots] Error fetching snapshot for ${trader.source}:${trader.source_trader_id}:`, snapshotError)
            errors++
            continue
          }

          if (!snapshots || snapshots.length === 0) {
            // No snapshot for this day, skip
            processed++
            continue
          }

          const snapshot = snapshots[0]

          // Get previous day's snapshot to calculate daily return
          const { data: prevDayData, error: prevDayError } = await supabase
            .from('trader_daily_snapshots')
            .select('pnl')
            .eq('platform', trader.source)
            .eq('trader_key', trader.source_trader_id)
            .lt('date', dateStr)
            .order('date', { ascending: false })
            .limit(1)

          if (prevDayError) {
            console.error(`[Aggregate Daily Snapshots] Error fetching previous day for ${trader.source}:${trader.source_trader_id}:`, prevDayError)
          }

          // Calculate daily return percentage
          let dailyReturnPct = null
          if (prevDayData && prevDayData.length > 0 && prevDayData[0].pnl) {
            const prevPnl = parseFloat(prevDayData[0].pnl)
            const currentPnl = parseFloat(snapshot.pnl || '0')
            if (prevPnl !== 0) {
              dailyReturnPct = ((currentPnl - prevPnl) / Math.abs(prevPnl)) * 100
            }
          }

          // Insert or update daily snapshot
          const { error: upsertError } = await supabase
            .from('trader_daily_snapshots')
            .upsert(
              {
                platform: trader.source,
                trader_key: trader.source_trader_id,
                date: dateStr,
                roi: snapshot.roi ? parseFloat(snapshot.roi) : null,
                pnl: snapshot.pnl ? parseFloat(snapshot.pnl) : null,
                daily_return_pct: dailyReturnPct,
                win_rate: snapshot.win_rate ? parseFloat(snapshot.win_rate) : null,
                max_drawdown: snapshot.max_drawdown ? parseFloat(snapshot.max_drawdown) : null,
                followers: snapshot.followers || null,
                trades_count: snapshot.trades_count || null,
                cumulative_pnl: snapshot.pnl ? parseFloat(snapshot.pnl) : null,
              },
              {
                onConflict: 'platform,trader_key,date',
              }
            )

          if (upsertError) {
            console.error(`[Aggregate Daily Snapshots] Error upserting snapshot for ${trader.source}:${trader.source_trader_id}:`, upsertError)
            errors++
          } else {
            inserted++
          }

          processed++
        } catch (error) {
          console.error(`[Aggregate Daily Snapshots] Unexpected error processing trader ${trader.source}:${trader.source_trader_id}:`, error)
          errors++
          processed++
        }
      }

      // Log progress every batch
      console.log(`[Aggregate Daily Snapshots] Progress: ${processed}/${traders.length} traders processed, ${inserted} snapshots inserted`)
    }

    const duration = Date.now() - startTime

    return NextResponse.json({
      success: true,
      date: dateStr,
      processed,
      inserted,
      errors,
      duration: `${duration}ms`,
    })
  } catch (error) {
    console.error('[Aggregate Daily Snapshots] Fatal error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
        processed,
        inserted,
        errors,
      },
      { status: 500 }
    )
  }
}
