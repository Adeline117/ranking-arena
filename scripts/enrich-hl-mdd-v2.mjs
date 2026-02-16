#!/usr/bin/env node
/**
 * Hyperliquid - Enrich MDD from portfolio API
 * Uses "portfolio" endpoint which returns accountValueHistory
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchHL(type, body) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, ...body }),
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { await sleep(1000) }
  }
  return null
}

function calcMDD(accountValueHistory) {
  if (!accountValueHistory || accountValueHistory.length < 2) return null
  let peak = -Infinity, maxDD = 0
  for (const [, valStr] of accountValueHistory) {
    const val = parseFloat(valStr)
    if (val <= 0) continue
    if (val > peak) peak = val
    const dd = ((peak - val) / peak) * 100
    if (dd > maxDD) maxDD = dd
  }
  return maxDD > 0 && maxDD < 100 ? parseFloat(maxDD.toFixed(2)) : null
}

async function main() {
  console.log('Hyperliquid — Enrich MDD from portfolio API')

  let allRows = [], offset = 0
  while (true) {
    const { data } = await supabase.from('leaderboard_ranks')
      .select('id, source_trader_id, max_drawdown, season_id')
      .eq('source', 'hyperliquid')
      .is('max_drawdown', null)
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

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

    const portfolio = await fetchHL('portfolio', { user: addr })
    
    let mdd = null
    if (Array.isArray(portfolio)) {
      // Find the appropriate period based on season
      // Use "month" for 30D, "week" for 7D, "allTime" for 90D/default
      // Try allTime first for best MDD calculation
      for (const [period, data] of portfolio) {
        if (period === 'allTime' || period === 'perpAllTime') {
          const m = calcMDD(data.accountValueHistory)
          if (m !== null && (mdd === null || m > mdd)) mdd = m
        }
      }
      // Fallback to month
      if (mdd === null) {
        for (const [period, data] of portfolio) {
          if (period === 'month' || period === 'perpMonth') {
            const m = calcMDD(data.accountValueHistory)
            if (m !== null) { mdd = m; break }
          }
        }
      }
    }

    if (mdd !== null) {
      for (const row of rows) {
        const { error } = await supabase.from('leaderboard_ranks')
          .update({ max_drawdown: mdd })
          .eq('id', row.id)
        if (!error) updated++
        else failed++
      }
    } else {
      failed++
    }

    if ((i + 1) % 25 === 0) console.log(`  [${i + 1}/${entries.length}] updated=${updated} failed=${failed}`)
    await sleep(400)
  }

  console.log(`\nDONE: updated=${updated} failed=${failed}`)
  
  const { count } = await supabase.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'hyperliquid').is('max_drawdown', null)
  console.log(`Remaining mdd_null: ${count}`)
}

main().catch(console.error)
