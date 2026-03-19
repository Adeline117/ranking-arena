#!/usr/bin/env node
/**
 * Backfill trader_stats_detail for all platforms.
 *
 * Two strategies:
 *   1. Platforms WITH enrichment API → call the enrichment endpoint to re-enrich
 *   2. Platforms WITHOUT enrichment → compute from snapshot + equity curve data in DB
 *
 * Usage:
 *   node scripts/backfill-stats-detail.mjs [--platform=xxx] [--dry-run] [--limit=N] [--period=90D] [--force]
 *
 * Options:
 *   --platform=xxx   Only process this platform
 *   --dry-run        Print what would be done, don't write
 *   --limit=N        Limit traders per platform (default: all)
 *   --period=90D     Only backfill this period (default: all 3)
 *   --force          Backfill even if stats_detail row already exists
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

// ============ Config ============

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')
const PLATFORM_FILTER = process.argv.find(a => a.startsWith('--platform='))?.split('=')[1] || null
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0
const PERIOD_FILTER = process.argv.find(a => a.startsWith('--period='))?.split('=')[1] || null

const BATCH_SIZE = 100
const DELAY_MS = 300
const TIMEOUT_MS = 15000

const ALL_PERIODS = ['7D', '30D', '90D']
const PERIODS = PERIOD_FILTER ? [PERIOD_FILTER] : ALL_PERIODS

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Platforms that have enrichment modules (from enrichment-runner.ts ENRICHMENT_PLATFORM_CONFIGS)
const ENRICHED_PLATFORMS = new Set([
  'binance_futures', 'bybit', 'okx_futures', 'okx_spot', 'okx_web3', 'weex',
  'bitget_futures', 'hyperliquid', 'gmx', 'htx_futures', 'gateio', 'mexc',
  'drift', 'dydx', 'aevo', 'gains', 'kwenta', 'jupiter_perps', 'btcc',
  'etoro', 'coinex', 'bitunix', 'xt', 'bitfinex', 'blofin', 'phemex',
  'bingx', 'toobit', 'binance_spot',
])

// Platforms that cannot be enriched at all (no API, no data)
const DEAD_PLATFORMS = new Set([
  'bitmart', 'paradex', 'lbank',
])

// ============ Helpers ============

/**
 * Get all distinct platforms that have traders in snapshots v2
 */
async function getActivePlatforms() {
  const { data, error } = await supabase
    .from('trader_snapshots_v2')
    .select('platform')
    .limit(1000)

  if (error) {
    console.error('Failed to get platforms:', error.message)
    return []
  }

  const platforms = [...new Set(data.map(r => r.platform))].filter(p => !DEAD_PLATFORMS.has(p))
  return platforms.sort()
}

/**
 * Get traders that are MISSING from trader_stats_detail for a given platform+period.
 * Returns array of { trader_key, ... snapshot fields }
 */
async function getMissingTraders(platform, period) {
  const PAGE = 1000
  const allSnapshots = []
  let offset = 0

  // Step 1: Get all trader_keys from snapshots for this platform+period
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('trader_key, win_rate, max_drawdown, sharpe_ratio, trades_count, pnl_usd, roi_pct')
      .eq('platform', platform)
      .eq('window', period)
      .range(offset, offset + PAGE - 1)

    if (error) { console.error(`  DB error: ${error.message}`); break }
    if (!data || data.length === 0) break
    allSnapshots.push(...data)
    if (data.length < PAGE) break
    offset += PAGE
  }

  if (allSnapshots.length === 0) return []

  if (FORCE) return allSnapshots

  // Step 2: Get all trader_keys that already have stats_detail for this platform+period
  const existingKeys = new Set()
  offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_stats_detail')
      .select('source_trader_id')
      .eq('source', platform)
      .eq('period', period)
      .range(offset, offset + PAGE - 1)

    if (error) break
    if (!data || data.length === 0) break
    for (const row of data) existingKeys.add(row.source_trader_id)
    if (data.length < PAGE) break
    offset += PAGE
  }

  // Step 3: Filter to traders missing from stats_detail
  return allSnapshots.filter(s => !existingKeys.has(s.trader_key))
}

/**
 * Compute derived stats from equity curve data in DB.
 * Returns a StatsDetail-compatible object.
 */
