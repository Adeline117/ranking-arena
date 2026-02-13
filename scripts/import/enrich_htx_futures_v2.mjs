#!/usr/bin/env node
/**
 * Enrich trader_snapshots_v2 for htx_futures with win_rate, max_drawdown
 * HTX rank API returns winRate and mdd in the leaderboard itself.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const API = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  console.log('HTX Futures v2 Enrichment\n')

  // 1. Fetch all traders from rank API
  const apiTraders = new Map()
  for (let page = 1; page <= 30; page++) {
    const res = await fetch(`${API}?rankType=1&pageNo=${page}&pageSize=50`, {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000)
    })
    const data = await res.json()
    if (!data?.data?.itemList?.length) break
    for (const item of data.data.itemList) {
      const key = item.userSign || String(item.uid || '')
      if (key) apiTraders.set(key, item)
    }
    console.log(`  Page ${page}: +${data.data.itemList.length}, total: ${apiTraders.size}`)
    if (data.data.itemList.length < 50) break
    await sleep(500)
  }
  console.log(`\nAPI traders: ${apiTraders.size}`)

  // 2. Get v2 rows missing data
  let rows = []
  let page = 0
  while (true) {
    const { data, error } = await sb.from('trader_snapshots_v2')
      .select('id, trader_key, window')
      .eq('platform', 'htx_futures')
      .or('win_rate.is.null,max_drawdown.is.null')
      .range(page * 1000, (page + 1) * 1000 - 1)
    if (error || !data?.length) break
    rows.push(...data)
    if (data.length < 1000) break
    page++
  }
  console.log(`DB rows missing data: ${rows.length}`)

  // 3. Match and update
  let updated = 0, notFound = 0
  for (const row of rows) {
    const item = apiTraders.get(row.trader_key)
    if (!item) { notFound++; continue }

    const update = {}
    const wr = item.winRate != null ? parseFloat(item.winRate) * 100 : null
    const mdd = item.mdd != null ? parseFloat(item.mdd) * 100 : null
    if (wr != null && wr > 0) update.win_rate = parseFloat(wr.toFixed(2))
    if (mdd != null && mdd > 0) update.max_drawdown = parseFloat(mdd.toFixed(2))

    if (Object.keys(update).length > 0) {
      const { error } = await sb.from('trader_snapshots_v2').update(update).eq('id', row.id)
      if (!error) updated++
    }
  }

  console.log(`\n✅ Done: ${updated} updated, ${notFound} not found in API`)
}

main().catch(console.error)
