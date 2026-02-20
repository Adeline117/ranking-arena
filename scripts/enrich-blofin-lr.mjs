#!/usr/bin/env node
/**
 * enrich-blofin-lr.mjs
 * Direct API enrichment for Blofin leaderboard_ranks (WR + MDD)
 *
 * API: POST https://blofin.com/uapi/v1/copy/trader/info { uid }
 *   Returns: win_rate (0-1 decimal), max_draw_down (0-1 decimal)
 *   Works without Cloudflare for numeric UIDs
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Referer': 'https://blofin.com/',
  'Origin': 'https://blofin.com',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DELAY = 300

async function fetchTraderInfo(uid) {
  try {
    const r = await fetch('https://blofin.com/uapi/v1/copy/trader/info', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ uid }),
      signal: AbortSignal.timeout(12000),
    })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function main() {
  console.log('=== Blofin Leaderboard Enrichment (Direct API) ===')

  // Get all blofin traders needing enrichment
  const { data: traders } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'blofin')
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(500)

  console.log(`Traders needing enrichment: ${traders?.length || 0}`)
  if (!traders?.length) {
    console.log('Nothing to do.')
    return
  }

  // Dedupe by source_trader_id
  const idToRows = new Map()
  for (const t of traders) {
    if (!idToRows.has(t.source_trader_id)) idToRows.set(t.source_trader_id, [])
    idToRows.get(t.source_trader_id).push(t)
  }
  const uniqueIds = [...idToRows.keys()]
  console.log(`Unique traders: ${uniqueIds.length}`)

  let updated = 0, failed = 0, noData = 0

  for (let i = 0; i < uniqueIds.length; i++) {
    const uid = uniqueIds[i]
    if (i % 20 === 0) console.log(`[${i}/${uniqueIds.length}] updated=${updated} noData=${noData}`)

    // Only works with numeric UIDs
    if (!/^\d+$/.test(uid)) {
      noData++
      continue
    }

    const data = await fetchTraderInfo(uid)

    if (!data || data.code !== 200 || !data.data) {
      noData++
      await sleep(DELAY)
      continue
    }

    const d = data.data
    const wr = d.win_rate != null ? parseFloat(d.win_rate) : null
    const mdd = d.max_draw_down != null ? Math.abs(parseFloat(d.max_draw_down)) : null

    // Update all rows for this trader
    const rows = idToRows.get(uid)
    for (const row of rows) {
      const updates = {}

      if (wr != null && row.win_rate == null) {
        // win_rate from API is 0-1 decimal, convert to percentage
        const wrPct = wr <= 1 ? Math.round(wr * 10000) / 100 : Math.round(wr * 100) / 100
        if (wrPct >= 0 && wrPct <= 100) updates.win_rate = wrPct
      }

      if (mdd != null && row.max_drawdown == null) {
        // max_draw_down is 0-1 decimal, convert to percentage
        const mddPct = mdd <= 1 ? Math.round(mdd * 10000) / 100 : Math.round(mdd * 100) / 100
        if (mddPct >= 0 && mddPct <= 100) updates.max_drawdown = mddPct
      }

      if (Object.keys(updates).length === 0) { noData++; continue }

      const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (error) {
        console.error(`  ERR ${uid}: ${error.message}`)
        failed++
      } else {
        updated++
      }
    }

    await sleep(DELAY)
  }

  // Final counts
  const { count: wrNullAfter } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'blofin')
    .is('win_rate', null)

  const { count: mddNullAfter } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'blofin')
    .is('max_drawdown', null)

  console.log(`\nDone: updated=${updated} noData=${noData} failed=${failed}`)
  console.log(`Blofin WR null remaining: ${wrNullAfter}`)
  console.log(`Blofin MDD null remaining: ${mddNullAfter}`)
}

main().catch(e => { console.error(e); process.exit(1) })
