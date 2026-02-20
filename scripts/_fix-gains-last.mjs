#!/usr/bin/env node
// Fix last 1 gains row: 0x1dd3cd44a21003772f2dba26d9a1535acf51f91f
// roi=0, pnl=null — 2102 trades on Base (chain 8453), $6.9M 30d volume
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const ADDR = '0x1dd3cd44a21003772f2dba26d9a1535acf51f91f'
const CHAIN = 8453
const MS_7D = 7 * 24 * 60 * 60 * 1000
const MS_30D = 30 * 24 * 60 * 60 * 1000
const sleep = ms => new Promise(r => setTimeout(r, ms))

function isClosed(action) {
  if (!action) return false
  return !action.includes('Opened') && !action.includes('Increase') &&
         !action.includes('Decrease') && !action.includes('SlUpdated') && !action.includes('TpUpdated')
}

async function fetchAll() {
  const trades = []
  let page = 1
  while (true) {
    const url = `https://backend-global.gains.trade/api/personal-trading-history/${ADDR}?chainId=${CHAIN}&page=${page}&pageSize=100`
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) { console.error('fetch failed page', page, res.status); break }
    const json = await res.json()
    const data = json?.data || []
    if (!data.length) break
    trades.push(...data)
    if (page % 5 === 0) console.log(`  fetched ${trades.length} trades (page ${page})`)
    if (data.length < 100) break
    page++
    await sleep(100)
  }
  return trades
}

const all = await fetchAll()
console.log(`Total trades fetched: ${all.length}`)

const now = Date.now()
let pnl_7d = 0, pnl_30d = 0, count_7d = 0, count_30d = 0, wins_7d = 0, wins_30d = 0
let totalColl = 0, collCount = 0

for (const t of all) {
  const size = parseFloat(t.size || 0), lev = parseFloat(t.leverage || 0)
  if (size > 0 && lev > 0) { totalColl += size / lev; collCount++ }
  if (!isClosed(t.action)) continue
  const ts = new Date(t.date).getTime()
  const pnl = parseFloat(t.pnl || 0)
  const age = now - ts
  if (age <= MS_7D) { pnl_7d += pnl; count_7d++; if (pnl > 0) wins_7d++ }
  if (age <= MS_30D) { pnl_30d += pnl; count_30d++; if (pnl > 0) wins_30d++ }
}

const closedAll = all.filter(t => isClosed(t.action)).length
const avgColl = collCount > 0 ? totalColl / collCount : 0
const estCap = avgColl * Math.max(closedAll, 1)
console.log(`Closed trades: ${closedAll}, avgColl: ${avgColl.toFixed(4)}, estCap: ${estCap.toFixed(2)}`)
console.log(`pnl_7d: ${pnl_7d.toFixed(4)}, count_7d: ${count_7d}`)
console.log(`pnl_30d: ${pnl_30d.toFixed(4)}, count_30d: ${count_30d}`)

const roi_7d = estCap > 0 ? Math.round((pnl_7d / estCap) * 10000) / 100 : 0
const roi_30d = estCap > 0 ? Math.round((pnl_30d / estCap) * 10000) / 100 : 0
console.log(`roi_7d: ${roi_7d}%, roi_30d: ${roi_30d}%`)

const updates = {
  roi_7d, roi_30d,
  pnl_7d: Math.round(pnl_7d * 100) / 100,
  pnl_30d: Math.round(pnl_30d * 100) / 100,
  win_rate_7d: count_7d > 0 ? Math.round(wins_7d/count_7d*10000)/100 : null,
  win_rate_30d: count_30d > 0 ? Math.round(wins_30d/count_30d*10000)/100 : null,
}
console.log('updates:', updates)

const { data, error } = await sb.from('trader_snapshots').update(updates).eq('source_trader_id', ADDR).eq('source', 'gains').select('id')
if (error) { console.error('update err:', error.message); process.exit(1) }
console.log(`Updated ${data.length} rows:`, data.map(r => r.id))

const { count: r7 } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'gains').is('roi_7d', null)
const { count: r30 } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'gains').is('roi_30d', null)
console.log(`Final: roi_7d NULL=${r7}, roi_30d NULL=${r30}`)
