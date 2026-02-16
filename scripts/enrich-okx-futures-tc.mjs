#!/usr/bin/env node
/**
 * OKX Futures - Enrich trades_count + max_drawdown
 * 
 * trades_count: from public-subpositions-history (count all closed positions)
 * max_drawdown: from pnlRatios equity curve
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const BASE = 'https://www.okx.com/api/v5/copytrading'

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

function calcMDD(pnlRatios) {
  if (!pnlRatios?.length) return null
  // Sort by timestamp
  const sorted = [...pnlRatios].sort((a, b) => Number(a.beginTs) - Number(b.beginTs))
  let peak = -Infinity, maxDD = 0
  for (const p of sorted) {
    const val = parseFloat(p.pnlRatio)
    if (isNaN(val)) continue
    if (val > peak) peak = val
    const dd = peak - val
    if (dd > maxDD) maxDD = dd
  }
  return maxDD > 0 ? Math.round(maxDD * 10000) / 100 : 0 // as percentage
}

async function getTradesCount(uniqueCode) {
  let total = 0
  let after = ''
  for (let page = 0; page < 20; page++) {
    const url = `${BASE}/public-subpositions-history?instType=SWAP&uniqueCode=${uniqueCode}&limit=50${after ? '&after=' + after : ''}`
    const json = await fetchJSON(url)
    if (!json || json.code !== '0' || !json.data?.length) break
    total += json.data.length
    after = json.data[json.data.length - 1].subPosId
    if (json.data.length < 50) break
    await sleep(200)
  }
  return total > 0 ? total : null
}

async function main() {
  console.log('🚀 OKX Futures - Enrich trades_count + max_drawdown\n')

  // Get all rows needing enrichment
  let allRows = []
  let offset = 0
  while (true) {
    const { data } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, trades_count, max_drawdown, season_id')
      .eq('source', 'okx_futures')
      .or('trades_count.is.null,max_drawdown.is.null')
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`Found ${allRows.length} rows needing enrichment`)

  // Group by trader
  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }

  const traders = [...traderMap.keys()]
  console.log(`${traders.length} unique traders\n`)

  let enriched = 0, failed = 0

  for (let i = 0; i < traders.length; i++) {
    const uid = traders[i]
    const rows = traderMap.get(uid)
    
    try {
      // Get detail for MDD (pnlRatios)
      const detailJson = await fetchJSON(`${BASE}/public-lead-traders?instType=SWAP&uniqueCode=${uid}`)
      let mdd = null
      if (detailJson?.code === '0' && detailJson.data?.[0]?.ranks?.[0]) {
        const rank = detailJson.data[0].ranks[0]
        // Verify it's the right trader
        if (rank.uniqueCode === uid || !rank.uniqueCode) {
          mdd = calcMDD(rank.pnlRatios)
        }
      }
      
      await sleep(300)
      
      // Get trades count from position history
      const tc = await getTradesCount(uid)
      
      // Update all rows for this trader
      const update = {}
      if (tc !== null) update.trades_count = tc
      if (mdd !== null) update.max_drawdown = mdd
      
      if (Object.keys(update).length > 0) {
        for (const row of rows) {
          // Only update null fields
          const rowUpdate = {}
          if (row.trades_count === null && update.trades_count != null) rowUpdate.trades_count = update.trades_count
          if (row.max_drawdown === null && update.max_drawdown != null) rowUpdate.max_drawdown = update.max_drawdown
          if (Object.keys(rowUpdate).length > 0) {
            await sb.from('leaderboard_ranks').update(rowUpdate).eq('id', row.id)
          }
        }
        enriched++
      } else {
        failed++
      }
    } catch (e) {
      failed++
    }
    
    if ((i + 1) % 20 === 0) console.log(`[${i + 1}/${traders.length}] enriched=${enriched} failed=${failed}`)
    await sleep(500)
  }

  console.log(`\n✅ Done. Enriched: ${enriched}, Failed: ${failed}`)
}

main().catch(console.error)