async function computeStatsFromEquityCurve(platform, traderId, period) {
  const { data: ec, error } = await supabase
    .from('trader_equity_curve')
    .select('roi_pct, pnl_usd, data_date')
    .eq('source', platform)
    .eq('source_trader_id', traderId)
    .eq('period', period)
    .order('data_date', { ascending: true })
    .limit(200)

  if (error || !ec || ec.length < 3) return null

  const roiValues = ec.map(p => p.roi_pct != null ? parseFloat(String(p.roi_pct)) : null).filter(v => v != null && !isNaN(v))
  const pnlValues = ec.map(p => p.pnl_usd != null ? parseFloat(String(p.pnl_usd)) : null).filter(v => v != null && !isNaN(v))

  const result = {
    sharpeRatio: null,
    maxDrawdown: null,
    currentDrawdown: null,
    volatility: null,
    avgProfit: null,
    avgLoss: null,
    totalTrades: null,
    profitableTradesPct: null,
    avgHoldingTimeHours: null,
    largestWin: null,
    largestLoss: null,
    copiersCount: null,
    copiersPnl: null,
    aum: null,
    winningPositions: null,
    totalPositions: null,
  }

  // Compute avg_profit / avg_loss from daily PnL changes
  if (pnlValues.length >= 3) {
    const dailyChanges = []
    for (let i = 1; i < pnlValues.length; i++) {
      dailyChanges.push(pnlValues[i] - pnlValues[i - 1])
    }

    const gains = dailyChanges.filter(d => d > 0)
    const losses = dailyChanges.filter(d => d < 0)

    if (gains.length > 0) {
      result.avgProfit = Math.round((gains.reduce((s, v) => s + v, 0) / gains.length) * 100) / 100
      result.largestWin = Math.round(Math.max(...gains) * 100) / 100
    }
    if (losses.length > 0) {
      result.avgLoss = Math.round((losses.reduce((s, v) => s + v, 0) / losses.length) * 100) / 100
      result.largestLoss = Math.round(Math.min(...losses) * 100) / 100
    }
  }

  // Use ROI values for MDD, Sharpe, volatility
  const curve = roiValues.length >= 3 ? roiValues : pnlValues
  if (curve.length < 3) return result

  // Max Drawdown
  let peak = -Infinity
  let maxDD = 0
  for (const v of curve) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = roiValues.length >= 3
        ? peak - v                          // ROI: absolute difference in pct
        : ((peak - v) / peak) * 100         // PnL: percentage drawdown
      if (dd > maxDD) maxDD = dd
    }
  }
  if (maxDD > 0) {
    result.maxDrawdown = Math.round(Math.min(maxDD, 100) * 100) / 100
  }

  // Current Drawdown
  if (peak > 0 && curve.length > 0) {
    const last = curve[curve.length - 1]
    const currentDD = roiValues.length >= 3
      ? peak - last
      : ((peak - last) / peak) * 100
    result.currentDrawdown = Math.round(Math.max(0, Math.min(currentDD, 100)) * 100) / 100
  }

  // Sharpe Ratio from daily returns
  const returns = []
  for (let i = 1; i < curve.length; i++) {
    returns.push(curve[i] - curve[i - 1])
  }
  if (returns.length >= 5) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length
    const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length
    const std = Math.sqrt(variance)
    if (std > 0) {
      const sharpe = (mean / std) * Math.sqrt(365)
      if (sharpe > -10 && sharpe < 10) {
        result.sharpeRatio = Math.round(sharpe * 100) / 100
      }
    }

    // Volatility
    result.volatility = Math.round(std * Math.sqrt(365) * 100) / 100
  }

  return result
}

/**
 * Compute winning_positions / total_positions from snapshot win_rate + trades_count
 */
function derivePositionsFromSnapshot(snapshot) {
  const winRate = snapshot.win_rate != null ? parseFloat(String(snapshot.win_rate)) : null
  const tradesCount = snapshot.trades_count != null ? parseInt(String(snapshot.trades_count)) : null

  if (winRate != null && tradesCount != null && tradesCount > 0) {
    const winning = Math.round((winRate / 100) * tradesCount)
    return { winningPositions: winning, totalPositions: tradesCount }
  }
  return { winningPositions: null, totalPositions: null }
}

/**
 * Write a stats detail record to the DB.
 */
async function writeStatsDetail(platform, traderId, period, stats) {
  if (DRY_RUN) return true

  const capturedAt = new Date().toISOString()

  const record = {
    source: platform,
    source_trader_id: traderId,
    period,
    total_trades: stats.totalTrades,
    profitable_trades_pct: stats.profitableTradesPct,
    avg_holding_time_hours: stats.avgHoldingTimeHours,
    avg_profit: stats.avgProfit,
    avg_loss: stats.avgLoss,
    largest_win: stats.largestWin,
    largest_loss: stats.largestLoss,
    sharpe_ratio: stats.sharpeRatio,
    max_drawdown: stats.maxDrawdown,
    current_drawdown: stats.currentDrawdown,
    volatility: stats.volatility,
    copiers_count: stats.copiersCount,
    copiers_pnl: stats.copiersPnl,
    aum: stats.aum,
    winning_positions: stats.winningPositions,
    total_positions: stats.totalPositions,
    captured_at: capturedAt,
  }

  const { error } = await supabase
    .from('trader_stats_detail')
    .upsert(record, {
      onConflict: 'source,source_trader_id,period,captured_at',
    })

  if (error) {
    console.error(`  Write error ${platform}/${traderId}/${period}: ${error.message}`)
    return false
  }
  return true
}

