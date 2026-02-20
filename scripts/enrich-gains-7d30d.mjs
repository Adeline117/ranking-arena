#!/usr/bin/env node
/**
 * enrich-gains-7d30d.mjs
 * Computes roi_7d, roi_30d, pnl_7d, pnl_30d for gains traders.
 * Uses on-chain trade history from gains.trade backend API.
 * ROI computed as: period_pnl / |initial_equity| * 100
 * where initial_equity = |overall_pnl / overall_roi * 100|
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const CHAIN_IDS = [42161, 137]
const DELAY = 500
const sleep = ms => new Promise(r => setTimeout(r, ms))

const now = Date.now()
const MS_7D = 7 * 24 * 60 * 60 * 1000
const MS_30D = 30 * 24 * 60 * 60 * 1000

async function fetchAllTrades(address, chainId) {
  const trades = []
  let page = 1
  while (true) {
    try {
      const url = `https://backend-global.gains.trade/api/personal-trading-history/${address}?chainId=${chainId}&page=${page}&pageSize=100`
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) break
      const json = await res.json()
      const data = json?.data || []
      if (!Array.isArray(data) || data.length === 0) break
      trades.push(...data)
      if (data.length < 100) break
      page++
      await sleep(200)
    } catch { break }
  }
  return trades
}

function computePeriods(trades, initialEquity) {
  const now = Date.now()
  let pnl_7d = 0, pnl_30d = 0, trades_7d = 0, trades_30d = 0
  let wins_7d = 0, wins_30d = 0

  for (const t of trades) {
    const ts = new Date(t.date).getTime()
    const pnl = parseFloat(t.pnl || 0)
    const age = now - ts

    if (age <= MS_7D) {
      pnl_7d += pnl
      trades_7d++
      if (pnl > 0) wins_7d++
    }
    if (age <= MS_30D) {
      pnl_30d += pnl
      trades_30d++
      if (pnl > 0) wins_30d++
    }
  }

  const roi_7d = initialEquity > 0 ? (pnl_7d / initialEquity) * 100 : null
  const roi_30d = initialEquity > 0 ? (pnl_30d / initialEquity) * 100 : null

  return {
    pnl_7d: Math.round(pnl_7d * 100) / 100,
    pnl_30d: Math.round(pnl_30d * 100) / 100,
    roi_7d: roi_7d !== null ? Math.round(roi_7d * 100) / 100 : null,
    roi_30d: roi_30d !== null ? Math.round(roi_30d * 100) / 100 : null,
    win_rate_7d: trades_7d > 0 ? Math.round((wins_7d / trades_7d) * 10000) / 100 : null,
    win_rate_30d: trades_30d > 0 ? Math.round((wins_30d / trades_30d) * 10000) / 100 : null,
  }
}

async function main() {
  console.log('=== Gains 7d/30d Enrichment ===')

  const { data: snaps, error } = await sb
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, roi_7d, roi_30d')
    .eq('source', 'gains')
    .or('roi_7d.is.null,roi_30d.is.null')
    .not('roi', 'is', null)
    .not('pnl', 'is', null)

  if (error) { console.error(error.message); process.exit(1) }
  console.log(`Snapshots to process: ${snaps.length}`)

  let updated = 0, noData = 0, failed = 0

  for (let i = 0; i < snaps.length; i++) {
    const snap = snaps[i]
    if (i % 100 === 0) console.log(`[${i}/${snaps.length}] updated=${updated}`)

    // Compute initial equity from roi and pnl
    // roi = pnl / equity * 100 => equity = pnl / roi * 100
    const roi = parseFloat(snap.roi)
    const pnl = parseFloat(snap.pnl)
    if (!roi || !pnl || Math.abs(roi) < 0.01) { noData++; continue }
    const initialEquity = Math.abs(pnl / roi * 100)
    if (!initialEquity || initialEquity <= 0) { noData++; continue }

    // Fetch trade history from both chains
    let allTrades = []
    for (const chainId of CHAIN_IDS) {
      const trades = await fetchAllTrades(snap.source_trader_id, chainId)
      allTrades.push(...trades)
      await sleep(DELAY)
    }

    if (allTrades.length === 0) { noData++; continue }

    const periods = computePeriods(allTrades, initialEquity)

    const updates = {}
    if (periods.roi_7d !== null) updates.roi_7d = periods.roi_7d
    if (periods.roi_30d !== null) updates.roi_30d = periods.roi_30d
    if (periods.pnl_7d !== 0) updates.pnl_7d = periods.pnl_7d
    if (periods.pnl_30d !== 0) updates.pnl_30d = periods.pnl_30d
    if (periods.win_rate_7d !== null) updates.win_rate_7d = periods.win_rate_7d
    if (periods.win_rate_30d !== null) updates.win_rate_30d = periods.win_rate_30d

    if (Object.keys(updates).length === 0) { noData++; continue }

    const { error: upErr } = await sb.from('trader_snapshots').update(updates).eq('id', snap.id)
    if (upErr) { failed++; console.error('update err:', upErr.message) }
    else updated++
  }

  console.log(`\nDone: updated=${updated} noData=${noData} failed=${failed}`)

  const { count: r7 } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true })
    .eq('source', 'gains').is('roi_7d', null)
  const { count: r30 } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true })
    .eq('source', 'gains').is('roi_30d', null)
  console.log(`Gains roi_7d null remaining: ${r7}`)
  console.log(`Gains roi_30d null remaining: ${r30}`)
}

main().catch(e => { console.error(e); process.exit(1) })
