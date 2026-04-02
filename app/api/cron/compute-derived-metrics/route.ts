/**
 * GET /api/cron/compute-derived-metrics
 *
 * Computes Sharpe ratio, max drawdown, and win rate from 90-day daily return history.
 * Writes results back to trader_snapshots_v2 via bulk RPC.
 *
 * Schedule: Daily at 00:20 UTC (runs after aggregate-daily-snapshots at 00:05)
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'
import { calculateBeta, calculateAlpha } from '@/lib/utils/market-correlation'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const startTime = Date.now()
  const plog = await PipelineLogger.start('compute-derived-metrics')

  try {
    // Get all active platforms from leaderboard_ranks
    const { data: _platformRows } = await supabase
      .from('leaderboard_ranks')
      .select('source')
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .limit(1)

    // Get distinct platforms from daily snapshots (more reliable)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().split('T')[0]

    // Fetch all platform names from recent daily snapshots
    const { data: distinctPlatforms } = await supabase
      .from('trader_daily_snapshots')
      .select('platform')
      .gte('date', ninetyDaysAgo)
      .limit(50000)

    const platforms = [...new Set((distinctPlatforms || []).map(r => r.platform))]

    if (platforms.length === 0) {
      await plog.success(0)
      return NextResponse.json({ success: true, message: 'No platforms found', updated: 0 })
    }

    // Fetch recent daily returns (last 90 days) per-platform
    const returnsByTrader = new Map<string, number[]>()
    const roiByTrader = new Map<string, number[]>()

    for (const platform of platforms) {
      const { data: platformDaily } = await supabase
        .from('trader_daily_snapshots')
        .select('platform, trader_key, daily_return_pct, roi')
        .eq('platform', platform)
        .gte('date', ninetyDaysAgo)
        .order('date', { ascending: true })
        .limit(10000)

      if (!platformDaily) continue

      for (const row of platformDaily) {
        const key = `${row.platform}:${row.trader_key}`
        if (row.daily_return_pct != null) {
          if (!returnsByTrader.has(key)) returnsByTrader.set(key, [])
          returnsByTrader.get(key)!.push(parseFloat(String(row.daily_return_pct)))
        }
        if (row.roi != null) {
          if (!roiByTrader.has(key)) roiByTrader.set(key, [])
          roiByTrader.get(key)!.push(parseFloat(String(row.roi)))
        }
      }
    }

    if (returnsByTrader.size === 0 && roiByTrader.size === 0) {
      await plog.success(0)
      return NextResponse.json({ success: true, message: 'No daily returns found', updated: 0 })
    }

    // Compute Sharpe ratio from daily returns
    const sharpeUpdates: Array<{ source: string; source_trader_id: string; sharpe_ratio: number }> = []
    // Compute win_rate from daily returns
    const wrUpdates: Array<{ source: string; source_trader_id: string; win_rate: number }> = []

    for (const [key, returns] of returnsByTrader) {
      const [platform, ...traderKeyParts] = key.split(':')
      const trader_key = traderKeyParts.join(':')

      // Sharpe: need at least 7 data points
      if (returns.length >= 7) {
        const mean = returns.reduce((s, r) => s + r, 0) / returns.length
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
        const stdDev = Math.sqrt(variance)
        if (stdDev > 0) {
          const sharpe = (mean / stdDev) * Math.sqrt(365)
          if (sharpe >= -10 && sharpe <= 10) {
            sharpeUpdates.push({
              source: platform,
              source_trader_id: trader_key,
              sharpe_ratio: Math.round(sharpe * 100) / 100,
            })
          }
        }
      }

      // Win rate: need at least 5 trading days
      if (returns.length >= 5) {
        const wins = returns.filter(r => r > 0).length
        const wr = (wins / returns.length) * 100
        wrUpdates.push({ source: platform, source_trader_id: trader_key, win_rate: Math.round(wr * 10) / 10 })
      }
    }

    // Compute max_drawdown from ROI history
    const mddUpdates: Array<{ source: string; source_trader_id: string; max_drawdown: number }> = []
    for (const [key, rois] of roiByTrader) {
      if (rois.length < 3) continue
      let peak = -Infinity
      let maxDD = 0
      for (const roi of rois) {
        const equity = 100 * (1 + roi / 100)
        if (equity > peak) peak = equity
        if (peak > 0) {
          const dd = ((peak - equity) / peak) * 100
          if (dd > maxDD) maxDD = dd
        }
      }
      if (maxDD > 0 && maxDD <= 100) {
        const [platform, ...parts] = key.split(':')
        mddUpdates.push({ source: platform, source_trader_id: parts.join(':'), max_drawdown: Math.round(maxDD * 100) / 100 })
      }
    }

    // ── Compute beta_btc, beta_eth, alpha from daily returns vs market benchmarks ──
    const betaAlphaUpdates: Array<{ key: string; beta_btc: number; beta_eth: number; alpha: number | null }> = []

    // Fetch BTC and ETH daily returns from market_benchmarks table
    const { data: benchmarkRows } = await supabase
      .from('market_benchmarks')
      .select('symbol, date, daily_return_pct')
      .in('symbol', ['BTC', 'ETH'])
      .gte('date', ninetyDaysAgo)
      .order('date', { ascending: true })
      .limit(500)

    const btcReturnsByDate = new Map<string, number>()
    const ethReturnsByDate = new Map<string, number>()
    for (const row of benchmarkRows || []) {
      if (row.daily_return_pct == null) continue
      const val = parseFloat(String(row.daily_return_pct))
      if (row.symbol === 'BTC') btcReturnsByDate.set(row.date, val)
      else if (row.symbol === 'ETH') ethReturnsByDate.set(row.date, val)
    }

    if (btcReturnsByDate.size >= 14 && ethReturnsByDate.size >= 14) {
      // For each trader with daily returns, align dates and compute beta/alpha
      // We need date-aligned returns, so fetch daily snapshots with dates
      const traderDateReturns = new Map<string, Map<string, number>>()

      for (const platform of platforms) {
        const { data: pdRows } = await supabase
          .from('trader_daily_snapshots')
          .select('trader_key, date, daily_return_pct')
          .eq('platform', platform)
          .gte('date', ninetyDaysAgo)
          .not('daily_return_pct', 'is', null)
          .order('date', { ascending: true })
          .limit(10000)

        if (!pdRows) continue
        for (const row of pdRows) {
          if (row.daily_return_pct == null) continue
          const key = `${platform}:${row.trader_key}`
          if (!traderDateReturns.has(key)) traderDateReturns.set(key, new Map())
          traderDateReturns.get(key)!.set(row.date, parseFloat(String(row.daily_return_pct)))
        }
      }

      for (const [key, dateReturns] of traderDateReturns) {
        // Align trader returns with BTC/ETH returns on matching dates
        const traderReturns: number[] = []
        const btcReturns: number[] = []
        const ethReturns: number[] = []

        for (const [date, traderRet] of dateReturns) {
          const btcRet = btcReturnsByDate.get(date)
          const ethRet = ethReturnsByDate.get(date)
          if (btcRet != null && ethRet != null) {
            traderReturns.push(traderRet)
            btcReturns.push(btcRet)
            ethReturns.push(ethRet)
          }
        }

        if (traderReturns.length < 14) continue

        const betaBtc = calculateBeta(traderReturns, btcReturns)
        const betaEth = calculateBeta(traderReturns, ethReturns)

        if (betaBtc == null && betaEth == null) continue

        // Compute alpha (Jensen's Alpha) using total returns
        const traderTotalReturn = traderReturns.reduce((a, b) => a + b, 0)
        const btcTotalReturn = btcReturns.reduce((a, b) => a + b, 0)
        const alpha = betaBtc != null
          ? calculateAlpha(traderTotalReturn, btcTotalReturn, betaBtc, traderReturns.length)
          : null

        betaAlphaUpdates.push({
          key,
          beta_btc: betaBtc ?? 0,
          beta_eth: betaEth ?? 0,
          alpha,
        })
      }

      logger.info(`[compute-derived-metrics] Computed beta/alpha for ${betaAlphaUpdates.length} traders (BTC dates: ${btcReturnsByDate.size}, ETH dates: ${ethReturnsByDate.size})`)
    } else {
      logger.warn(`[compute-derived-metrics] Insufficient benchmark data for beta/alpha (BTC: ${btcReturnsByDate.size} days, ETH: ${ethReturnsByDate.size} days, need 14+)`)
    }

    // Build unified update records for bulk RPC
    const allMetricUpdates: Array<{
      platform: string; trader_key: string; window: string;
      sharpe_ratio: number | null; max_drawdown: number | null; win_rate: number | null;
      beta_btc: number | null; beta_eth: number | null; alpha: number | null;
    }> = []

    const mddByKey = new Map<string, number>()
    for (const upd of mddUpdates) {
      mddByKey.set(`${upd.source}:${upd.source_trader_id}`, upd.max_drawdown)
    }
    const wrByKey = new Map<string, number>()
    for (const upd of wrUpdates) {
      wrByKey.set(`${upd.source}:${upd.source_trader_id}`, upd.win_rate)
    }
    const sharpeByKey = new Map<string, number>()
    for (const upd of sharpeUpdates) {
      sharpeByKey.set(`${upd.source}:${upd.source_trader_id}`, upd.sharpe_ratio)
    }
    const betaAlphaByKey = new Map<string, { beta_btc: number; beta_eth: number; alpha: number | null }>()
    for (const upd of betaAlphaUpdates) {
      betaAlphaByKey.set(upd.key, { beta_btc: upd.beta_btc, beta_eth: upd.beta_eth, alpha: upd.alpha })
    }

    const allTraderKeys = new Set<string>()
    for (const upd of sharpeUpdates) allTraderKeys.add(`${upd.source}:${upd.source_trader_id}`)
    for (const upd of mddUpdates) allTraderKeys.add(`${upd.source}:${upd.source_trader_id}`)
    for (const upd of wrUpdates) allTraderKeys.add(`${upd.source}:${upd.source_trader_id}`)
    for (const upd of betaAlphaUpdates) allTraderKeys.add(upd.key)

    const WINDOWS = ['7D', '30D', '90D']
    for (const compositeKey of allTraderKeys) {
      const [platform, ...parts] = compositeKey.split(':')
      const trader_key = parts.join(':')
      const ba = betaAlphaByKey.get(compositeKey)
      for (const window of WINDOWS) {
        allMetricUpdates.push({
          platform,
          trader_key,
          window,
          sharpe_ratio: sharpeByKey.get(compositeKey) ?? null,
          max_drawdown: mddByKey.get(compositeKey) ?? null,
          win_rate: wrByKey.get(compositeKey) ?? null,
          beta_btc: ba?.beta_btc ?? null,
          beta_eth: ba?.beta_eth ?? null,
          alpha: ba?.alpha ?? null,
        })
      }
    }

    let totalUpdated = 0
    if (allMetricUpdates.length > 0) {
      const RPC_BATCH = 1000
      for (let i = 0; i < allMetricUpdates.length; i += RPC_BATCH) {
        const batch = allMetricUpdates.slice(i, i + RPC_BATCH)
        const { data: count, error: rpcError } = await supabase
          .rpc('bulk_update_snapshot_metrics', { updates: batch })

        if (rpcError) {
          logger.warn(`[compute-derived-metrics] bulk_update_snapshot_metrics RPC error: ${rpcError.message}`)
        } else {
          totalUpdated += (count as number) || 0
        }
      }
    }

    const duration = Date.now() - startTime

    logger.info(`[compute-derived-metrics] Updated ${totalUpdated} rows (sharpe=${sharpeUpdates.length}, mdd=${mddUpdates.length}, wr=${wrUpdates.length}, beta/alpha=${betaAlphaUpdates.length} traders) in ${duration}ms`)

    await plog.success(totalUpdated, {
      sharpeTraders: sharpeUpdates.length,
      mddTraders: mddUpdates.length,
      wrTraders: wrUpdates.length,
      betaAlphaTraders: betaAlphaUpdates.length,
      platforms: platforms.length,
    })

    return NextResponse.json({
      success: true,
      updated: totalUpdated,
      sharpeTraders: sharpeUpdates.length,
      mddTraders: mddUpdates.length,
      wrTraders: wrUpdates.length,
      betaAlphaTraders: betaAlphaUpdates.length,
      platforms: platforms.length,
      duration: `${duration}ms`,
    })
  } catch (error) {
    logger.apiError('/api/cron/compute-derived-metrics', error, {})
    await plog.error(error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
