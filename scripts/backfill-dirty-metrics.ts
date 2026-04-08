/**
 * Backfill Dirty Metrics
 *
 * Replaces OUT-OF-BOUNDS sharpe_ratio/max_drawdown/win_rate/roi_pct with
 * clean values computed from trader_equity_curve history.
 *
 * Unlike backfill-all-metrics.ts which only fills NULL, this script targets
 * rows where existing values violate VALIDATION_BOUNDS.
 *
 * Flow:
 *   1. Fetch equity curve history per trader
 *   2. Compute clean sharpe/MDD/WR from daily ROI/PnL deltas
 *   3. For V2 rows with out-of-bounds values, replace with computed clean values
 *   4. If equity curve has insufficient data, NULL the dirty field
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const BATCH_SIZE = 100
const SHARPE_CAP = 10
const MIN_DATA_POINTS = 7

interface EquityPoint {
  data_date: string
  roi_pct: number | null
  pnl_usd: number | null
}

interface ComputedMetrics {
  sharpe_ratio: number | null
  win_rate: number | null
  max_drawdown: number | null
}

function computeMetricsFromCurve(points: EquityPoint[]): ComputedMetrics | null {
  if (points.length < MIN_DATA_POINTS) return null

  const sorted = [...points].sort((a, b) => a.data_date.localeCompare(b.data_date))
  const rois: number[] = []
  for (const p of sorted) {
    if (p.roi_pct != null) rois.push(parseFloat(String(p.roi_pct)))
  }
  if (rois.length < MIN_DATA_POINTS) return null

  // Daily returns (delta)
  const dailyReturns: number[] = []
  for (let i = 1; i < rois.length; i++) {
    dailyReturns.push(rois[i] - rois[i - 1])
  }

  // Win rate
  const wins = dailyReturns.filter(r => r > 0).length
  const winRate = dailyReturns.length > 0
    ? Math.round((wins / dailyReturns.length) * 10000) / 100
    : null

  // Sharpe ratio (annualized, daily data)
  let sharpe: number | null = null
  if (dailyReturns.length >= 5) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
    const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length
    const std = Math.sqrt(variance)
    if (std > 0.0001) {
      // Annualize: sqrt(252) ≈ 15.87
      sharpe = (mean / std) * Math.sqrt(252)
      sharpe = Math.max(-SHARPE_CAP, Math.min(SHARPE_CAP, sharpe))
      sharpe = Math.round(sharpe * 100) / 100
    }
  }

  // Max drawdown (peak-to-trough)
  let maxDD: number | null = null
  if (rois.length >= 3) {
    let peak = rois[0]
    let maxDrawdown = 0
    for (const r of rois) {
      if (r > peak) peak = r
      const dd = peak - r
      if (dd > maxDrawdown) maxDrawdown = dd
    }
    // Cap to [0, 100]
    maxDD = Math.max(0, Math.min(100, maxDrawdown))
    maxDD = Math.round(maxDD * 100) / 100
  }

  return { sharpe_ratio: sharpe, win_rate: winRate, max_drawdown: maxDD }
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  BACKFILL DIRTY METRICS (replace out-of-bounds with clean)`)
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  console.log(`${'='.repeat(60)}\n`)

  // 1. Fetch rows with dirty metrics
  console.log('Fetching dirty V2 rows...')
  const dirtyRows: Array<{
    id: string
    platform: string
    trader_key: string
    window: string
    sharpe_ratio: number | null
    max_drawdown: number | null
    win_rate: number | null
    roi_pct: number | null
  }> = []

  // Query each dirty condition separately (single-field filters are faster)
  const seen = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchDirty = async (filter: (q: any) => any) => {
    let offset = 0
    for (let i = 0; i < 50; i++) {
      try {
        let q: any = supabase.from('trader_snapshots_v2')
          .select('id, platform, trader_key, window, sharpe_ratio, max_drawdown, win_rate, roi_pct')
        q = filter(q)
        const { data, error } = await q.range(offset, offset + 500 - 1)
        if (error) { console.warn('  fetch error:', error.message.slice(0, 60)); break }
        if (!data || data.length === 0) break
        for (const row of data) {
          if (!seen.has(row.id)) { seen.add(row.id); dirtyRows.push(row as typeof dirtyRows[number]) }
        }
        offset += 500
        process.stdout.write('.')
        if (data.length < 500) break
      } catch (e) { console.warn('  exception:', (e as Error).message); break }
    }
  }

  process.stdout.write('sharpe>10: ')
  await fetchDirty(q => q.gt('sharpe_ratio', 10) as unknown as typeof q)
  console.log()
  process.stdout.write('sharpe<-10: ')
  await fetchDirty(q => q.lt('sharpe_ratio', -10) as unknown as typeof q)
  console.log()
  process.stdout.write('mdd>100: ')
  await fetchDirty(q => q.gt('max_drawdown', 100) as unknown as typeof q)
  console.log()
  process.stdout.write('wr>100: ')
  await fetchDirty(q => q.gt('win_rate', 100) as unknown as typeof q)
  console.log()
  console.log(`\nDirty rows: ${dirtyRows.length}`)

  if (dirtyRows.length === 0) {
    console.log('✅ No dirty rows. Done.')
    return
  }

  // 2. Group by trader for equity curve lookup
  const traderSet = new Set<string>()
  for (const r of dirtyRows) traderSet.add(`${r.platform}:${r.trader_key}`)
  console.log(`Unique dirty traders: ${traderSet.size}`)

  // 3. Fetch equity curves for dirty traders (only those with equity data)
  console.log('Fetching equity curves for dirty traders...')
  const computedByTrader = new Map<string, ComputedMetrics>()
  let checked = 0

  for (const key of traderSet) {
    const [source, source_trader_id] = key.split(':')
    const { data: curve } = await supabase
      .from('trader_equity_curve')
      .select('data_date, roi_pct, pnl_usd')
      .eq('source', source)
      .eq('source_trader_id', source_trader_id)
      .order('data_date', { ascending: true })
      .limit(100)

    if (curve && curve.length >= MIN_DATA_POINTS) {
      const metrics = computeMetricsFromCurve(curve as EquityPoint[])
      if (metrics) computedByTrader.set(key, metrics)
    }
    checked++
    if (checked % 100 === 0) process.stdout.write('.')
  }
  console.log(`\nComputed clean metrics for ${computedByTrader.size}/${traderSet.size} traders`)

  // 4. Build updates
  let updates = 0, nulled = 0
  for (const row of dirtyRows) {
    const key = `${row.platform}:${row.trader_key}`
    const computed = computedByTrader.get(key)

    const fields: Record<string, unknown> = {}

    // Sharpe
    if (row.sharpe_ratio != null && (row.sharpe_ratio > 10 || row.sharpe_ratio < -10)) {
      fields.sharpe_ratio = computed?.sharpe_ratio ?? null
    }
    // MDD
    if (row.max_drawdown != null && (row.max_drawdown > 100 || row.max_drawdown < 0)) {
      fields.max_drawdown = computed?.max_drawdown ?? null
    }
    // WR
    if (row.win_rate != null && (row.win_rate > 100 || row.win_rate < 0)) {
      fields.win_rate = computed?.win_rate ?? null
    }
    // ROI
    if (row.roi_pct != null && (row.roi_pct > 10000 || row.roi_pct < -10000)) {
      fields.roi_pct = null // ROI can't be recomputed, just null
    }

    if (Object.keys(fields).length === 0) continue

    if (DRY_RUN) {
      if (updates < 5) console.log(`  ${row.platform}/${row.trader_key.slice(0, 12)}:`, fields)
    } else {
      const { error } = await supabase
        .from('trader_snapshots_v2')
        .update(fields)
        .eq('id', row.id)
      if (error) { console.warn('Update error:', error.message.slice(0, 80)); continue }
    }

    const hasBackfill = Object.values(fields).some(v => v != null)
    if (hasBackfill) updates++
    else nulled++
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  Updated with clean values: ${updates}`)
  console.log(`  Set to NULL (no curve data): ${nulled}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
