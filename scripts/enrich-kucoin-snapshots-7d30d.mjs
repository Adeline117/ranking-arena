#!/usr/bin/env node
/**
 * Enrich KuCoin trader_snapshots with 7d/30d ROI
 *
 * API: kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/pnl/history
 *   pnl/history?leadConfigId=X&period=7d  → last entry ratio × 100 → roi_7d
 *   pnl/history?leadConfigId=X&period=30d → last entry ratio × 100 → roi_30d
 *
 * The ratio field in each daily entry is the running cumulative return as of that day.
 * Last entry's ratio = total period ROI.
 *
 * Usage:
 *   node scripts/enrich-kucoin-snapshots-7d30d.mjs
 *   node scripts/enrich-kucoin-snapshots-7d30d.mjs --dry-run
 *   node scripts/enrich-kucoin-snapshots-7d30d.mjs --limit=50
 *   node scripts/enrich-kucoin-snapshots-7d30d.mjs --concurrency=5
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || 0
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 4

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE_URL = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/pnl/history'

async function fetchRoi(traderId, period) {
  const url = `${BASE_URL}?leadConfigId=${traderId}&period=${period}&lang=en_US`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Referer': 'https://www.kucoin.com/copy-trading',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      })
      if (res.status === 429) {
        await sleep(3000 * (attempt + 1))
        continue
      }
      if (!res.ok) return null
      const d = await res.json()
      if (!d?.success || !Array.isArray(d?.data) || !d.data.length) return null
      
      // Last entry's ratio = cumulative period ROI
      const lastEntry = d.data[d.data.length - 1]
      const ratio = parseFloat(lastEntry.ratio)
      if (isNaN(ratio)) return null
      return parseFloat((ratio * 100).toFixed(4))
    } catch (e) {
      if (attempt < 2) await sleep(500 * (attempt + 1))
    }
  }
  return null
}

async function processTrader(traderId) {
  const [roi7d, roi30d] = await Promise.all([
    fetchRoi(traderId, '7d'),
    fetchRoi(traderId, '30d'),
  ])
  return { roi7d, roi30d }
}

async function main() {
  console.log('═══ KuCoin — 7d/30d ROI enrichment ═══')
  if (DRY_RUN) console.log('[DRY RUN]')

  // Get rows needing enrichment
  let allRows = [], offset = 0
  while (true) {
    const { data } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d')
      .eq('source', 'kucoin')
      .or('roi_7d.is.null,roi_30d.is.null')
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  if (LIMIT) allRows = allRows.slice(0, LIMIT)

  const {count: before7} = await sb.from('trader_snapshots').select('id', {count:'exact', head:true}).eq('source','kucoin').is('roi_7d', null)
  const {count: before30} = await sb.from('trader_snapshots').select('id', {count:'exact', head:true}).eq('source','kucoin').is('roi_30d', null)
  console.log(`BEFORE: roi_7d_null=${before7} roi_30d_null=${before30}`)
  console.log(`Rows needing enrichment: ${allRows.length}`)

  if (!allRows.length) { console.log('Nothing to do!'); return }

  // Group by trader
  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }
  let entries = [...traderMap.entries()]
  console.log(`Unique traders: ${entries.length} (concurrency=${CONCURRENCY})`)

  // Cache API results
  const cache = new Map()
  let done = 0, enriched = 0, failed = 0

  // Process in batches with concurrency
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async ([traderId]) => {
      try {
        const result = await processTrader(traderId)
        cache.set(traderId, result)
        if (result.roi7d !== null || result.roi30d !== null) enriched++
        else failed++
      } catch (e) {
        cache.set(traderId, { roi7d: null, roi30d: null })
        failed++
      }
      done++
    }))
    
    if ((i + CONCURRENCY) % (CONCURRENCY * 5) === 0 || i + CONCURRENCY >= entries.length) {
      console.log(`  API: ${done}/${entries.length} | enriched=${enriched} failed=${failed}`)
    }
    await sleep(300) // Brief pause between batches
  }
  console.log(`API done: ${enriched}/${entries.length} traders enriched`)

  // Show sample
  let sampleCount = 0
  for (const [id, d] of cache) {
    if (d.roi7d !== null || d.roi30d !== null) {
      console.log(`  Sample ${id}: roi7d=${d.roi7d} roi30d=${d.roi30d}`)
      if (++sampleCount >= 3) break
    }
  }

  // Update DB
  let updated = 0, skipped = 0
  for (const row of allRows) {
    const d = cache.get(row.source_trader_id)
    if (!d) { skipped++; continue }

    const updates = {}
    if (row.roi_7d == null && d.roi7d !== null) updates.roi_7d = d.roi7d
    if (row.roi_30d == null && d.roi30d !== null) updates.roi_30d = d.roi30d
    if (!Object.keys(updates).length) { skipped++; continue }

    if (DRY_RUN) {
      if (updated < 5) console.log(`  [DRY] id=${row.id} trader=${row.source_trader_id}:`, updates)
      updated++
    } else {
      const { error } = await sb.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) updated++
      else console.error(`  DB error row ${row.id}:`, error.message)
    }
  }
  console.log(`\nUpdated: ${updated} | Skipped: ${skipped}`)

  const {count: after7} = await sb.from('trader_snapshots').select('id', {count:'exact', head:true}).eq('source','kucoin').is('roi_7d', null)
  const {count: after30} = await sb.from('trader_snapshots').select('id', {count:'exact', head:true}).eq('source','kucoin').is('roi_30d', null)
  console.log(`AFTER:  roi_7d_null=${after7} roi_30d_null=${after30}`)
  console.log(`Filled: roi_7d=${(before7||0)-(after7||0)} roi_30d=${(before30||0)-(after30||0)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
