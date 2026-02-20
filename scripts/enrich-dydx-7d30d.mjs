#!/usr/bin/env node
/**
 * dYdX 7d/30d ROI & PNL Enrichment
 *
 * Fetches historical PnL equity curve from dydx v4 indexer (via SOCKS5 proxy)
 * and computes 7d/30d ROI and PNL for trader_snapshots where roi_7d IS NULL.
 *
 * Algorithm:
 *   - Fetch paginated hourly equity snapshots (up to 35 days)
 *   - Find entries closest to 7d ago and 30d ago
 *   - roi_7d  = (totalPnl_now - totalPnl_7d_ago)  / |equity_7d_ago| * 100
 *   - roi_30d = (totalPnl_now - totalPnl_30d_ago) / |equity_30d_ago| * 100
 *   - pnl_7d  = totalPnl_now - totalPnl_7d_ago
 *   - pnl_30d = totalPnl_now - totalPnl_30d_ago
 *
 * Prerequisites:
 *   ssh -D 1080 -N -f root@45.76.152.169
 *
 * Usage:
 *   node scripts/enrich-dydx-7d30d.mjs
 *   node scripts/enrich-dydx-7d30d.mjs --dry-run
 *   node scripts/enrich-dydx-7d30d.mjs --limit=20
 */
import { createClient } from '@supabase/supabase-js'
import { exec } from 'child_process'
import { promisify } from 'util'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const execAsync = promisify(exec)

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const INDEXER = 'https://indexer.dydx.trade/v4'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || 0
const PROXY = 'socks5h://127.0.0.1:1080'

async function curlGet(url) {
  try {
    const { stdout } = await execAsync(
      `curl -s --max-time 20 -x ${PROXY} '${url}' -H 'User-Agent: Mozilla/5.0'`,
      { timeout: 25000 }
    )
    const parsed = JSON.parse(stdout)
    if (parsed?.errors?.[0]?.code === 'GEOBLOCKED') {
      console.error('  ⚠️  GEOBLOCKED — is SOCKS proxy running? Run: ssh -D 1080 -N -f root@45.76.152.169')
      return null
    }
    return parsed
  } catch (e) {
    return null
  }
}

/**
 * Fetch full historical PnL with pagination to cover up to ~35 days
 * Returns array sorted newest-first
 */
async function fetchHistoricalPnl(address) {
  const all = []
  let beforeOrAt = null
  const maxPages = 8  // 8 * 200 = 1600 entries ≈ ~67 days

  for (let page = 0; page < maxPages; page++) {
    const url = beforeOrAt
      ? `${INDEXER}/historical-pnl?address=${address}&subaccountNumber=0&limit=200&createdBeforeOrAt=${encodeURIComponent(beforeOrAt)}`
      : `${INDEXER}/historical-pnl?address=${address}&subaccountNumber=0&limit=200`

    const data = await curlGet(url)
    if (!data?.historicalPnl?.length) break

    const entries = data.historicalPnl
    all.push(...entries)

    if (entries.length < 200) break  // last page

    // Paginate: use last entry's timestamp minus 1 second
    const lastTs = entries[entries.length - 1].createdAt
    const lastDate = new Date(lastTs)
    lastDate.setSeconds(lastDate.getSeconds() - 1)
    beforeOrAt = lastDate.toISOString()

    // Check if we have enough history (35+ days)
    const firstTs = new Date(all[0].createdAt)
    const lastTsDate = new Date(lastTs)
    if ((firstTs - lastTsDate) > 35 * 24 * 3600 * 1000) break

    await sleep(300)
  }

  return all
}

/**
 * Find entry closest to targetTs in array sorted newest-first
 * Returns the entry within maxDiffHours of target, or null
 */
function findClosestEntry(entries, targetTs, maxDiffHours = 4) {
  const target = new Date(targetTs).getTime()
  let closest = null
  let closestDiff = Infinity

  for (const e of entries) {
    const ts = new Date(e.createdAt).getTime()
    const diff = Math.abs(ts - target)
    if (diff < closestDiff) {
      closestDiff = diff
      closest = e
    }
  }

  if (closestDiff > maxDiffHours * 3600 * 1000) return null
  return closest
}

/**
 * Compute 7d/30d ROI and PNL from historical data
 */
