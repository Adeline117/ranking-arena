#!/usr/bin/env node
/**
 * dYdX v4 Enrichment Script
 * Uses SOCKS proxy via VPS to bypass geoblocking
 * Enriches: trades_count (from fills), max_drawdown (from historical PnL equity curve)
 * 
 * Prerequisites: ssh -D 1080 -N -f root@45.76.152.169
 */
import { createClient } from '@supabase/supabase-js'
import { SocksProxyAgent } from 'socks-proxy-agent'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const agent = new SocksProxyAgent('socks5://127.0.0.1:1080')
const INDEXER = 'https://indexer.dydx.trade/v4'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function proxyFetch(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20000),
    dispatcher: agent,
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// Node.js fetch doesn't support dispatcher for SOCKS - use http module
import http from 'http'
import https from 'https'

async function socksGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('JSON parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function fetchFills(address) {
  try {
    const data = await socksGet(`${INDEXER}/fills?address=${address}&subaccountNumber=0&limit=100`)
    return data.fills || []
  } catch (e) {
    return []
  }
}

async function fetchHistoricalPnl(address) {
  try {
    const data = await socksGet(`${INDEXER}/historical-pnl?address=${address}&subaccountNumber=0&limit=100`)
    return data.historicalPnl || []
  } catch (e) {
    return []
  }
}

function calcMddFromEquity(pnlHistory) {
  if (pnlHistory.length < 2) return null
  const equities = pnlHistory.map(p => parseFloat(p.equity)).reverse()
  let peak = equities[0], maxDD = 0
  for (const eq of equities) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = (peak - eq) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  return maxDD > 0.001 ? Math.round(maxDD * 10000) / 100 : null
}

async function main() {
  console.log('🚀 dYdX v4 Enrichment (via SOCKS proxy)\n')

  // Get rows needing enrichment from both tables
  const tables = ['leaderboard_ranks', 'trader_snapshots']
  
  for (const table of tables) {
    console.log(`\n📋 Processing ${table}...`)
    
    const { data: rows, error } = await sb
      .from(table)
      .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'dydx')
      .or('max_drawdown.is.null,trades_count.is.null')

    if (error) { console.error(`  Query error: ${error.message}`); continue }
    console.log(`  Found ${rows.length} rows needing enrichment`)

    // Dedupe
    const traderMap = new Map()
    for (const row of rows) {
      if (!traderMap.has(row.source_trader_id)) traderMap.set(row.source_trader_id, [])
      traderMap.get(row.source_trader_id).push(row)
    }

    const traderIds = [...traderMap.keys()]
    console.log(`  Unique traders: ${traderIds.length}`)
    
    const cache = new Map() // cache across tables
    let enriched = 0, noData = 0

    for (let i = 0; i < traderIds.length; i++) {
      const addr = traderIds[i]
      const rowsForTrader = traderMap.get(addr)
      
      try {
        let tc = null, mdd = null
        
        // Check cache first (from previous table)
        if (cache.has(addr)) {
          const c = cache.get(addr)
          tc = c.tc; mdd = c.mdd
        } else {
          const fills = await fetchFills(addr)
          tc = fills.length > 0 ? fills.length : null
          await sleep(500)
          
          const pnl = await fetchHistoricalPnl(addr)
          mdd = calcMddFromEquity(pnl)
          await sleep(500)
          
          cache.set(addr, { tc, mdd })
        }
        
        if (tc == null && mdd == null) { noData++; continue }
        
        for (const row of rowsForTrader) {
          const updates = {}
          if (row.trades_count == null && tc != null) updates.trades_count = tc
          if (row.max_drawdown == null && mdd != null) updates.max_drawdown = mdd
          if (Object.keys(updates).length > 0) {
            await sb.from(table).update(updates).eq('id', row.id)
          }
        }
        enriched++
        
        if ((i + 1) % 25 === 0) {
          console.log(`  [${i+1}/${traderIds.length}] enriched=${enriched} noData=${noData}`)
        }
      } catch (e) {
        noData++
        if (i < 3) console.log(`  Error for ${addr.slice(0,20)}...: ${e.message}`)
      }
    }
    
    console.log(`  ✅ ${table}: enriched=${enriched}/${traderIds.length}, noData=${noData}`)
  }

  // Verify
  console.log('\n📊 Final verification:')
  for (const table of tables) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'dydx')
    const { count: noMDD } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'dydx').is('max_drawdown', null)
    const { count: noTC } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'dydx').is('trades_count', null)
    console.log(`  ${table}: total=${total} mdd_null=${noMDD} tc_null=${noTC}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
