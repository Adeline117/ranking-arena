#!/usr/bin/env node
/**
 * Enrich OKX Futures trader_snapshots with 7d/30d ROI and PNL
 * 
 * Uses OKX public API: /api/v5/copytrading/public-weekly-pnl
 * Each entry has per-week pnlRatio (decimal) and pnl (USD).
 * 
 * roi_7d = most recent week's pnlRatio * 100 (percentage)
 * roi_30d = compounded last ~4 weeks' pnlRatio * 100
 * pnl_7d = most recent week's pnl
 * pnl_30d = sum of last ~4 weeks' pnl
 * 
 * Usage:
 *   node scripts/enrich-okx-7d30d.mjs
 *   node scripts/enrich-okx-7d30d.mjs --dry-run
 *   node scripts/enrich-okx-7d30d.mjs --limit=10
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || 0

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

async function fetchWeeklyPnl(uniqueCode) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(
        `https://www.okx.com/api/v5/copytrading/public-weekly-pnl?instType=SWAP&uniqueCode=${uniqueCode}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }
      )
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      const json = await res.json()
      if (json.code !== '0' || !json.data?.length) return null
      return json.data // array of {beginTs, pnl, pnlRatio}
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

function computeMetrics(weeks) {
  // weeks are newest-first from API
  // Sort by timestamp ascending
  const sorted = [...weeks].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  
  const now = Date.now()
  const WEEK_MS = 7 * 24 * 3600 * 1000
  
  // Find weeks within 7d and 30d
  const recent7d = sorted.filter(w => now - parseInt(w.beginTs) <= WEEK_MS * 1.5) // most recent week
  const recent30d = sorted.filter(w => now - parseInt(w.beginTs) <= WEEK_MS * 5) // ~4-5 weeks
  
  const result = {}
  
  // 7d: most recent week
  if (recent7d.length > 0) {
    const last = recent7d[recent7d.length - 1]
    const ratio = parseFloat(last.pnlRatio)
    const pnl = parseFloat(last.pnl)
    if (!isNaN(ratio)) result.roi_7d = parseFloat((ratio * 100).toFixed(2))
    if (!isNaN(pnl)) result.pnl_7d = parseFloat(pnl.toFixed(2))
  }
  
  // 30d: compound last ~4 weeks
  if (recent30d.length >= 2) {
    let compounded = 1
    let totalPnl = 0
    for (const w of recent30d) {
      const ratio = parseFloat(w.pnlRatio)
      const pnl = parseFloat(w.pnl)
      if (!isNaN(ratio)) compounded *= (1 + ratio)
      if (!isNaN(pnl)) totalPnl += pnl
    }
    result.roi_30d = parseFloat(((compounded - 1) * 100).toFixed(2))
    result.pnl_30d = parseFloat(totalPnl.toFixed(2))
  }
  
  return result
}

async function main() {
  console.log('OKX Futures — 7d/30d ROI+PNL enrichment')
  if (DRY_RUN) console.log('[DRY RUN]')

  // Fetch all OKX rows needing enrichment
  let allRows = [], offset = 0
  while (true) {
    const { data, error } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d, pnl_7d, pnl_30d')
      .eq('source', 'okx_futures')
      .or('roi_7d.is.null,roi_30d.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  // Group by trader
  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }

  let entries = [...traderMap.entries()]
  if (LIMIT) entries = entries.slice(0, LIMIT)
  console.log(`${allRows.length} rows, ${traderMap.size} unique traders${LIMIT ? ` (limited to ${entries.length})` : ''}`)

  let updated = 0, skipped = 0, failed = 0

  for (let i = 0; i < entries.length; i++) {
    const [uniqueCode, rows] = entries[i]

    const weeks = await fetchWeeklyPnl(uniqueCode)
    if (!weeks || weeks.length === 0) {
      skipped++
      if (i < 5) console.log(`  [${i + 1}] ${uniqueCode} — no data`)
      await sleep(300)
      continue
    }

    const metrics = computeMetrics(weeks)
    if (!Object.keys(metrics).length) {
      skipped++
      await sleep(300)
      continue
    }

    for (const row of rows) {
      const updates = {}
      if (row.roi_7d == null && metrics.roi_7d != null) updates.roi_7d = metrics.roi_7d
      if (row.roi_30d == null && metrics.roi_30d != null) updates.roi_30d = metrics.roi_30d
      if (row.pnl_7d == null && metrics.pnl_7d != null) updates.pnl_7d = metrics.pnl_7d
      if (row.pnl_30d == null && metrics.pnl_30d != null) updates.pnl_30d = metrics.pnl_30d

      if (!Object.keys(updates).length) continue

      if (DRY_RUN) {
        console.log(`  [DRY] ${uniqueCode} row ${row.id}:`, updates)
        updated++
      } else {
        const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', row.id)
        if (!error) updated++
        else failed++
      }
    }

    if ((i + 1) % 50 === 0 || i < 3)
      console.log(`  [${i + 1}/${entries.length}] updated=${updated} skipped=${skipped} failed=${failed}`)
    
    await sleep(300) // Rate limiting
  }

  console.log(`\nDONE: updated=${updated} skipped=${skipped} failed=${failed}`)
}

main().catch(console.error)
