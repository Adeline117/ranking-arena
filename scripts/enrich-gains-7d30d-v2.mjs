#!/usr/bin/env node
/**
 * enrich-gains-7d30d-v2.mjs
 * Computes roi_7d, roi_30d, pnl_7d, pnl_30d for gains traders with NULL overall roi/pnl.
 * These are "open-trade-only" traders imported without leaderboard stats.
 *
 * Approach:
 *   1. Check stats on each chain to find where traders are active
 *   2. Fetch ALL trade history only from chains with data
 *   3. Compute pnl_7d/pnl_30d from closed trades
 *   4. Estimate initialEquity from trade collateral (size/leverage)
 *   5. Compute roi_7d = pnl_7d / initialEquity * 100
 *
 * Chain order: 8453 (Base) first — majority of traders are here
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Base (8453) first — most traders are there
const CHAIN_IDS = [8453, 42161, 137]
const INTER_ADDR_DELAY = 300  // ms between addresses
const INTER_PAGE_DELAY = 150  // ms between paginated requests

const now = Date.now()
const MS_7D  = 7  * 24 * 60 * 60 * 1000
const MS_30D = 30 * 24 * 60 * 60 * 1000

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchStats(address, chainId) {
  try {
    const res = await fetch(
      `https://backend-global.gains.trade/api/personal-trading-history/${address}/stats?chainId=${chainId}`,
      { signal: AbortSignal.timeout(8000) }
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
      await sleep(INTER_PAGE_DELAY)
    } catch { break }
  }
  return trades
}

function computeMetrics(allTrades) {
  if (!allTrades.length) return null

  // Closed trades: actions that are not position modifications
  const closedTrades = allTrades.filter(t => {
    if (!t.date || !t.action) return false
    const a = t.action
    // Exclude only position-modification events (not closes or liquidations)
    if (a.includes('Opened') || a.includes('Increase') || a.includes('Decrease') ||
        a.includes('SlUpdated') || a.includes('TpUpdated')) return false
    // Include: TradeClosed, TradeClosedLIQ, etc.
    return t.pnl != null && !isNaN(parseFloat(t.pnl))
  })

  // Use all trades for equity estimation
  let totalCollateral = 0
  let collateralCount = 0
  for (const t of allTrades) {
    const size = parseFloat(t.size || 0)
    const lev  = parseFloat(t.leverage || 0)
    if (size > 0 && lev > 0) {
      totalCollateral += size / lev
      collateralCount++
    }
  }

  const avgCollateral = collateralCount > 0 ? totalCollateral / collateralCount : 0
  const closedCount   = closedTrades.length
  let estimatedCapital = avgCollateral * closedCount

  // Fallback: use abs(totalPnl) if capital estimate is 0
  const totalPnl = allTrades.reduce((sum, t) => {
    if (t.action?.includes('Opened') || t.action?.includes('Increase')) return sum
    return sum + parseFloat(t.pnl || 0)
  }, 0)
  if (estimatedCapital <= 0 && Math.abs(totalPnl) > 0) {
    estimatedCapital = Math.abs(totalPnl) * 3
  }
  if (estimatedCapital <= 0) return null

  // Period metrics
  let pnl_7d = 0, pnl_30d = 0
  let trades_7d = 0, trades_30d = 0
  let wins_7d = 0, wins_30d = 0

  for (const t of closedTrades) {
    const ts  = new Date(t.date).getTime()
    const pnl = parseFloat(t.pnl || 0)
    const age = now - ts
    if (isNaN(age)) continue

    if (age <= MS_7D) {
      pnl_7d += pnl; trades_7d++
      if (pnl > 0) wins_7d++
    }
    if (age <= MS_30D) {
      pnl_30d += pnl; trades_30d++
      if (pnl > 0) wins_30d++
    }
  }

  return {
    roi_7d:      Math.round((pnl_7d  / estimatedCapital) * 10000) / 100,
    roi_30d:     Math.round((pnl_30d / estimatedCapital) * 10000) / 100,
    pnl_7d:      Math.round(pnl_7d  * 100) / 100,
    pnl_30d:     Math.round(pnl_30d * 100) / 100,
    win_rate_7d:  trades_7d  > 0 ? Math.round((wins_7d  / trades_7d)  * 10000) / 100 : null,
    win_rate_30d: trades_30d > 0 ? Math.round((wins_30d / trades_30d) * 10000) / 100 : null,
  }
}

async function main() {
  console.log('=== Gains 7d/30d Enrichment V2 (null-roi traders) ===')

  // Get unique addresses with null roi_7d AND null overall roi
  // Use large range to bypass Supabase's default 1000-row limit
  const { data: snaps, error } = await sb
    .from('trader_snapshots')
    .select('id, source_trader_id')
    .eq('source', 'gains')
    .or('roi_7d.is.null,roi_30d.is.null')
    .is('roi', null)
    .range(0, 9999)

  if (error) { console.error(error.message); process.exit(1) }
  console.log(`Snapshots to process: ${snaps.length}`)

  // Group by address
  const addrMap = new Map()
  for (const s of snaps) {
    if (!addrMap.has(s.source_trader_id)) addrMap.set(s.source_trader_id, [])
    addrMap.get(s.source_trader_id).push(s.id)
  }
  console.log(`Unique addresses: ${addrMap.size}`)

  let updated = 0, noData = 0, failed = 0
  let addrIdx = 0

  for (const [address, snapIds] of addrMap) {
    addrIdx++
    if (addrIdx % 100 === 0) {
      console.log(`[${addrIdx}/${addrMap.size}] updated_rows=${updated} noData=${noData}`)
    }

    // Check which chains have data
    const activeChains = []
    for (const chainId of CHAIN_IDS) {
      const stats = await fetchStats(address, chainId)
      if (stats && stats.totalTrades > 0) {
        activeChains.push(chainId)
      }
    }

    if (activeChains.length === 0) {
      noData += snapIds.length
      continue
    }

    // Fetch trade history only from active chains
    let allTrades = []
    for (const chainId of activeChains) {
      const trades = await fetchTradeHistory(address, chainId)
      allTrades.push(...trades)
    }

    if (allTrades.length === 0) {
      noData += snapIds.length
      continue
    }

    const metrics = computeMetrics(allTrades)
    if (!metrics) {
      noData += snapIds.length
      continue
    }

    const updates = {
      roi_7d:  metrics.roi_7d,
      roi_30d: metrics.roi_30d,
    }
    if (metrics.pnl_7d  !== 0) updates.pnl_7d  = metrics.pnl_7d
    if (metrics.pnl_30d !== 0) updates.pnl_30d = metrics.pnl_30d
    if (metrics.win_rate_7d  !== null) updates.win_rate_7d  = metrics.win_rate_7d
    if (metrics.win_rate_30d !== null) updates.win_rate_30d = metrics.win_rate_30d

    const { error: upErr } = await sb.from('trader_snapshots')
      .update(updates)
      .in('id', snapIds)

    if (upErr) {
      failed += snapIds.length
      console.error(`update err for ${address}:`, upErr.message)
    } else {
      updated += snapIds.length
      if (addrIdx <= 5) {
        console.log(`  ${address}: roi_7d=${metrics.roi_7d}% roi_30d=${metrics.roi_30d}% pnl_7d=${metrics.pnl_7d}`)
      }
    }

    await sleep(INTER_ADDR_DELAY)
  }

  console.log(`\nDone: updated_rows=${updated} noData=${noData} failed=${failed}`)

  const { count: r7 } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true })
    .eq('source', 'gains').is('roi_7d', null)
  const { count: r30 } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true })
    .eq('source', 'gains').is('roi_30d', null)
  console.log(`Gains roi_7d null remaining: ${r7}`)
  console.log(`Gains roi_30d null remaining: ${r30}`)
}

main().catch(e => { console.error(e); process.exit(1) })
