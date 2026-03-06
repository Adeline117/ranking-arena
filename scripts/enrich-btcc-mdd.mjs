#!/usr/bin/env node
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const HEADERS = { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.btcc.com/en-US/copy-trading', 'Origin': 'https://www.btcc.com' }

async function main() {
  // Collect all BTCC traders from listing API
  const allTraders = new Map()
  for (let page = 1; page <= 100; page++) {
    const r = await fetch('https://www.btcc.com/documentary/trader/page', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ pageNum: page, pageSize: 50, sortField: 'overall', sortType: 1 })
    })
    const json = await r.json()
    if (!json?.rows?.length) break
    json.rows.forEach(t => allTraders.set(String(t.traderId), t))
    if (allTraders.size >= (json.total || 9999)) break
    await sleep(300)
  }
  console.log(`BTCC listing: ${allTraders.size} traders`)

  // Get rows needing MDD or win_rate
  const { data: rows } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, max_drawdown, win_rate')
    .eq('source', 'btcc')
    .or('max_drawdown.is.null,win_rate.is.null')
  console.log(`Rows needing enrichment: ${rows?.length}`)

  let updated = 0
  for (const row of (rows || [])) {
    const t = allTraders.get(row.source_trader_id)
    if (!t) continue
    const updates = {}
    if (row.max_drawdown == null && t.maxBackRate != null) {
      updates.max_drawdown = Math.abs(parseFloat(t.maxBackRate))
    }
    if (row.win_rate == null && t.winRate != null) {
      updates.win_rate = parseFloat(t.winRate)
    }
    if (!Object.keys(updates).length) continue
    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) updated++
  }
  console.log(`Updated: ${updated}`)

  const { count: mddNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'btcc').is('max_drawdown', null)
  console.log(`Remaining MDD null: ${mddNull}`)
}
main().catch(e => { console.error(e); process.exit(1) })
