/**
 * GET /api/cron/aggregate-daily-snapshots
 *
 * Aggregates end-of-day trader snapshots into daily records for historical analysis.
 *
 * V2: Batch queries instead of N+1 (was 3 queries per trader → now 3 total queries).
 *
 * Schedule: Daily at 00:05 UTC (Vercel cron sends GET)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const UPSERT_BATCH = 500

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const startTime = Date.now()
  const plog = await PipelineLogger.start('aggregate-daily-snapshots')

  try {
    const yesterday = new Date()
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const dateStr = yesterday.toISOString().split('T')[0]

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
      logger.warn('[aggregate] RPC not available, falling back to paginated query')

      const { data: fallbackData, error: fallbackError } = await supabase
        .from('trader_snapshots')
        .select('source, source_trader_id, roi, pnl, win_rate, max_drawdown, followers, trades_count, captured_at')
        .gte('captured_at', `${dateStr}T00:00:00Z`)
        .lt('captured_at', `${dateStr}T23:59:59Z`)
        .order('captured_at', { ascending: false })
        .limit(50000)

      if (fallbackError || !fallbackData) {
        return NextResponse.json(
          { error: 'Failed to fetch snapshots', details: fallbackError?.message },
          { status: 500 }
        )
      }

      // Deduplicate: keep latest per (source, source_trader_id)
      snapshotMap = new Map()
      for (const s of fallbackData) {
        const key = `${s.source}:${s.source_trader_id}`
        if (!snapshotMap.has(key)) {
          snapshotMap.set(key, s)
        }
      }
    } else {
      snapshotMap = new Map()
      for (const s of snapshots) {
        snapshotMap.set(`${s.source}:${s.source_trader_id}`, s)
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

    // Step 2: Fetch ALL previous daily snapshots in one query
    const _traderKeys = Array.from(snapshotMap.keys())
    const platforms = [...new Set(Array.from(snapshotMap.values()).map(s => s.source))]

    // Get the latest daily snapshot before dateStr for each trader
    const { data: prevSnapshots } = await supabase
      .from('trader_daily_snapshots')
      .select('platform, trader_key, pnl')
      .in('platform', platforms)
      .lt('date', dateStr)
      .order('date', { ascending: false })
      .limit(50000)

    // Build lookup: keep only the latest per trader
    const prevPnlMap = new Map<string, number>()
    if (prevSnapshots) {
      for (const ps of prevSnapshots) {
        const key = `${ps.platform}:${ps.trader_key}`
        if (!prevPnlMap.has(key) && ps.pnl != null) {
          prevPnlMap.set(key, parseFloat(String(ps.pnl)))
        }
      }
    }

    // Step 3: Build upsert records
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
      const prevPnl = prevPnlMap.get(key)

      let dailyReturnPct: number | null = null
      if (prevPnl != null && prevPnl !== 0 && currentPnl != null) {
        dailyReturnPct = ((currentPnl - prevPnl) / Math.abs(prevPnl)) * 100
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

    // Step 4: Compute Sharpe ratio from recent daily snapshots
    // For each trader, get last 30 daily_return_pct values and compute annualized Sharpe
    const tradersForSharpe = records.filter(r => r.daily_return_pct != null)
    if (tradersForSharpe.length > 0) {
      // Fetch recent daily returns (last 90 days) for these traders
      const { data: recentDaily } = await supabase
        .from('trader_daily_snapshots')
        .select('platform, trader_key, daily_return_pct')
        .in('platform', platforms)
        .gte('date', new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().split('T')[0])
        .order('date', { ascending: true })
        .limit(100000)

      if (recentDaily && recentDaily.length > 0) {
        // Group daily returns by trader
        const returnsByTrader = new Map<string, number[]>()
        for (const row of recentDaily) {
          if (row.daily_return_pct == null) continue
          const key = `${row.platform}:${row.trader_key}`
          if (!returnsByTrader.has(key)) returnsByTrader.set(key, [])
          returnsByTrader.get(key)!.push(parseFloat(String(row.daily_return_pct)))
        }

        // Compute Sharpe and batch update trader_snapshots
        const sharpeUpdates: Array<{ source: string; source_trader_id: string; sharpe_ratio: number }> = []
        for (const [key, returns] of returnsByTrader) {
          if (returns.length < 7) continue
          const mean = returns.reduce((s, r) => s + r, 0) / returns.length
          const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
          const stdDev = Math.sqrt(variance)
          if (stdDev === 0) continue
          const sharpe = (mean / stdDev) * Math.sqrt(365)
          if (sharpe < -10 || sharpe > 10) continue
          const [platform, trader_key] = key.split(':')
          sharpeUpdates.push({
            source: platform,
            source_trader_id: trader_key,
            sharpe_ratio: Math.round(sharpe * 100) / 100,
          })
        }

        // Batch update sharpe_ratio in trader_snapshots
        if (sharpeUpdates.length > 0) {
          let sharpeUpdated = 0
          for (let i = 0; i < sharpeUpdates.length; i += 100) {
            const batch = sharpeUpdates.slice(i, i + 100)
            for (const upd of batch) {
              const { error: shErr } = await supabase
                .from('trader_snapshots')
                .update({ sharpe_ratio: upd.sharpe_ratio })
                .eq('source', upd.source)
                .eq('source_trader_id', upd.source_trader_id)
                .is('sharpe_ratio', null)
              if (!shErr) sharpeUpdated++
            }
          }
          logger.info(`[aggregate] Computed Sharpe ratio for ${sharpeUpdated}/${sharpeUpdates.length} traders`)
        }
      }
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
      queries: 3, // vs N*3 before
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
