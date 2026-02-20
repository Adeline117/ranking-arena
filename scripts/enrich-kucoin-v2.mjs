#!/usr/bin/env node
/**
 * KuCoin Enrichment v2
 * Fetches win_rate (from positionHistory), max_drawdown (from pnl/history), 
 * trades_count (from positionHistory count)
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Referer': 'https://www.kucoin.com/copytrading',
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchPositionHistory(traderId) {
  // Try multiple periods in case 90d returns null (traders with older positions)
  for (const period of ['90d', '180d', '365d']) {
    try {
      const r = await fetch(
        `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?leadConfigId=${traderId}&period=${period}&lang=en_US&pageSize=100&currentPage=1`,
        { headers: HEADERS, signal: AbortSignal.timeout(15000) }
      )
      const data = await r.json()
      if (data.success && Array.isArray(data.data) && data.data.length > 0) return data.data
      await sleep(200)
    } catch { /* continue */ }
  }
  return null
}

async function fetchPnlHistory(traderId) {
  // Try multiple periods in case 90d returns null
  for (const period of ['90d', '180d', '365d']) {
    try {
      const r = await fetch(
        `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/pnl/history?leadConfigId=${traderId}&period=${period}&lang=en_US`,
        { headers: HEADERS, signal: AbortSignal.timeout(15000) }
      )
      const data = await r.json()
      if (data.success && Array.isArray(data.data) && data.data.length > 0) return data.data
      await sleep(200)
    } catch { /* continue */ }
  }
  return null
}

function calcWrAndTc(positions) {
  if (!positions || positions.length === 0) return { wr: null, tc: null }
  const tc = positions.length
  const wins = positions.filter(p => parseFloat(p.closePnl) > 0).length
  const wr = tc >= 3 ? Math.round((wins / tc) * 10000) / 100 : null
  return { wr, tc }
}

function calcMdd(pnlData) {
  if (!pnlData || pnlData.length < 2) return null
  // Use cumulative ratio to build equity curve
  const equities = pnlData.map(p => 1 + parseFloat(p.ratio))
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
  console.log('🚀 KuCoin Enrichment v2\n')

  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    console.log(`\n📋 ${table}`)
    
    const { data: rows, error } = await sb
      .from(table)
      .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'kucoin')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

    if (error) { console.error(`  Error: ${error.message}`); continue }
    console.log(`  ${rows.length} rows need enrichment`)

    const traderMap = new Map()
    for (const row of rows) {
      if (!traderMap.has(row.source_trader_id)) traderMap.set(row.source_trader_id, [])
      traderMap.get(row.source_trader_id).push(row)
    }

    const ids = [...traderMap.keys()]
    console.log(`  ${ids.length} unique traders`)
    
    let enriched = 0, noData = 0
    const cache = new Map()

    for (let i = 0; i < ids.length; i++) {
      const tid = ids[i]
      const tRows = traderMap.get(tid)
      
      try {
        let wr, mdd, tc
        
        if (cache.has(tid)) {
          ({wr, mdd, tc} = cache.get(tid))
        } else {
          const positions = await fetchPositionHistory(tid)
          const wrTc = calcWrAndTc(positions)
          wr = wrTc.wr; tc = wrTc.tc
          await sleep(500)
          
          const pnl = await fetchPnlHistory(tid)
          mdd = calcMdd(pnl)
          await sleep(500)
          
          cache.set(tid, { wr, mdd, tc })
        }
        
        let updated = false
        for (const row of tRows) {
          const updates = {}
          if (row.win_rate == null && wr != null) updates.win_rate = wr
          if (row.max_drawdown == null && mdd != null) updates.max_drawdown = mdd
          if (row.trades_count == null && tc != null) updates.trades_count = tc
          if (Object.keys(updates).length > 0) {
            await sb.from(table).update(updates).eq('id', row.id)
            updated = true
          }
        }
        
        if (updated) enriched++
        else noData++
        
        if ((i + 1) % 50 === 0) {
          console.log(`  [${i+1}/${ids.length}] enriched=${enriched} noData=${noData}`)
        }
      } catch (e) {
        noData++
      }
    }
    
    console.log(`  ✅ enriched=${enriched}/${ids.length}, noData=${noData}`)
  }

  // Verify
  console.log('\n📊 Verification:')
  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'kucoin')
    const { count: noWR } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'kucoin').is('win_rate', null)
    const { count: noMDD } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'kucoin').is('max_drawdown', null)
    const { count: noTC } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'kucoin').is('trades_count', null)
    console.log(`  ${table}: total=${total} wr_null=${noWR} mdd_null=${noMDD} tc_null=${noTC}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
