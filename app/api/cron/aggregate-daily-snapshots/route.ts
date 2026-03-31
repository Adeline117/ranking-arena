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
export const maxDuration = 600

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

    // Step 1: Fetch ALL current snapshots from trader_snapshots_v2
    // The v2 table has exactly ONE row per (platform, market_type, trader_key, window).
    // as_of_ts is updated on every fetch, so date-range filtering is unreliable
    // (a fetch at 00:01 UTC today overwrites yesterday's as_of_ts).
    // Instead, read ALL current v2 data — it represents the latest known state.
    // Prefer 90D > 30D > 7D window for each trader (longest window = most representative).

    const snapshotMap = new Map<string, {
      source: string
      source_trader_id: string
      roi: number | null
      pnl: number | null
      win_rate: number | null
      max_drawdown: number | null
      followers: number | null
      trades_count: number | null
    }>()

    // Freshness threshold: only include data updated in the last 7 days
    const freshnessThreshold = new Date()
    freshnessThreshold.setUTCDate(freshnessThreshold.getUTCDate() - 7)
    const freshnessStr = freshnessThreshold.toISOString()

    // Window priority: prefer longer windows (more stable metrics)
    const WINDOW_PRIORITY: Record<string, number> = { '90D': 3, '30D': 2, '7D': 1 }
    const windowTracker = new Map<string, number>() // key → current window priority

    // Fetch in pages of 10,000 to handle 30+ platforms × 500+ traders
    const PAGE_SIZE = 10000
    let offset = 0
    let totalFetched = 0

    while (true) {
      const { data: pageData, error: pageError } = await supabase
        .from('trader_snapshots_v2')
        .select('platform, trader_key, window, roi_pct, pnl_usd, win_rate, max_drawdown, followers, trades_count, as_of_ts')
        .gte('as_of_ts', freshnessStr)
        .order('platform', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)

      if (pageError) {
        logger.error(`[aggregate] v2 query error at offset ${offset}: ${pageError.message}`)
        break
      }

      if (!pageData || pageData.length === 0) break

      for (const s of pageData) {
        const key = `${s.platform}:${s.trader_key}`
        const currentPriority = WINDOW_PRIORITY[s.window] || 0
        const existingPriority = windowTracker.get(key) || 0

        if (currentPriority > existingPriority) {
          windowTracker.set(key, currentPriority)
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

      totalFetched += pageData.length
      offset += PAGE_SIZE
      if (pageData.length < PAGE_SIZE) break // last page
    }

    logger.info(`[aggregate] Fetched ${totalFetched} v2 rows → ${snapshotMap.size} unique traders`)

    // Step 2: Fill gaps from leaderboard_ranks (always has 100% roi/pnl coverage)
    // Query all season_ids (90D, 30D, 7D) — some platforms may only have shorter windows
    {
      let filled = 0
      const lrWindowTracker = new Map<string, number>() // track best window per trader

      for (const seasonId of ['90D', '30D', '7D']) {
        const priority = WINDOW_PRIORITY[seasonId] || 0
        const { data: lrRows } = await supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, roi, pnl, win_rate, max_drawdown, followers, trades_count')
          .eq('season_id', seasonId)
          .not('arena_score', 'is', null)
          .limit(50000)

        if (!lrRows) continue

        for (const lr of lrRows) {
          const key = `${lr.source}:${lr.source_trader_id}`
          if (!snapshotMap.has(key)) {
            // Not in v2 — add from LR if this is the best window we've seen
            const existingPriority = lrWindowTracker.get(key) || 0
            if (priority > existingPriority) {
              lrWindowTracker.set(key, priority)
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
            }
          } else {
            // Fill null roi/pnl from LR if v2 had nulls
            const existing = snapshotMap.get(key)!
            if (existing.roi == null && lr.roi != null) existing.roi = lr.roi
            if (existing.pnl == null && lr.pnl != null) existing.pnl = lr.pnl
          }
        }
      }

      if (filled > 0) {
        logger.info(`[aggregate] Filled ${filled} traders from leaderboard_ranks (not in v2)`)
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

    // Step 3: Fetch previous daily snapshots for daily_return_pct computation
    // Query the most recent daily snapshot before today for each trader
    const platforms = [...new Set(Array.from(snapshotMap.values()).map(s => s.source))]

    const prevDataMap = new Map<string, { pnl: number | null; roi: number | null }>()

    // Fetch previous day's snapshots directly from trader_daily_snapshots
    // Use paginated queries per platform to avoid hitting row limits
    for (const platform of platforms) {
      const { data: prevRows, error: prevError } = await supabase
        .from('trader_daily_snapshots')
        .select('platform, trader_key, roi, pnl')
        .eq('platform', platform)
        .lt('date', dateStr)
        .order('date', { ascending: false })
        .limit(5000)

      if (prevError) {
        logger.warn(`[aggregate] prev snapshot query error for ${platform}: ${prevError.message}`)
        continue
      }

      if (prevRows) {
        // Deduplicate: keep only the most recent (first) row per trader_key
        for (const ps of prevRows) {
          const key = `${ps.platform}:${ps.trader_key}`
          if (!prevDataMap.has(key)) {
            prevDataMap.set(key, {
              pnl: ps.pnl != null ? parseFloat(String(ps.pnl)) : null,
              roi: ps.roi != null ? parseFloat(String(ps.roi)) : null,
            })
          }
        }
      }
    }

    logger.info(`[aggregate] Loaded ${prevDataMap.size} previous snapshots for daily_return_pct`)

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
      platforms: platforms.length,
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
