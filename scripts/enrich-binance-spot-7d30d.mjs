#!/usr/bin/env node
/**
 * Enrich binance_spot trader_snapshots with 7d/30d ROI & PNL data
 *
 * API: https://www.binance.com/bapi/futures/v1/public/future/spot-copy-trade/lead-portfolio/performance?portfolioId=<id>&timeRange=7D
 * Requires ClashX proxy on 127.0.0.1:7890
 *
 * Usage:
 *   node scripts/enrich-binance-spot-7d30d.mjs
 *   node scripts/enrich-binance-spot-7d30d.mjs --dry-run
 *   node scripts/enrich-binance-spot-7d30d.mjs --limit=50
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

const PROXY = 'http://127.0.0.1:7890'
const SPOT_PERF_API = 'https://www.binance.com/bapi/futures/v1/public/future/spot-copy-trade/lead-portfolio/performance'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://www.binance.com',
  'Referer': 'https://www.binance.com/en/copy-trading/spot',
}

let ProxyAgent
try {
  const undici = await import('undici')
  ProxyAgent = undici.ProxyAgent
  console.log('  ✓ undici ProxyAgent loaded')
} catch {
  console.log('  ⚠ undici not available — requests will be direct (may be blocked)')
}

const dispatcher = ProxyAgent ? new ProxyAgent(PROXY) : undefined

async function proxyFetch(url) {
  for (let retry = 0; retry < 3; retry++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(12000),
        dispatcher,
      })
      if (res.status === 429) {
        console.log(`  [429] Rate limited, waiting ${4 * (retry + 1)}s...`)
        await sleep(4000 * (retry + 1))
        continue
      }
      if (!res.ok) return null
      const json = await res.json()
      if (json.code !== '000000' || !json.data) return null
      return json.data
    } catch (e) {
      if (retry < 2) await sleep(1500)
    }
  }
  return null
}

async function main() {
  console.log('\n═══ Binance Spot — 7d/30d ROI+PNL enrichment ═══')
  if (DRY_RUN) console.log('  [DRY RUN MODE]')

  // Fetch rows needing enrichment
  let allRows = [], offset = 0
  while (true) {
    const { data, error } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d, pnl_7d, pnl_30d')
      .eq('source', 'binance_spot')
      .or('roi_7d.is.null,roi_30d.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  // Group by trader ID
  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }

  let entries = [...traderMap.entries()]
  if (LIMIT) entries = entries.slice(0, LIMIT)
  console.log(`  ${allRows.length} rows, ${traderMap.size} unique traders${LIMIT ? ` (limited to ${entries.length})` : ''}`)

  let updated = 0, skipped = 0, failed = 0, apiErrors = 0, closed = 0

  for (let i = 0; i < entries.length; i++) {
    const [traderId, rows] = entries[i]

    // Fetch 7D and 30D in parallel
    const [data7d, data30d] = await Promise.all([
      proxyFetch(`${SPOT_PERF_API}?portfolioId=${traderId}&timeRange=7D`),
      proxyFetch(`${SPOT_PERF_API}?portfolioId=${traderId}&timeRange=30D`),
    ])

    if (!data7d && !data30d) {
      apiErrors++
      skipped += rows.length
      await sleep(300)
      continue
    }

    const enriched = {}
    if (data7d) {
      if (data7d.roi != null) enriched.roi_7d = parseFloat(parseFloat(data7d.roi).toFixed(6))
      if (data7d.pnl != null) enriched.pnl_7d = parseFloat(parseFloat(data7d.pnl).toFixed(6))
    }
    if (data30d) {
      if (data30d.roi != null) enriched.roi_30d = parseFloat(parseFloat(data30d.roi).toFixed(6))
      if (data30d.pnl != null) enriched.pnl_30d = parseFloat(parseFloat(data30d.pnl).toFixed(6))
    }

    for (const row of rows) {
      const updates = {}
      if (row.roi_7d == null && enriched.roi_7d != null) updates.roi_7d = enriched.roi_7d
      if (row.roi_30d == null && enriched.roi_30d != null) updates.roi_30d = enriched.roi_30d
      if (row.pnl_7d == null && enriched.pnl_7d != null) updates.pnl_7d = enriched.pnl_7d
      if (row.pnl_30d == null && enriched.pnl_30d != null) updates.pnl_30d = enriched.pnl_30d

      if (!Object.keys(updates).length) { skipped++; continue }

      if (DRY_RUN) {
        if (i < 5) console.log(`  [DRY] id=${row.id} would update:`, updates)
        updated++
        continue
      }

      const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) updated++
      else { failed++; if (failed <= 3) console.error(`  DB error:`, error.message) }
    }

    if ((i + 1) % 50 === 0 || i < 3 || i === entries.length - 1) {
      console.log(`  [${i + 1}/${entries.length}] updated=${updated} skipped=${skipped} failed=${failed} apiErrors=${apiErrors}`)
    }

    await sleep(250) // ~4 req/s (2 calls per trader)
  }

  console.log(`\n  ═══ DONE ═══`)
  console.log(`  updated=${updated} skipped=${skipped} failed=${failed} apiErrors=${apiErrors}`)

  // Final null count check
  const { count: remaining } = await supabase.from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'binance_spot')
    .or('roi_7d.is.null,roi_30d.is.null')
  console.log(`  Remaining nulls (binance_spot): ${remaining}`)
}

main().catch(console.error)
