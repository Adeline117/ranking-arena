#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks + trader_snapshots for Hyperliquid
 * Uses Hyperliquid info API for portfolio data
 * NO fabricated data - only real API values
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchHL(endpoint, body) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: endpoint, ...body }),
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { await sleep(1000) }
  }
  return null
}

async function main() {
  console.log('Hyperliquid — Enrich leaderboard_ranks')

  // Get rows needing enrichment
  let allRows = [], offset = 0
  while (true) {
    const { data } = await supabase.from('leaderboard_ranks')
      .select('id, source_trader_id, win_rate, max_drawdown, trades_count, sharpe_ratio')
      .eq('source', 'hyperliquid')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  // Unique addresses
  const addrMap = new Map()
  for (const r of allRows) {
    if (!addrMap.has(r.source_trader_id)) addrMap.set(r.source_trader_id, [])
    addrMap.get(r.source_trader_id).push(r)
  }
  console.log(`  ${allRows.length} rows, ${addrMap.size} unique traders`)

  let updated = 0, failed = 0
  const entries = [...addrMap.entries()]

  for (let i = 0; i < entries.length; i++) {
    const [addr, rows] = entries[i]

    // Fetch portfolio history for MDD calculation
    const portfolio = await fetchHL('userPortfolioHistory', { user: addr, period: '90d' })
    
    // Fetch trade history for win_rate and trades_count
    const fills = await fetchHL('userFills', { user: addr })

    let maxDrawdown = null, winRate = null, tradesCount = null

    // Calculate MDD from portfolio history
    if (Array.isArray(portfolio) && portfolio.length >= 2) {
      let peak = -Infinity, maxDD = 0
      for (const p of portfolio) {
        const val = parseFloat(p.accountValue || p.equity || 0)
        if (val <= 0) continue
        if (val > peak) peak = val
        const dd = ((peak - val) / peak) * 100
        if (dd > maxDD) maxDD = dd
      }
      if (maxDD > 0 && maxDD < 100) {
        maxDrawdown = parseFloat(maxDD.toFixed(2))
      }
    }

    // Calculate WR and TC from fills
    if (Array.isArray(fills) && fills.length > 0) {
      // Group fills by coin to count trades
      const trades = new Map()
      for (const f of fills) {
        const key = f.coin
        if (!trades.has(key)) trades.set(key, { pnl: 0, count: 0 })
        const t = trades.get(key)
        t.pnl += parseFloat(f.closedPnl || 0)
        if (f.dir === 'Close Long' || f.dir === 'Close Short') t.count++
      }
      const closedTrades = [...trades.values()].filter(t => t.count > 0)
      if (closedTrades.length > 0) {
        const wins = closedTrades.filter(t => t.pnl > 0).length
        winRate = parseFloat((wins / closedTrades.length * 100).toFixed(2))
        tradesCount = closedTrades.length
      }
    }

    for (const row of rows) {
      const updates = {}
      if (row.win_rate == null && winRate != null) updates.win_rate = winRate
      if (row.max_drawdown == null && maxDrawdown != null) updates.max_drawdown = maxDrawdown
      if (row.trades_count == null && tradesCount != null) updates.trades_count = tradesCount
      if (!Object.keys(updates).length) continue
      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) updated++
      else failed++
    }

    if ((i + 1) % 25 === 0 || i < 5) console.log(`  [${i + 1}/${entries.length}] updated=${updated} failed=${failed}`)
    await sleep(300)
  }

  console.log(`\nDONE: updated=${updated} failed=${failed}`)
  
  // Verify
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'hyperliquid').is('win_rate', null)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'hyperliquid').is('max_drawdown', null)
  console.log(`After: wr_null=${wrNull} mdd_null=${mddNull}`)
}

main().catch(console.error)
