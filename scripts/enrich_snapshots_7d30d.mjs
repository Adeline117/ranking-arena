#!/usr/bin/env node
/**
 * Enrich trader_snapshots with 7d/30d ROI & PNL data
 * 
 * Currently supported sources:
 * - hyperliquid: Uses portfolio API (week/month pnlHistory)
 * 
 * Usage:
 *   node enrich_snapshots_7d30d.mjs                    # all sources
 *   node enrich_snapshots_7d30d.mjs --source=hyperliquid
 *   node enrich_snapshots_7d30d.mjs --dry-run          # test mode, no writes
 *   node enrich_snapshots_7d30d.mjs --limit=10         # limit traders
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const args = process.argv.slice(2)
const SOURCE_FILTER = args.find(a => a.startsWith('--source='))?.split('=')[1] || null
const DRY_RUN = args.includes('--dry-run')
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || 0

// ═══════════════════════════════════════════
// Hyperliquid — portfolio API (week/month)
// pnlHistory last entry = cumulative ROI as decimal
// ═══════════════════════════════════════════
async function enrichHyperliquid() {
  console.log('\n═══ Hyperliquid — 7d/30d ROI+PNL enrichment ═══')
  if (DRY_RUN) console.log('  [DRY RUN MODE]')

  // Fetch rows needing enrichment
  let allRows = [], offset = 0
  while (true) {
    const { data, error } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d, pnl_7d, pnl_30d')
      .eq('source', 'hyperliquid')
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
  console.log(`  ${allRows.length} rows, ${traderMap.size} unique traders${LIMIT ? ` (limited to ${entries.length})` : ''}`)

  let updated = 0, skipped = 0, failed = 0, apiErrors = 0

  for (let i = 0; i < entries.length; i++) {
    const [address, rows] = entries[i]

    // Call Hyperliquid portfolio API
    let portfolio = null
    for (let retry = 0; retry < 3; retry++) {
      try {
        const res = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'portfolio', user: address }),
          signal: AbortSignal.timeout(8000),
        })
        if (res.status === 429) {
          console.log(`  [429] Rate limited, waiting ${3 * (retry + 1)}s...`)
          await sleep(3000 * (retry + 1))
          continue
        }
        if (!res.ok) { apiErrors++; break }
        portfolio = await res.json()
        break
      } catch (e) {
        if (retry < 2) await sleep(1000)
        else apiErrors++
      }
    }

    if (!portfolio || !Array.isArray(portfolio)) {
      skipped++
      if (i < 3) console.log(`  [${i + 1}] ${address} — no portfolio data`)
      await sleep(200)
      continue
    }

    // Parse period data: portfolio is array of [periodName, data]
    const periodData = {}
    for (const [name, data] of portfolio) {
      if (name === 'week' || name === 'month') {
        periodData[name] = data
      }
    }

    // Extract ROI and PNL for each period
    const enriched = {}
    
    for (const [period, col7d, col30d] of [['week', 'roi_7d', 'pnl_7d'], ['month', 'roi_30d', 'pnl_30d']]) {
      const d = periodData[period]
      if (!d) continue

      // pnlHistory: last entry value is cumulative ROI as decimal fraction
      const pnlHist = d.pnlHistory
      if (pnlHist?.length > 0) {
        const lastRoi = parseFloat(pnlHist[pnlHist.length - 1][1])
        if (!isNaN(lastRoi)) {
          const roiKey = period === 'week' ? 'roi_7d' : 'roi_30d'
          enriched[roiKey] = parseFloat((lastRoi * 100).toFixed(6)) // Convert to percentage
        }
      }

      // PNL: difference between last and first account value
      const avh = d.accountValueHistory
      if (avh?.length >= 2) {
        const firstVal = parseFloat(avh[0][1])
        const lastVal = parseFloat(avh[avh.length - 1][1])
        if (!isNaN(firstVal) && !isNaN(lastVal) && firstVal > 0) {
          const pnlKey = period === 'week' ? 'pnl_7d' : 'pnl_30d'
          enriched[pnlKey] = parseFloat((lastVal - firstVal).toFixed(6))
        }
      }
    }

    // Update each row for this trader
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

    if ((i + 1) % 20 === 0 || i < 3 || i === entries.length - 1) {
      console.log(`  [${i + 1}/${entries.length}] updated=${updated} skipped=${skipped} failed=${failed} apiErrors=${apiErrors}`)
    }
    await sleep(200) // Rate limit: ~5 req/s
  }

  console.log(`  ═══ DONE: updated=${updated} skipped=${skipped} failed=${failed} apiErrors=${apiErrors} ═══`)
}

// ═══════════════════════════════════════════
// Binance Futures — detail API (7D/30D)
// Requires ClashX proxy on 127.0.0.1:7890
// ═══════════════════════════════════════════
async function enrichBinanceFutures() {
  console.log('\n═══ Binance Futures — 7d/30d ROI+PNL enrichment ═══')
  if (DRY_RUN) console.log('  [DRY RUN MODE]')

  const PROXY = 'http://127.0.0.1:7890'
  const DETAIL_API = 'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance'
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Origin': 'https://www.binance.com',
  }

  // Check proxy availability
  try {
    const testRes = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(5000),
      agent: undefined, // Node fetch doesn't use agent, we'll use env
    })
  } catch {}

  // We use node's undici ProxyAgent for proxy support
  let ProxyAgent
  try {
    const undici = await import('undici')
    ProxyAgent = undici.ProxyAgent
  } catch {
    console.log('  undici not available, trying global-agent...')
  }

  const dispatcher = ProxyAgent ? new ProxyAgent(PROXY) : undefined

  async function proxyFetch(url) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const res = await fetch(url, {
          headers: HEADERS,
          signal: AbortSignal.timeout(10000),
          dispatcher,
        })
        if (res.status === 429) {
          console.log(`  [429] Rate limited, waiting ${3 * (retry + 1)}s...`)
          await sleep(3000 * (retry + 1))
          continue
        }
        if (!res.ok) return null
        const data = await res.json()
        if (data.code !== '000000' || !data.data) return null
        return data.data
      } catch (e) {
        if (retry < 2) await sleep(1000)
      }
    }
    return null
  }

  // Fetch rows needing enrichment
  let allRows = [], offset = 0
  while (true) {
    const { data, error } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d, pnl_7d, pnl_30d')
      .eq('source', 'binance_futures')
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
  console.log(`  ${allRows.length} rows, ${traderMap.size} unique traders${LIMIT ? ` (limited to ${entries.length})` : ''}`)

  let updated = 0, skipped = 0, failed = 0, apiErrors = 0

  for (let i = 0; i < entries.length; i++) {
    const [traderId, rows] = entries[i]

    // Fetch 7D and 30D data
    const [data7d, data30d] = await Promise.all([
      proxyFetch(`${DETAIL_API}?portfolioId=${traderId}&timeRange=7D`),
      proxyFetch(`${DETAIL_API}?portfolioId=${traderId}&timeRange=30D`),
    ])

    const enriched = {}
    if (data7d) {
      if (data7d.roi != null) enriched.roi_7d = parseFloat(parseFloat(data7d.roi).toFixed(6))
      if (data7d.pnl != null) enriched.pnl_7d = parseFloat(parseFloat(data7d.pnl).toFixed(6))
    }
    if (data30d) {
      if (data30d.roi != null) enriched.roi_30d = parseFloat(parseFloat(data30d.roi).toFixed(6))
      if (data30d.pnl != null) enriched.pnl_30d = parseFloat(parseFloat(data30d.pnl).toFixed(6))
    }

    if (!data7d && !data30d) {
      apiErrors++
      skipped += rows.length
      if (i < 3) console.log(`  [${i + 1}] ${traderId} — no API data`)
      await sleep(300)
      continue
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

    if ((i + 1) % 20 === 0 || i < 3 || i === entries.length - 1) {
      console.log(`  [${i + 1}/${entries.length}] updated=${updated} skipped=${skipped} failed=${failed} apiErrors=${apiErrors}`)
    }
    await sleep(300) // Rate limit: ~3 req/s (2 calls per trader)
  }

  console.log(`  ═══ DONE: updated=${updated} skipped=${skipped} failed=${failed} apiErrors=${apiErrors} ═══`)
}

// ═══════════════════════════════════════════
// Main
// ═══════════════════════════════════════════
const ALL = {
  hyperliquid: enrichHyperliquid,
  binance_futures: enrichBinanceFutures,
}

async function main() {
  console.log('Enrich trader_snapshots 7d/30d — started')
  console.log(`Sources available: ${Object.keys(ALL).join(', ')}`)
  
  if (SOURCE_FILTER) {
    if (!ALL[SOURCE_FILTER]) {
      console.error(`Unknown source: ${SOURCE_FILTER}. Available: ${Object.keys(ALL).join(', ')}`)
      process.exit(1)
    }
    await ALL[SOURCE_FILTER]()
  } else {
    for (const [name, fn] of Object.entries(ALL)) {
      await fn()
    }
  }
  console.log('\nAll done!')
}

main().catch(console.error)