function computeMetrics(entries) {
  if (!entries?.length) return {}

  const now = new Date(entries[0].createdAt).getTime()
  const nowPnl = parseFloat(entries[0].totalPnl)
  const nowEquity = parseFloat(entries[0].equity)

  const result = {}

  // 7-day window
  const target7d = now - 7 * 24 * 3600 * 1000
  const entry7d = findClosestEntry(entries, target7d, 6)
  if (entry7d) {
    const pnlThen = parseFloat(entry7d.totalPnl)
    const equityThen = parseFloat(entry7d.equity)
    const pnlDiff = nowPnl - pnlThen
    if (Math.abs(equityThen) > 1) {
      result.roi_7d = parseFloat((pnlDiff / Math.abs(equityThen) * 100).toFixed(4))
      result.pnl_7d = parseFloat(pnlDiff.toFixed(4))
    }
  }

  // 30-day window
  const target30d = now - 30 * 24 * 3600 * 1000
  const entry30d = findClosestEntry(entries, target30d, 12)
  if (entry30d) {
    const pnlThen = parseFloat(entry30d.totalPnl)
    const equityThen = parseFloat(entry30d.equity)
    const pnlDiff = nowPnl - pnlThen
    if (Math.abs(equityThen) > 1) {
      result.roi_30d = parseFloat((pnlDiff / Math.abs(equityThen) * 100).toFixed(4))
      result.pnl_30d = parseFloat(pnlDiff.toFixed(4))
    }
  }

  // Also compute max_drawdown from equity curve if we have enough data
  if (entries.length >= 5) {
    const equities = entries.map(e => parseFloat(e.equity)).reverse() // oldest first
    let peak = equities[0], maxDD = 0
    for (const eq of equities) {
      if (eq > peak) peak = eq
      if (peak > 0) {
        const dd = (peak - eq) / peak
        if (dd > maxDD) maxDD = dd
      }
    }
    if (maxDD > 0.001) {
      result.max_drawdown = parseFloat((maxDD * 100).toFixed(4))
    }
  }

  return result
}

async function main() {
  console.log('🚀 dYdX 7d/30d Enrichment\n')
  if (DRY_RUN) console.log('  [DRY RUN — no DB writes]\n')

  // Fetch all rows with null roi_7d or roi_30d
  console.log('📋 Fetching rows needing enrichment...')
  let allRows = [], offset = 0
  while (true) {
    const { data, error } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d, pnl_7d, pnl_30d, max_drawdown')
      .eq('source', 'dydx')
      .or('roi_7d.is.null,roi_30d.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  console.log(`  Found ${allRows.length} rows needing enrichment`)

  // Group by trader
  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }

  let traders = [...traderMap.entries()]
  if (LIMIT) traders = traders.slice(0, LIMIT)
  console.log(`  Unique traders: ${traderMap.size}${LIMIT ? ` (limited to ${traders.length})` : ''}\n`)

  let updated = 0, noData = 0, errors = 0

  for (let i = 0; i < traders.length; i++) {
    const [address, rows] = traders[i]

    const entries = await fetchHistoricalPnl(address)
    await sleep(500)

    if (!entries.length) {
      noData++
      if ((i + 1) % 10 === 0) console.log(`  [${i+1}/${traders.length}] updated=${updated} noData=${noData}`)
      continue
    }

    const metrics = computeMetrics(entries)
    const hasMetrics = Object.keys(metrics).length > 0

    if (!hasMetrics) {
      noData++
      continue
    }

    console.log(`  [${i+1}/${traders.length}] ${address.slice(0, 12)}... roi_7d=${metrics.roi_7d ?? 'N/A'} roi_30d=${metrics.roi_30d ?? 'N/A'} mdd=${metrics.max_drawdown ?? 'N/A'}`)

    if (!DRY_RUN) {
      for (const row of rows) {
        const updates = {}
        if (row.roi_7d == null && metrics.roi_7d != null) updates.roi_7d = metrics.roi_7d
        if (row.roi_30d == null && metrics.roi_30d != null) updates.roi_30d = metrics.roi_30d
        if (row.pnl_7d == null && metrics.pnl_7d != null) updates.pnl_7d = metrics.pnl_7d
        if (row.pnl_30d == null && metrics.pnl_30d != null) updates.pnl_30d = metrics.pnl_30d
        if (row.max_drawdown == null && metrics.max_drawdown != null) updates.max_drawdown = metrics.max_drawdown

        if (Object.keys(updates).length > 0) {
          const { error } = await sb.from('trader_snapshots')
            .update(updates)
            .eq('id', row.id)
          if (error) {
            console.error(`  ❌ Update failed for row ${row.id}: ${error.message}`)
            errors++
          }
        }
      }
      updated++
    } else {
      updated++
    }
  }

  console.log(`\n✅ Done: updated=${updated} noData=${noData} errors=${errors}`)

  // Verification
  console.log('\n📊 Verification:')
  const { count: totalDydx } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'dydx')
  const { count: null7d } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'dydx').is('roi_7d', null)
  const { count: null30d } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'dydx').is('roi_30d', null)
  console.log(`  Total dydx rows: ${totalDydx}`)
  console.log(`  roi_7d IS NULL:  ${null7d}`)
  console.log(`  roi_30d IS NULL: ${null30d}`)
}

main().catch(e => { console.error(e); process.exit(1) })
