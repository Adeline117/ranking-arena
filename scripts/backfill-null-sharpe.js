#!/usr/bin/env node
/**
 * Backfill NULL sharpe — batched version
 *
 * Strategy:
 *   1. Per platform: get all NULL-sharpe traders (fast — uses platform index)
 *   2. Per platform: fetch equity curve for all those traders in batched IN queries
 *   3. Group curves by trader, compute sharpe, batch update
 */

const { createClient } = require('@supabase/supabase-js')

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PLATFORMS = [
  'hyperliquid', 'gateio', 'bitunix', 'mexc', 'gmx', 'gains',
  'binance_spot', 'binance_futures', 'jupiter_perps', 'aevo',
  'bitfinex', 'etoro', 'drift', 'bybit', 'dydx', 'btcc',
  'polymarket', 'toobit',
]

const SHARPE_CAP = 20
const MIN_POINTS = 7
const TRADERS_PER_BATCH = 100  // IN clause batch size

function computeSharpe(rois) {
  if (rois.length < MIN_POINTS) return null
  const returns = []
  for (let i = 1; i < rois.length; i++) returns.push(rois[i] - rois[i - 1])
  if (returns.length < 5) return null
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  const std = Math.sqrt(variance)
  if (std < 0.0001) return null
  let sharpe = (mean / std) * Math.sqrt(252)
  sharpe = Math.max(-SHARPE_CAP, Math.min(SHARPE_CAP, sharpe))
  return Math.round(sharpe * 100) / 100
}

async function backfillPlatform(platform) {
  // 1. Get unique traders with NULL sharpe
  const traders = new Set()
  let offset = 0
  while (offset < 20000) {
    const { data, error } = await sb.from('trader_snapshots_v2')
      .select('trader_key')
      .eq('platform', platform)
      .is('sharpe_ratio', null)
      .range(offset, offset + 999)
    if (error || !data || data.length === 0) break
    for (const r of data) traders.add(r.trader_key)
    offset += 1000
    if (data.length < 1000) break
  }

  if (traders.size === 0) return { computed: 0, skipped: 0, traders: 0 }

  const traderArr = [...traders]
  let computed = 0, skipped = 0

  // 2. Batch fetch equity curves (IN clause)
  for (let i = 0; i < traderArr.length; i += TRADERS_PER_BATCH) {
    const batch = traderArr.slice(i, i + TRADERS_PER_BATCH)

    const { data: curves, error } = await sb.from('trader_equity_curve')
      .select('source_trader_id, roi_pct, data_date')
      .eq('source', platform)
      .in('source_trader_id', batch)
      .order('data_date', { ascending: true })
      .limit(10000)

    if (error || !curves) { skipped += batch.length; continue }

    // 3. Group by trader
    const byTrader = new Map()
    for (const c of curves) {
      if (c.roi_pct == null) continue
      if (!byTrader.has(c.source_trader_id)) byTrader.set(c.source_trader_id, new Map())
      byTrader.get(c.source_trader_id).set(c.data_date, parseFloat(c.roi_pct))
    }

    // 4. Compute sharpe per trader and update
    for (const traderKey of batch) {
      const dateMap = byTrader.get(traderKey)
      if (!dateMap || dateMap.size < MIN_POINTS) { skipped++; continue }
      const rois = [...dateMap.values()]
      const sharpe = computeSharpe(rois)
      if (sharpe == null) { skipped++; continue }

      const { error: uerr } = await sb.from('trader_snapshots_v2')
        .update({ sharpe_ratio: sharpe })
        .eq('platform', platform)
        .eq('trader_key', traderKey)
        .is('sharpe_ratio', null)
      if (!uerr) computed++
      else skipped++
    }
  }

  return { computed, skipped, traders: traders.size }
}

async function main() {
  console.log('=== Backfill NULL sharpe (batched) ===\n')
  let grandTotal = 0
  for (const platform of PLATFORMS) {
    process.stdout.write(`${platform}: `)
    try {
      const r = await backfillPlatform(platform)
      grandTotal += r.computed
      console.log(`${r.traders}t ✓${r.computed} skip${r.skipped}`)
    } catch (e) {
      console.log(`ERR ${e.message.slice(0, 50)}`)
    }
  }
  console.log(`\n=== Total backfilled: ${grandTotal} ===`)
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
