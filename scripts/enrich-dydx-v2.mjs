#!/usr/bin/env node
/**
 * dYdX v4 Enrichment v2 - uses child_process curl for SOCKS proxy
 * Enriches: trades_count, max_drawdown, win_rate
 */
import { createClient } from '@supabase/supabase-js'
import { exec } from 'child_process'
import { promisify } from 'util'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const execAsync = promisify(exec)
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const INDEXER = 'https://indexer.dydx.trade/v4'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function curlGet(url) {
  try {
    const { stdout } = await execAsync(
      `curl -s --max-time 15 -x socks5h://127.0.0.1:1080 '${url}' -H 'User-Agent: Mozilla/5.0'`,
      { timeout: 20000 }
    )
    return JSON.parse(stdout)
  } catch { return null }
}

async function fetchFills(address) {
  const data = await curlGet(`${INDEXER}/fills?address=${address}&subaccountNumber=0&limit=100`)
  return data?.fills || []
}

async function fetchHistoricalPnl(address) {
  const data = await curlGet(`${INDEXER}/historical-pnl?address=${address}&subaccountNumber=0&limit=100`)
  return data?.historicalPnl || []
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

function calcWinRate(fills) {
  // Group fills by order to determine wins/losses
  // A trade is "winning" if realizedPnl > 0
  const trades = fills.filter(f => f.side === 'SELL' || f.liquidity === 'TAKER')
  let wins = 0, total = 0
  for (const f of fills) {
    if (f.realizedPnl != null) {
      const pnl = parseFloat(f.realizedPnl || '0')
      if (pnl !== 0) {
        total++
        if (pnl > 0) wins++
      }
    }
  }
  if (total < 3) return null
  return Math.round(wins / total * 10000) / 100
}

async function main() {
  console.log('🚀 dYdX v4 Enrichment v2 (via curl SOCKS proxy)\n')

  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    console.log(`\n📋 Processing ${table}...`)
    
    let allRows = []
    let offset = 0
    while (true) {
      const { data } = await sb
        .from(table)
        .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
        .eq('source', 'dydx')
        .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
        .range(offset, offset + 999)
      if (!data?.length) break
      allRows.push(...data)
      if (data.length < 1000) break
      offset += 1000
    }
    console.log(`  Found ${allRows.length} rows needing enrichment`)

    const traderMap = new Map()
    for (const r of allRows) {
      if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
      traderMap.get(r.source_trader_id).push(r)
    }
    const traderIds = [...traderMap.keys()]
    console.log(`  Unique traders: ${traderIds.length}`)

    let enriched = 0, noData = 0

    for (let i = 0; i < traderIds.length; i++) {
      const addr = traderIds[i]
      const rows = traderMap.get(addr)

      const fills = await fetchFills(addr)
      await sleep(300)
      const pnl = await fetchHistoricalPnl(addr)
      await sleep(300)

      const tc = fills.length > 0 ? fills.length : null
      const mdd = calcMddFromEquity(pnl)
      const wr = calcWinRate(fills)

      if (tc == null && mdd == null && wr == null) { noData++; continue }

      for (const row of rows) {
        const u = {}
        if (row.trades_count == null && tc != null) u.trades_count = tc
        if (row.max_drawdown == null && mdd != null) u.max_drawdown = mdd
        if (row.win_rate == null && wr != null) u.win_rate = wr
        if (Object.keys(u).length) {
          await sb.from(table).update(u).eq('id', row.id)
        }
      }
      enriched++

      if ((i + 1) % 5 === 0) {
        console.log(`  [${i+1}/${traderIds.length}] enriched=${enriched} noData=${noData}`)
      }
    }

    console.log(`  ✅ ${table}: enriched=${enriched}/${traderIds.length}, noData=${noData}`)
  }

  // Verify
  console.log('\n📊 Final verification:')
  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'dydx')
    const { count: wrN } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'dydx').is('win_rate', null)
    const { count: mddN } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'dydx').is('max_drawdown', null)
    const { count: tcN } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'dydx').is('trades_count', null)
    console.log(`  ${table}: total=${total} wr_null=${wrN} mdd_null=${mddN} tc_null=${tcN}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
