/**
 * Comprehensive Metrics Backfill Script
 *
 * Computes ALL missing metrics from equity curve data:
 * - sharpe_ratio: annualized Sharpe from daily ROI deltas
 * - win_rate: % of profitable days
 * - max_drawdown: peak-to-trough drawdown from ROI series
 * - trades_count: count of active trading days
 * - arena_score: for rows with ROI but no score
 * - followers: set to 0 for DEX platforms where null
 *
 * Usage:
 *   npx tsx scripts/backfill-all-metrics.ts           # Run backfill
 *   npx tsx scripts/backfill-all-metrics.ts --dry-run  # Preview only
 *
 * Data sources:
 *   trader_equity_curve (656K rows) → sharpe, win_rate, max_drawdown, trades_count
 *   trader_snapshots_v2 (21K rows/window) → update null fields
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

// ============================================
// Config
// ============================================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const BATCH_SIZE = 100
const LOG_INTERVAL = 500
const PAGE_SIZE = 5000
const MIN_DATA_POINTS = 7
const SHARPE_CAP = 20
const WINDOWS = ['7D', '30D', '90D'] as const

const DEX_PLATFORMS = [
  'hyperliquid', 'gmx', 'dydx', 'drift', 'aevo',
  'gains', 'jupiter_perps', 'kwenta', 'vertex',
]

// ============================================
// Arena Score (inline to avoid path alias issues in tsx)
// ============================================

function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function safeLog1p(x: number): number {
  if (x <= -1) return 0
  return Math.log(1 + x)
}

function getPeriodDays(period: string): number {
  switch (period) {
    case '7D': return 7
    case '30D': return 30
    case '90D': return 90
    default: return 30
  }
}

const ARENA_PARAMS: Record<string, { tanhCoeff: number; roiExponent: number }> = {
  '7D':  { tanhCoeff: 0.08, roiExponent: 1.8 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6 },
}

const PNL_PARAMS: Record<string, { base: number; coeff: number }> = {
  '7D':  { base: 300,  coeff: 0.42 },
  '30D': { base: 600,  coeff: 0.30 },
  '90D': { base: 650,  coeff: 0.27 },
}

const ROI_CAP = 10000
const MAX_RETURN_SCORE = 60
const MAX_PNL_SCORE = 40

function calculateArenaScore(roi: number, pnl: number, period: string): number {
  const params = ARENA_PARAMS[period] ?? ARENA_PARAMS['30D']
  const pnlP = PNL_PARAMS[period] ?? PNL_PARAMS['30D']

  // Return score
  const cappedRoi = Math.min(roi, ROI_CAP)
  const days = getPeriodDays(period)
  const intensity = (365 / days) * safeLog1p(cappedRoi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 <= 0 ? 0 : clip(MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, MAX_RETURN_SCORE)

  // PnL score
  let pnlScore = 0
  if (pnl > 0) {
    const logArg = 1 + pnl / pnlP.base
    if (logArg > 0) {
      pnlScore = clip(MAX_PNL_SCORE * Math.tanh(pnlP.coeff * Math.log(logArg)), 0, MAX_PNL_SCORE)
    }
  }

  const total = clip(returnScore + pnlScore, 0, 100)
  return Math.round(total * 100) / 100
}

// ============================================
// Metric computation from equity curve
// ============================================

interface EquityPoint {
  data_date: string
  roi_pct: number | null
  pnl_usd: number | null
}

interface ComputedMetrics {
  sharpe_ratio: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number
}

function computeMetrics(points: EquityPoint[]): ComputedMetrics | null {
  // Sort by date ascending
  const sorted = [...points].sort((a, b) => a.data_date.localeCompare(b.data_date))

  // Extract ROI values (skip nulls)
  const rois: number[] = []
  for (const p of sorted) {
    if (p.roi_pct != null) {
      rois.push(parseFloat(String(p.roi_pct)))
    }
  }

  if (rois.length < MIN_DATA_POINTS) return null

  const trades_count = rois.length

  // Daily returns: difference between consecutive ROI values
  const dailyReturns: number[] = []
  for (let i = 1; i < rois.length; i++) {
    dailyReturns.push(rois[i] - rois[i - 1])
  }

  if (dailyReturns.length < 3) return null

  // Sharpe ratio: annualized
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length
  const stdDev = Math.sqrt(variance)
  let sharpe_ratio: number | null = null
  if (stdDev > 0) {
    const rawSharpe = (mean / stdDev) * Math.sqrt(365)
    sharpe_ratio = clip(Math.round(rawSharpe * 100) / 100, -SHARPE_CAP, SHARPE_CAP)
  }

  // Win rate: % of positive daily returns
  const wins = dailyReturns.filter(r => r > 0).length
  const win_rate = Math.round((wins / dailyReturns.length) * 1000) / 10 // one decimal

  // Max drawdown: peak-to-trough from ROI series (convert to equity curve)
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
  const max_drawdown = maxDD > 0 && maxDD <= 100
    ? Math.round(maxDD * 100) / 100
    : null

  return { sharpe_ratio, win_rate, max_drawdown, trades_count }
}

// ============================================
// Fetch all equity curve data grouped by trader
// ============================================

async function fetchEquityCurves(): Promise<Map<string, EquityPoint[]>> {
  console.log('Fetching equity curve data...')
  const traderCurves = new Map<string, EquityPoint[]>()

  let offset = 0
  let total = 0

  while (true) {
    const { data, error } = await supabase
      .from('trader_equity_curve')
      .select('source, source_trader_id, period, data_date, roi_pct, pnl_usd')
      .order('source', { ascending: true })
      .order('source_trader_id', { ascending: true })
      .order('data_date', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) {
      console.error('Error fetching equity curves:', error.message)
      break
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      // Use the longest available period for the most data
      const key = `${row.source}:${row.source_trader_id}`
      if (!traderCurves.has(key)) traderCurves.set(key, [])
      traderCurves.get(key)!.push({
        data_date: row.data_date,
        roi_pct: row.roi_pct,
        pnl_usd: row.pnl_usd,
      })
    }

    total += data.length
    offset += PAGE_SIZE
    if (total % 50000 === 0) console.log(`  ...fetched ${total} equity curve rows`)
    if (data.length < PAGE_SIZE) break
  }

  // Deduplicate by date within each trader (keep latest)
  for (const [key, points] of traderCurves) {
    const seen = new Map<string, EquityPoint>()
    for (const p of points) {
      seen.set(p.data_date, p) // last write wins
    }
    traderCurves.set(key, Array.from(seen.values()))
  }

  console.log(`Fetched ${total} equity curve rows for ${traderCurves.size} traders`)
  return traderCurves
}

// ============================================
// Fetch v2 snapshots with null fields
// ============================================

interface V2Snapshot {
  id: string
  platform: string
  trader_key: string
  window: string
  roi_pct: number | null
  pnl_usd: number | null
  sharpe_ratio: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  arena_score: number | null
  followers: number | null
  metrics: Record<string, unknown> | null
}

async function fetchV2Snapshots(): Promise<V2Snapshot[]> {
  console.log('Fetching trader_snapshots_v2 with null metrics...')
  const allRows: V2Snapshot[] = []
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('id, platform, trader_key, window, roi_pct, pnl_usd, sharpe_ratio, win_rate, max_drawdown, trades_count, arena_score, followers, metrics')
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) {
      console.error('Error fetching v2 snapshots:', error.message)
      break
    }
    if (!data || data.length === 0) break

    allRows.push(...(data as V2Snapshot[]))
    offset += PAGE_SIZE
    if (data.length < PAGE_SIZE) break
  }

  console.log(`Fetched ${allRows.length} v2 snapshot rows`)
  return allRows
}

// ============================================
// Main backfill logic
// ============================================

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  COMPREHENSIVE METRICS BACKFILL`)
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`)
  console.log(`${'='.repeat(60)}\n`)

  const startTime = Date.now()

  // Step 1: Fetch equity curves and v2 snapshots in parallel
  const [equityCurves, v2Snapshots] = await Promise.all([
    fetchEquityCurves(),
    fetchV2Snapshots(),
  ])

  // Step 2: Compute metrics for each trader from equity curves
  console.log('\nComputing metrics from equity curves...')
  const computedByTrader = new Map<string, ComputedMetrics>()
  let computed = 0
  let skipped = 0

  for (const [key, points] of equityCurves) {
    const metrics = computeMetrics(points)
    if (metrics) {
      computedByTrader.set(key, metrics)
      computed++
    } else {
      skipped++
    }
  }

  console.log(`Computed metrics for ${computed} traders (${skipped} skipped due to insufficient data)`)

  // Step 3: Build update batches
  const updates: Array<{
    id: string
    fields: Record<string, unknown>
    platform: string
    trader_key: string
    window: string
  }> = []

  let statsMetrics = { sharpe: 0, winRate: 0, maxDD: 0, tradesCount: 0, arenaScore: 0, followers: 0 }

  for (const snap of v2Snapshots) {
    const key = `${snap.platform}:${snap.trader_key}`
    const computed = computedByTrader.get(key)
    const updateFields: Record<string, unknown> = {}

    // Fill from equity curve computed metrics (only if currently null)
    if (computed) {
      if (snap.sharpe_ratio == null && computed.sharpe_ratio != null) {
        updateFields.sharpe_ratio = computed.sharpe_ratio
        statsMetrics.sharpe++
      }
      if (snap.win_rate == null && computed.win_rate != null) {
        updateFields.win_rate = computed.win_rate
        statsMetrics.winRate++
      }
      if (snap.max_drawdown == null && computed.max_drawdown != null) {
        updateFields.max_drawdown = computed.max_drawdown
        statsMetrics.maxDD++
      }
      if (snap.trades_count == null) {
        updateFields.trades_count = computed.trades_count
        statsMetrics.tradesCount++
      }
    }

    // Compute arena_score for rows with ROI but no score
    if (snap.arena_score == null && snap.roi_pct != null) {
      const roi = parseFloat(String(snap.roi_pct))
      const pnl = snap.pnl_usd != null ? parseFloat(String(snap.pnl_usd)) : 0
      if (!isNaN(roi)) {
        updateFields.arena_score = calculateArenaScore(roi, pnl, snap.window)
        statsMetrics.arenaScore++
      }
    }

    // Set followers to 0 for DEX platforms where null
    if (snap.followers == null && DEX_PLATFORMS.includes(snap.platform)) {
      updateFields.followers = 0
      statsMetrics.followers++
    }

    // Update metrics JSONB with computed values
    if (Object.keys(updateFields).length > 0) {
      // Merge into existing metrics JSONB
      const existingMetrics = (snap.metrics as Record<string, unknown>) ?? {}
      const newMetrics = { ...existingMetrics }

      if (updateFields.sharpe_ratio != null) newMetrics.sharpe_ratio = updateFields.sharpe_ratio
      if (updateFields.win_rate != null) newMetrics.win_rate = updateFields.win_rate
      if (updateFields.max_drawdown != null) newMetrics.max_drawdown = updateFields.max_drawdown
      if (updateFields.trades_count != null) newMetrics.trades_count = updateFields.trades_count

      // Only set metrics if we added something new
      if (Object.keys(newMetrics).length > Object.keys(existingMetrics).length) {
        updateFields.metrics = newMetrics
      }

      updates.push({
        id: snap.id,
        fields: updateFields,
        platform: snap.platform,
        trader_key: snap.trader_key,
        window: snap.window,
      })
    }
  }

  console.log(`\nUpdate plan:`)
  console.log(`  sharpe_ratio:  ${statsMetrics.sharpe} rows`)
  console.log(`  win_rate:      ${statsMetrics.winRate} rows`)
  console.log(`  max_drawdown:  ${statsMetrics.maxDD} rows`)
  console.log(`  trades_count:  ${statsMetrics.tradesCount} rows`)
  console.log(`  arena_score:   ${statsMetrics.arenaScore} rows`)
  console.log(`  followers:     ${statsMetrics.followers} rows`)
  console.log(`  Total updates: ${updates.length} rows`)

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No writes performed. Showing first 20 updates:')
    for (const upd of updates.slice(0, 20)) {
      console.log(`  ${upd.platform}/${upd.trader_key} (${upd.window}):`, upd.fields)
    }
    console.log(`\nDone. ${Date.now() - startTime}ms elapsed.`)
    return
  }

  // Step 4: Execute updates in batches
  console.log(`\nApplying ${updates.length} updates in batches of ${BATCH_SIZE}...`)
  let applied = 0
  let errors = 0

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(upd =>
        supabase
          .from('trader_snapshots_v2')
          .update(upd.fields)
          .eq('id', upd.id)
      )
    )

    for (const result of results) {
      if (result.error) {
        errors++
        if (errors <= 5) console.error('  Update error:', result.error.message)
      } else {
        applied++
      }
    }

    if ((i + BATCH_SIZE) % LOG_INTERVAL < BATCH_SIZE || i + BATCH_SIZE >= updates.length) {
      console.log(`  Progress: ${Math.min(i + BATCH_SIZE, updates.length)}/${updates.length} (${applied} applied, ${errors} errors)`)
    }
  }

  // Step 5: Also sync key metrics to legacy trader_snapshots table
  console.log('\nSyncing to legacy trader_snapshots...')
  let legacySynced = 0

  // Group updates by platform+trader_key (collapse windows)
  const byTrader = new Map<string, Record<string, unknown>>()
  for (const upd of updates) {
    const key = `${upd.platform}:${upd.trader_key}`
    if (!byTrader.has(key)) byTrader.set(key, {})
    const existing = byTrader.get(key)!
    // Only sync certain fields to legacy
    if (upd.fields.sharpe_ratio != null && !existing.sharpe_ratio) existing.sharpe_ratio = upd.fields.sharpe_ratio
    if (upd.fields.win_rate != null && !existing.win_rate) existing.win_rate = upd.fields.win_rate
    if (upd.fields.max_drawdown != null && !existing.max_drawdown) existing.max_drawdown = upd.fields.max_drawdown
    if (upd.fields.trades_count != null && !existing.trades_count) existing.trades_count = upd.fields.trades_count
  }

  const legacyUpdates = Array.from(byTrader.entries())
  for (let i = 0; i < legacyUpdates.length; i += BATCH_SIZE) {
    const batch = legacyUpdates.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(([key, fields]) => {
        const [platform, ...parts] = key.split(':')
        const traderId = parts.join(':')
        return supabase
          .from('trader_snapshots')
          .update(fields)
          .eq('source', platform)
          .eq('source_trader_id', traderId)
      })
    )
    legacySynced += results.filter(r => !r.error).length
  }

  console.log(`Synced ${legacySynced}/${legacyUpdates.length} traders to legacy table`)

  // Final report
  const duration = Date.now() - startTime
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  BACKFILL COMPLETE`)
  console.log(`  Applied: ${applied}, Errors: ${errors}`)
  console.log(`  Legacy synced: ${legacySynced}`)
  console.log(`  Duration: ${(duration / 1000).toFixed(1)}s`)
  console.log(`${'='.repeat(60)}\n`)

  // Verify final null counts
  console.log('Verifying final null counts...')
  for (const window of WINDOWS) {
    const { count: totalCount } = await supabase
      .from('trader_snapshots_v2')
      .select('id', { count: 'exact', head: true })
      .eq('window', window)

    const { count: nullSharpe } = await supabase
      .from('trader_snapshots_v2')
      .select('id', { count: 'exact', head: true })
      .eq('window', window)
      .is('sharpe_ratio', null)

    const { count: nullWr } = await supabase
      .from('trader_snapshots_v2')
      .select('id', { count: 'exact', head: true })
      .eq('window', window)
      .is('win_rate', null)

    const { count: nullMdd } = await supabase
      .from('trader_snapshots_v2')
      .select('id', { count: 'exact', head: true })
      .eq('window', window)
      .is('max_drawdown', null)

    const { count: nullScore } = await supabase
      .from('trader_snapshots_v2')
      .select('id', { count: 'exact', head: true })
      .eq('window', window)
      .is('arena_score', null)

    console.log(`  ${window}: total=${totalCount}, null sharpe=${nullSharpe}, null wr=${nullWr}, null mdd=${nullMdd}, null score=${nullScore}`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
