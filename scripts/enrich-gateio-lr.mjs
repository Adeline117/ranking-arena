#!/usr/bin/env node
/**
 * enrich-gateio-lr.mjs
 * Direct API enrichment for Gate.io leaderboard_ranks (WR + MDD).
 *
 * Gate.io /apiw/v2/copy/leader/list returns win_rate and max_drawdown 
 * for numeric trader IDs. CTA traders (cta_ prefix) are skipped — API doesn't expose them.
 *
 * API returns decimals: win_rate=0.8214 → 82.14%, max_drawdown=0.0066 → 0.66%
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.gate.io/copytrading',
  'Origin': 'https://www.gate.io',
}
const DELAY = 400
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchPage(orderBy, cycle, page, pageSize = 100) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `https://www.gate.io/apiw/v2/copy/leader/list?page=${page}&page_size=${pageSize}&status=running&order_by=${orderBy}&sort_by=desc&cycle=${cycle}`
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
      if (!res.ok) { await sleep(2000); continue }
      return await res.json()
    } catch { if (attempt < 2) await sleep(2000) }
  }
  return null
}

async function main() {
  console.log('=== Gate.io LR Enrichment (Direct API) ===')
  console.log(`Started: ${new Date().toISOString()}`)

  // Load null rows (only numeric IDs - CTA traders don't expose WR/MDD)
  const { rows: nullRows, error: dbErr } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', 'gateio')
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(5000)
  
  // Use pg directly for the OR query
  const pg = await import('pg')
  const client = new pg.default.Client(process.env.DATABASE_URL)
  await client.connect()

  const { rows: nullRows2 } = await client.query(
    `SELECT id, source_trader_id, season_id, win_rate, max_drawdown 
     FROM leaderboard_ranks 
     WHERE source='gateio' AND (win_rate IS NULL OR max_drawdown IS NULL)`
  )

  console.log(`Null WR/MDD rows: ${nullRows2.length}`)

  const numericRows = nullRows2.filter(r => /^\d+$/.test(r.source_trader_id))
  const ctaRows = nullRows2.filter(r => !(/^\d+$/.test(r.source_trader_id)))
  console.log(`Numeric (enrichable): ${numericRows.length}`)
  console.log(`CTA (no WR/MDD in API): ${ctaRows.length} — skipping`)

  if (!numericRows.length) { console.log('Nothing to do.'); await client.end(); return }

  // Build lookup by trader ID
  const byId = new Map()
  for (const row of numericRows) {
    if (!byId.has(row.source_trader_id)) byId.set(row.source_trader_id, [])
    byId.get(row.source_trader_id).push(row)
  }

  // Paginate API - try all order_by options and cycles to maximize coverage
  const apiData = new Map() // traderId → {wr, mdd}
  const orderBys = ['profit_rate', 'profit', 'aum', 'win_rate', 'max_drawdown', 'sharp_ratio']
  const cycles = ['month', 'week', 'quarter']

  for (const cycle of cycles) {
    for (const orderBy of orderBys) {
      for (let page = 1; page <= 50; page++) {
        const json = await fetchPage(orderBy, cycle, page, 100)
        if (!json || json.code !== 0) break
        const list = json.data?.list || []
        if (!list.length) break

        let newFound = 0
        for (const t of list) {
          const id = String(t.leader_id || '')
          if (!id || apiData.has(id)) continue
          const wr = t.win_rate != null ? parseFloat(t.win_rate) : null
          const mdd = t.max_drawdown != null ? Math.abs(parseFloat(t.max_drawdown)) : null
          if (wr != null || mdd != null) {
            apiData.set(id, {
              wr: wr != null ? (wr <= 1 ? Math.round(wr * 10000) / 100 : wr) : null,
              mdd: mdd != null ? (mdd <= 1 ? Math.round(mdd * 10000) / 100 : mdd) : null,
            })
            newFound++
          }
        }

        if (newFound === 0 && page > 2) break
        await sleep(DELAY)
      }
    }
    console.log(`  After cycle=${cycle}: ${apiData.size} traders with WR/MDD`)
  }

  console.log(`Total traders from API: ${apiData.size}`)
  const coverable = [...byId.keys()].filter(id => apiData.has(id))
  console.log(`Coverable from needed IDs: ${coverable.length}/${byId.size}`)

  // Update DB
  let updated = 0, skipped = 0
  for (const [traderId, rows] of byId) {
    const d = apiData.get(traderId)
    if (!d) { skipped += rows.length; continue }

    for (const row of rows) {
      const updates = []
      const vals = []
      let pi = 1

      if (row.win_rate == null && d.wr != null) { updates.push(`win_rate=$${pi++}`); vals.push(d.wr) }
      if (row.max_drawdown == null && d.mdd != null) { updates.push(`max_drawdown=$${pi++}`); vals.push(d.mdd) }
      if (!updates.length) { skipped++; continue }

      vals.push(row.id)
      try {
        await client.query(`UPDATE leaderboard_ranks SET ${updates.join(',')} WHERE id=$${pi}`, vals)
        updated++
      } catch (e) {
        console.error(`  ERR id=${row.id}: ${e.message}`)
      }
    }
  }

  // Final counts
  const { rows: [g] } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE win_rate IS NULL) as wr_null, COUNT(*) FILTER (WHERE max_drawdown IS NULL) as mdd_null FROM leaderboard_ranks WHERE source='gateio'`
  )

  console.log(`\n=== DONE ===`)
  console.log(`Updated: ${updated} rows`)
  console.log(`Skipped (no API data): ${skipped}`)
  console.log(`Gate.io WR null remaining: ${g.wr_null}`)
  console.log(`Gate.io MDD null remaining: ${g.mdd_null}`)
  console.log(`Completed: ${new Date().toISOString()}`)

  await client.end()
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
