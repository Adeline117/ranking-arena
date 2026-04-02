/**
 * GET /api/cron/aggregate-daily-snapshots
 *
 * Aggregates end-of-day trader snapshots into daily records for historical analysis.
 * Core daily snapshot collection: fetch yesterday's data, gap-fill from leaderboard_ranks,
 * compute daily_return_pct, and upsert to trader_daily_snapshots.
 *
 * Derived metrics (Sharpe/MDD/WR) are computed by /api/cron/compute-derived-metrics (00:20 UTC).
 * Cleanup and metric refresh are handled by /api/cron/cleanup-data (01:00 UTC).
 *
 * Schedule: Daily at 00:05 UTC (Vercel cron sends GET)
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const UPSERT_BATCH = 500

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  const startTime = Date.now()
  const plog = await PipelineLogger.start('aggregate-daily-snapshots')

  try {
    const yesterday = new Date()
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const dateStr = yesterday.toISOString().split('T')[0]
    const today = new Date()
    const _todayStr = today.toISOString().split('T')[0]

    // Step 1: Fetch ALL yesterday's snapshots in one query using RPC or direct query
    // Use distinct on (source, source_trader_id) ordered by captured_at desc to get latest per trader
    const { data: snapshots, error: snapshotError } = await supabase
      .rpc('get_latest_snapshots_for_date', { target_date: dateStr })

    let snapshotMap: Map<string, {
      source: string
      source_trader_id: string
      roi: number | null
      pnl: number | null
      win_rate: number | null
      max_drawdown: number | null
      followers: number | null
      trades_count: number | null
    }>

    if (snapshotError || !snapshots) {
      // Fallback: fetch with regular query (less optimal but works without RPC)
      logger.warn('[aggregate] RPC not available, falling back to v2 paginated query')

      // Fetch ALL current snapshots (v2 is a latest-per-trader table, not append-only).
      // Use updated_at > 2 days ago to only get recently-refreshed traders.
      // No upper time bound — cron runs at 00:05 UTC but many platforms refresh after midnight.
      const recentCutoff = new Date()
      recentCutoff.setUTCDate(recentCutoff.getUTCDate() - 2)
      const recentCutoffStr = recentCutoff.toISOString()

      const { data: fallbackData, error: fallbackError } = await supabase
        .from('trader_snapshots_v2')
        .select('platform, trader_key, window, roi_pct, pnl_usd, win_rate, max_drawdown, followers, trades_count, as_of_ts')
        .gte('updated_at', recentCutoffStr)
        .order('updated_at', { ascending: false })
        .limit(50000)

      if (fallbackError || !fallbackData) {
        await plog.error(fallbackError || new Error('No snapshot data returned'))
        return NextResponse.json(
          { error: 'Failed to fetch snapshots', details: fallbackError?.message },
          { status: 500 }
        )
      }

      // Deduplicate: keep latest per (platform, trader_key)
      snapshotMap = new Map()
      for (const s of fallbackData) {
        const key = `${s.platform}:${s.trader_key}`
        if (!snapshotMap.has(key)) {
          snapshotMap.set(key, {
            source: s.platform,
            source_trader_id: s.trader_key,
            roi: s.roi_pct,
            pnl: s.pnl_usd,
            win_rate: s.win_rate,
            max_drawdown: s.max_drawdown,
            followers: s.followers,
            trades_count: s.trades_count,
          })
        }
      }
    } else {
      snapshotMap = new Map()
      for (const s of snapshots) {
        snapshotMap.set(`${s.source}:${s.source_trader_id}`, s)
      }
    }

    // Step 2: Fill gaps from leaderboard_ranks (always has 100% roi/pnl coverage)
    {
      const { data: lrRows } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, roi, pnl, win_rate, max_drawdown, followers, trades_count')
        .eq('season_id', '90D')
        .not('arena_score', 'is', null)
        .limit(50000)
      if (lrRows) {
        let filled = 0
        for (const lr of lrRows) {
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
            // Fill null roi/pnl from LR if v2 had nulls
            const existing = snapshotMap.get(key)!
            if (existing.roi == null && lr.roi != null) existing.roi = lr.roi
            if (existing.pnl == null && lr.pnl != null) existing.pnl = lr.pnl
          }
        }
        if (filled > 0) {
          logger.info(`[aggregate] Filled ${filled} traders from leaderboard_ranks (not in v2)`)
        }
      }
    }

    if (snapshotMap.size === 0) {
      await plog.success(0)
      return NextResponse.json({
        success: true,
        message: 'No snapshots found for yesterday',
        date: dateStr,
        processed: 0,
        inserted: 0,
      })
    }

    // Step 3: Fetch ALL previous daily snapshots in one query
    const platforms = [...new Set(Array.from(snapshotMap.values()).map(s => s.source))]

    const { data: prevSnapshots, error: prevError } = await supabase
      .rpc('get_latest_prev_snapshots', {
        target_platforms: platforms,
        before_date: dateStr,
      })

    if (prevError) {
      logger.warn(`[aggregate] get_latest_prev_snapshots RPC error: ${prevError.message}`)
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
        (currentPnl != null && (Math.abs(currentPnl) > 9999999999999999 || !Number.isFinite(currentPnl))) ||
        (snapshot.win_rate != null && (Math.abs(parseFloat(String(snapshot.win_rate))) > 999 || !Number.isFinite(parseFloat(String(snapshot.win_rate))))) ||
        (snapshot.max_drawdown != null && (Math.abs(parseFloat(String(snapshot.max_drawdown))) > 999 || !Number.isFinite(parseFloat(String(snapshot.max_drawdown)))))
      ) {
        logger.warn(`[aggregate] Skipping record with extreme value: ${key}, roi=${currentRoi}, pnl=${currentPnl}`)
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
        max_drawdown: snapshot.max_drawdown != null ? parseFloat(String(snapshot.max_drawdown)) : null,
        followers: snapshot.followers ?? null,
        trades_count: snapshot.trades_count ?? null,
        cumulative_pnl: currentPnl,
      })
    }

    // Step 5: Batch upsert daily snapshots
    let inserted = 0
    let errors = 0

    for (let i = 0; i < records.length; i += UPSERT_BATCH) {
      const batch = records.slice(i, i + UPSERT_BATCH)
      const { error: upsertError } = await supabase
        .from('trader_daily_snapshots')
        .upsert(batch, { onConflict: 'platform,trader_key,date' })

      if (upsertError) {
        logger.dbError('upsert-daily-snapshots-batch', upsertError, { batchStart: i, batchSize: batch.length })
        errors += batch.length
      } else {
        inserted += batch.length
      }
    }

    const duration = Date.now() - startTime

    if (errors > 0) {
      await plog.error(new Error(`${errors} upsert errors`), { inserted, errors, date: dateStr })
    } else {
      await plog.success(inserted, { date: dateStr })
    }

    return NextResponse.json({
      success: true,
      date: dateStr,
      processed: snapshotMap.size,
      inserted,
      errors,
      queries: 3,
      duration: `${duration}ms`,
    })
  } catch (error) {
    logger.apiError('/api/cron/aggregate-daily-snapshots', error, {})
    await plog.error(error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