/**
 * Trigger enrichment via API endpoint for a specific platform+period.
 * Returns number of enriched traders.
 */
async function triggerEnrichmentAPI(platform, period, limit = 100, offset = 0) {
  const url = `${APP_BASE_URL}/api/cron/enrich-details?platform=${platform}&period=${period}&limit=${limit}&offset=${offset}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000) // 2 min timeout

  try {
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${process.env.CRON_SECRET}`,
      },
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!resp.ok) {
      console.error(`  Enrichment API returned ${resp.status} for ${platform}/${period}`)
      return 0
    }

    const data = await resp.json()
    return data?.summary?.enriched || 0
  } catch (e) {
    clearTimeout(timer)
    console.error(`  Enrichment API error for ${platform}/${period}: ${e.message}`)
    return 0
  }
}

// ============ Per-platform processing ============

/**
 * Process platforms that have enrichment API modules.
 * Triggers the enrichment endpoint which writes stats_detail automatically.
 */
async function processEnrichedPlatform(platform, period, missingTraders) {
  const total = LIMIT > 0 ? Math.min(missingTraders.length, LIMIT) : missingTraders.length
  console.log(`  [${platform}/${period}] ${missingTraders.length} missing, will enrich ${total} via API`)

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would trigger enrichment for ${total} traders`)
    return { enriched: 0, computed: 0, failed: 0 }
  }

  let enriched = 0
  // Process in batches of BATCH_SIZE via the enrichment API
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const batchLimit = Math.min(BATCH_SIZE, total - offset)
    const result = await triggerEnrichmentAPI(platform, period, batchLimit, offset)
    enriched += result
    console.log(`  [${platform}/${period}] batch ${offset}-${offset + batchLimit}: enriched ${result}`)
    if (offset + BATCH_SIZE < total) await sleep(2000) // Pause between batches
  }

  return { enriched, computed: 0, failed: total - enriched }
}

/**
 * Process platforms WITHOUT enrichment API.
 * Computes stats from existing equity curve + snapshot data.
 */
async function processUnenrichedPlatform(platform, period, missingTraders) {
  const traders = LIMIT > 0 ? missingTraders.slice(0, LIMIT) : missingTraders
  console.log(`  [${platform}/${period}] ${missingTraders.length} missing, will compute ${traders.length} from DB`)

  let computed = 0
  let failed = 0

  for (let i = 0; i < traders.length; i += BATCH_SIZE) {
    const batch = traders.slice(i, i + BATCH_SIZE)

    const results = await Promise.allSettled(
      batch.map(async (trader) => {
        const traderId = trader.trader_key

        // 1. Try to compute from equity curve
        let stats = await computeStatsFromEquityCurve(platform, traderId, period)

        if (!stats) {
          // Initialize empty stats
          stats = {
            sharpeRatio: null, maxDrawdown: null, currentDrawdown: null,
            volatility: null, avgProfit: null, avgLoss: null,
            totalTrades: null, profitableTradesPct: null,
            avgHoldingTimeHours: null, largestWin: null, largestLoss: null,
            copiersCount: null, copiersPnl: null, aum: null,
            winningPositions: null, totalPositions: null,
          }
        }

        // 2. Fill in sharpe_ratio from snapshot if not computed
        if (stats.sharpeRatio == null && trader.sharpe_ratio != null) {
          stats.sharpeRatio = parseFloat(String(trader.sharpe_ratio))
        }

        // 3. Fill in max_drawdown from snapshot if not computed
        if (stats.maxDrawdown == null && trader.max_drawdown != null) {
          stats.maxDrawdown = parseFloat(String(trader.max_drawdown))
        }

        // 4. Derive winning_positions / total_positions from win_rate + trades_count
        const { winningPositions, totalPositions } = derivePositionsFromSnapshot(trader)
        if (stats.winningPositions == null) stats.winningPositions = winningPositions
        if (stats.totalPositions == null) stats.totalPositions = totalPositions

        // 5. Derive profitableTradesPct from snapshot win_rate
        if (stats.profitableTradesPct == null && trader.win_rate != null) {
          stats.profitableTradesPct = parseFloat(String(trader.win_rate))
        }

        // 6. Derive totalTrades from snapshot trades_count
        if (stats.totalTrades == null && trader.trades_count != null) {
          stats.totalTrades = parseInt(String(trader.trades_count))
        }

        // Check if we have at least some data worth writing
        const hasAnyData = Object.values(stats).some(v => v != null)
        if (!hasAnyData) return { status: 'skip' }

        const ok = await writeStatsDetail(platform, traderId, period, stats)
        return { status: ok ? 'ok' : 'fail' }
      })
    )

    for (const result of results) {
      if (result.status === 'rejected') { failed++; continue }
      const { status } = result.value
      if (status === 'ok') computed++
      else if (status === 'fail') failed++
      // skip = no data to write
    }

    // Progress
    const done = Math.min(i + batch.length, traders.length)
    if (done % 200 === 0 || done === traders.length) {
      console.log(`  [${platform}/${period}] ${done}/${traders.length} (computed=${computed} failed=${failed})`)
    }

    if (i + BATCH_SIZE < traders.length) await sleep(DELAY_MS)
  }

  return { enriched: 0, computed, failed }
}

// ============ Main ============

async function main() {
  console.log('=== Backfill trader_stats_detail ===')
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${FORCE ? ' (FORCE overwrite)' : ''}`)
  if (PLATFORM_FILTER) console.log(`Platform filter: ${PLATFORM_FILTER}`)
  if (PERIOD_FILTER) console.log(`Period filter: ${PERIOD_FILTER}`)
  if (LIMIT) console.log(`Limit per platform/period: ${LIMIT}`)

  // Get initial counts
  const { count: totalSnapshots } = await supabase
    .from('trader_snapshots_v2')
    .select('id', { count: 'exact', head: true })

  const { count: totalStatsDetail } = await supabase
    .from('trader_stats_detail')
    .select('id', { count: 'exact', head: true })

  console.log(`\n--- Initial state ---`)
  console.log(`trader_snapshots_v2 rows: ${totalSnapshots}`)
  console.log(`trader_stats_detail rows: ${totalStatsDetail}`)

  // Get platforms to process
  let platforms
  if (PLATFORM_FILTER) {
    platforms = [PLATFORM_FILTER]
  } else {
    platforms = await getActivePlatforms()
  }

  console.log(`\nProcessing ${platforms.length} platforms: ${platforms.join(', ')}`)

  const allResults = []

  for (const platform of platforms) {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`[${platform}] ${ENRICHED_PLATFORMS.has(platform) ? 'ENRICHMENT API' : 'COMPUTE FROM DB'}`)
    console.log('='.repeat(60))

    for (const period of PERIODS) {
      const missingTraders = await getMissingTraders(platform, period)

      if (missingTraders.length === 0) {
        console.log(`  [${platform}/${period}] No missing traders, skipping`)
        continue
      }

      let result
      if (ENRICHED_PLATFORMS.has(platform)) {
        result = await processEnrichedPlatform(platform, period, missingTraders)
      } else {
        result = await processUnenrichedPlatform(platform, period, missingTraders)
      }

      allResults.push({ platform, period, missing: missingTraders.length, ...result })
    }
  }

  // Final report
  console.log('\n\n' + '='.repeat(60))
  console.log('=== FINAL REPORT ===')
  console.log('='.repeat(60))

  const { count: finalStatsDetail } = await supabase
    .from('trader_stats_detail')
    .select('id', { count: 'exact', head: true })

  console.log(`\ntrader_stats_detail: ${totalStatsDetail} -> ${finalStatsDetail} rows (added ${finalStatsDetail - totalStatsDetail})`)

  if (allResults.length > 0) {
    console.log('\nPer-platform summary:')
    let totalEnriched = 0, totalComputed = 0, totalFailed = 0, totalMissing = 0
    for (const r of allResults) {
      const label = `${r.platform}/${r.period}`.padEnd(30)
      console.log(`  ${label} missing=${String(r.missing).padStart(5)} enriched=${String(r.enriched).padStart(4)} computed=${String(r.computed).padStart(4)} failed=${String(r.failed).padStart(4)}`)
      totalEnriched += r.enriched
      totalComputed += r.computed
      totalFailed += r.failed
      totalMissing += r.missing
    }
    console.log(`\n  TOTAL: missing=${totalMissing} enriched=${totalEnriched} computed=${totalComputed} failed=${totalFailed}`)
  } else {
    console.log('\nNo platforms needed backfill.')
  }
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
