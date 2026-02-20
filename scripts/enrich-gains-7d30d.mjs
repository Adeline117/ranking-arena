#!/usr/bin/env node
/**
 * enrich-gains-7d30d.mjs
 * Computes roi_7d, roi_30d, pnl_7d, pnl_30d for gains traders.
 *
 * Two-pass approach:
 *   Pass 1 (V1): Traders with overall roi/pnl — derive initial equity, compute period ROI from trade history
 *   Pass 2 (V2): Traders without overall roi/pnl — fetch trade history, estimate capital from collateral
 *   Pass 3 (V3): Remaining traders with only open positions / no recent activity —
 *                confirm via stats API (thirtyDayVolume=0), set roi_7d=0, roi_30d=0 (real API data)
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const CHAIN_IDS = [8453, 42161, 137]
const DELAY = 400
const sleep = ms => new Promise(r => setTimeout(r, ms))

const now = Date.now()
const MS_7D = 7 * 24 * 60 * 60 * 1000
const MS_30D = 30 * 24 * 60 * 60 * 1000

async function fetchStats(address, chainId) {
  try {
    const res = await fetch(
      `https://backend-global.gains.trade/api/personal-trading-history/${address}/stats?chainId=${chainId}`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function fetchTradeHistory(address, chainId) {
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
      await sleep(150)
    } catch { break }
  }
  return trades
}

function isCloseTrade(action) {
  if (!action) return false
  // Exclude open/modify events; include closes and liquidations
  if (action.includes('Opened') || action.includes('Increase') ||
      action.includes('Decrease') || action.includes('SlUpdated') ||
      action.includes('TpUpdated')) return false
  return true
}

function computePeriodMetrics(trades, initialEquity) {
  let pnl_7d = 0, pnl_30d = 0
  let trades_7d = 0, trades_30d = 0
  let wins_7d = 0, wins_30d = 0

  for (const t of trades) {
    if (!isCloseTrade(t.action)) continue
    const ts = new Date(t.date).getTime()
    const pnl = parseFloat(t.pnl || 0)
    const age = now - ts
    if (isNaN(age)) continue

    if (age <= MS_7D) { pnl_7d += pnl; trades_7d++; if (pnl > 0) wins_7d++ }
    if (age <= MS_30D) { pnl_30d += pnl; trades_30d++; if (pnl > 0) wins_30d++ }
  }

  const roi_7d = initialEquity > 0 ? Math.round((pnl_7d / initialEquity) * 10000) / 100 : 0
  const roi_30d = initialEquity > 0 ? Math.round((pnl_30d / initialEquity) * 10000) / 100 : 0

  return {
    roi_7d,
    roi_30d,
    pnl_7d: Math.round(pnl_7d * 100) / 100,
    pnl_30d: Math.round(pnl_30d * 100) / 100,
    win_rate_7d: trades_7d > 0 ? Math.round((wins_7d / trades_7d) * 10000) / 100 : null,
    win_rate_30d: trades_30d > 0 ? Math.round((wins_30d / trades_30d) * 10000) / 100 : null,
  }
}

// ─── Pass 1: traders WITH overall roi+pnl ────────────────────────────────────
async function pass1() {
  console.log('\n── Pass 1: traders with overall roi+pnl ──')
  const { data: snaps, error } = await sb
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl')
    .eq('source', 'gains')
    .or('roi_7d.is.null,roi_30d.is.null')
    .not('roi', 'is', null)
    .not('pnl', 'is', null)
    .range(0, 9999)

  if (error) { console.error(error.message); return 0 }
  console.log(`Found: ${snaps.length}`)
  if (!snaps.length) return 0

  let updated = 0, noData = 0

  for (let i = 0; i < snaps.length; i++) {
    const snap = snaps[i]
    if (i % 50 === 0) console.log(`  [${i}/${snaps.length}] updated=${updated}`)

    const roi = parseFloat(snap.roi)
    const pnl = parseFloat(snap.pnl)
    if (!roi || !pnl || Math.abs(roi) < 0.001) { noData++; continue }
    const initialEquity = Math.abs(pnl / roi * 100)
    if (!initialEquity || initialEquity <= 0) { noData++; continue }

    let allTrades = []
    for (const chainId of CHAIN_IDS) {
      const trades = await fetchTradeHistory(snap.source_trader_id, chainId)
      allTrades.push(...trades)
      await sleep(DELAY)
    }
    if (!allTrades.length) { noData++; continue }

    const m = computePeriodMetrics(allTrades, initialEquity)
    const updates = { roi_7d: m.roi_7d, roi_30d: m.roi_30d }
    if (m.pnl_7d !== 0) updates.pnl_7d = m.pnl_7d
    if (m.pnl_30d !== 0) updates.pnl_30d = m.pnl_30d
    if (m.win_rate_7d !== null) updates.win_rate_7d = m.win_rate_7d
    if (m.win_rate_30d !== null) updates.win_rate_30d = m.win_rate_30d

    const { error: upErr } = await sb.from('trader_snapshots').update(updates).eq('id', snap.id)
    if (upErr) console.error('update err:', upErr.message)
    else updated++
  }

  console.log(`  Pass1 done: updated=${updated} noData=${noData}`)
  return updated
}

// ─── Pass 2: traders WITHOUT overall roi/pnl, estimate capital from collateral ─
async function pass2() {
  console.log('\n── Pass 2: traders without overall roi/pnl ──')
  const { data: snaps, error } = await sb
    .from('trader_snapshots')
    .select('id, source_trader_id')
    .eq('source', 'gains')
    .or('roi_7d.is.null,roi_30d.is.null')
    .is('roi', null)
    .range(0, 9999)

  if (error) { console.error(error.message); return 0 }
  console.log(`Found: ${snaps.length}`)
  if (!snaps.length) return 0

  // Group by address
  const addrMap = new Map()
  for (const s of snaps) {
    if (!addrMap.has(s.source_trader_id)) addrMap.set(s.source_trader_id, [])
    addrMap.get(s.source_trader_id).push(s.id)
  }
  console.log(`Unique addresses: ${addrMap.size}`)

  let updated = 0, noData = 0, addrIdx = 0

  for (const [address, snapIds] of addrMap) {
    addrIdx++
    if (addrIdx % 25 === 0) console.log(`  [${addrIdx}/${addrMap.size}] updated_rows=${updated}`)

    // Only fetch from chains with trade data
    const activeChains = []
    for (const chainId of CHAIN_IDS) {
      const stats = await fetchStats(address, chainId)
      if (stats && stats.totalTrades > 0) activeChains.push(chainId)
      await sleep(100)
    }
    if (!activeChains.length) { noData += snapIds.length; continue }

    let allTrades = []
    for (const chainId of activeChains) {
      const trades = await fetchTradeHistory(address, chainId)
      allTrades.push(...trades)
      await sleep(DELAY)
    }
    if (!allTrades.length) { noData += snapIds.length; continue }

    // Estimate capital from closed trade collateral
    let totalCollateral = 0, collateralCount = 0
    for (const t of allTrades) {
      if (!isCloseTrade(t.action)) continue
      const size = parseFloat(t.size || 0)
      const lev = parseFloat(t.leverage || 0)
      if (size > 0 && lev > 0) { totalCollateral += size / lev; collateralCount++ }
    }

    // Fallback: use open-position collateral if no closed trades
    if (collateralCount === 0) {
      for (const t of allTrades) {
        const size = parseFloat(t.size || 0)
        const lev = parseFloat(t.leverage || 0)
        if (size > 0 && lev > 0) { totalCollateral += size / lev; collateralCount++ }
      }
    }

    const avgCollateral = collateralCount > 0 ? totalCollateral / collateralCount : 0
    const closedCount = allTrades.filter(t => isCloseTrade(t.action)).length

    let estimatedCapital = avgCollateral * Math.max(closedCount, 1)

    // If still 0, try abs(totalPnl) fallback
    if (estimatedCapital <= 0) {
      const totalPnl = allTrades.reduce((s, t) => {
        if (t.action?.includes('Opened') || t.action?.includes('Increase')) return s
        return s + parseFloat(t.pnl || 0)
      }, 0)
      if (Math.abs(totalPnl) > 0) estimatedCapital = Math.abs(totalPnl) * 3
    }

    if (estimatedCapital <= 0) { noData += snapIds.length; continue }

    const m = computePeriodMetrics(allTrades, estimatedCapital)
    const updates = { roi_7d: m.roi_7d, roi_30d: m.roi_30d }
    if (m.pnl_7d !== 0) updates.pnl_7d = m.pnl_7d
    if (m.pnl_30d !== 0) updates.pnl_30d = m.pnl_30d
    if (m.win_rate_7d !== null) updates.win_rate_7d = m.win_rate_7d
    if (m.win_rate_30d !== null) updates.win_rate_30d = m.win_rate_30d

    const { error: upErr } = await sb.from('trader_snapshots').update(updates).in('id', snapIds)
    if (upErr) console.error(`update err for ${address}:`, upErr.message)
    else {
      updated += snapIds.length
      if (addrIdx <= 3) console.log(`  ${address}: roi_7d=${m.roi_7d}% roi_30d=${m.roi_30d}%`)
    }

    await sleep(DELAY)
  }

  console.log(`  Pass2 done: updated_rows=${updated} noData=${noData}`)
  return updated
}

// ─── Pass 3: truly stuck traders — no closed trades, only open positions ──────
// Verify via stats API (thirtyDayVolume=0) → roi_7d=0, roi_30d=0 (real data from API)
async function pass3() {
  console.log('\n── Pass 3: open-position-only traders (confirmed via stats API) ──')
  const { data: snaps, error } = await sb
    .from('trader_snapshots')
    .select('id, source_trader_id')
    .eq('source', 'gains')
    .or('roi_7d.is.null,roi_30d.is.null')
    .range(0, 9999)

  if (error) { console.error(error.message); return 0 }
  console.log(`Found: ${snaps.length}`)
  if (!snaps.length) return 0

  const addrMap = new Map()
  for (const s of snaps) {
    if (!addrMap.has(s.source_trader_id)) addrMap.set(s.source_trader_id, [])
    addrMap.get(s.source_trader_id).push(s.id)
  }
  console.log(`Unique addresses: ${addrMap.size}`)

  let updated = 0, skipped = 0, addrIdx = 0

  for (const [address, snapIds] of addrMap) {
    addrIdx++
    if (addrIdx % 20 === 0) console.log(`  [${addrIdx}/${addrMap.size}] updated_rows=${updated}`)

    // Check stats across all chains — if thirtyDayVolume=0 on ALL chains → no 30d activity
    let hasActivity = false
    let anyChainSeen = false

    for (const chainId of CHAIN_IDS) {
      const stats = await fetchStats(address, chainId)
      if (!stats) continue
      anyChainSeen = true
      // thirtyDayVolume > 0 means they traded in the past 30 days
      if (parseFloat(stats.thirtyDayVolume || 0) > 0) {
        hasActivity = true
        break
      }
    }

    if (!anyChainSeen) {
      // Can't confirm — skip
      skipped += snapIds.length
      continue
    }

    if (hasActivity) {
      // Has 30d activity but we couldn't compute ROI above — skip (needs more investigation)
      skipped += snapIds.length
      console.log(`  SKIP ${address}: has 30d volume but couldn't compute ROI`)
      continue
    }

    // Confirmed: thirtyDayVolume=0 on all chains → roi_7d=0, roi_30d=0 from API data
    const updates = { roi_7d: 0, roi_30d: 0 }

    const { error: upErr } = await sb.from('trader_snapshots').update(updates).in('id', snapIds)
    if (upErr) console.error(`update err for ${address}:`, upErr.message)
    else {
      updated += snapIds.length
      if (addrIdx <= 5) console.log(`  ${address}: roi_7d=0, roi_30d=0 (no 30d volume confirmed by API)`)
    }

    await sleep(200)
  }

  console.log(`  Pass3 done: updated_rows=${updated} skipped=${skipped}`)
  return updated
}

async function main() {
  console.log('=== Gains 7d/30d Enrichment (Full) ===')

  // Initial counts
  const { count: r7_before } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'gains').is('roi_7d', null)
  const { count: r30_before } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'gains').is('roi_30d', null)
  console.log(`Before: roi_7d NULL=${r7_before}, roi_30d NULL=${r30_before}`)

  await pass1()
  await pass2()
  await pass3()

  // Final counts
  const { count: r7_after } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'gains').is('roi_7d', null)
  const { count: r30_after } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'gains').is('roi_30d', null)
  console.log(`\nAfter: roi_7d NULL=${r7_after}, roi_30d NULL=${r30_after}`)
  console.log(`Filled: roi_7d=${r7_before - r7_after}, roi_30d=${r30_before - r30_after}`)
}

main().catch(e => { console.error(e); process.exit(1) })
