#!/usr/bin/env node
/**
 * Enrich OKX Futures trader_snapshots with 7d/30d ROI and PNL
 *
 * Strategy:
 *   1. Scan all pages of public-lead-traders to build a nickName/uniqueCode → pnlRatios map
 *   2. For each trader needing enrichment:
 *      - hex16 uniqueCode: try public-weekly-pnl first; fallback to leaderboard pnlRatios
 *      - numeric uniqueCode: look up in leaderboard pnlRatios map
 *      - base64-name / plain-name: decode name, look up by nickName in map
 *   3. Compute roi_7d / roi_30d from the available data
 *      - public-weekly-pnl: weekly per-period returns → compound for 30d
 *      - leaderboard pnlRatios: cumulative returns → diff for period
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

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
const BASE = 'https://www.okx.com/api/v5/copytrading'

// ─── Helpers ────────────────────────────────────────────────────────────────

function decodeId(id) {
  // Returns { type: 'hex16'|'numeric'|'name', name: string }
  if (/^[0-9A-F]{16}$/.test(id)) return { type: 'hex16', name: id }
  if (/^\d{15,}$/.test(id)) return { type: 'numeric', name: id }
  // Try base64 decode → printable string
  try {
    const dec = Buffer.from(id, 'base64').toString('utf8')
    if (/^[\x20-\x7E\u4e00-\u9fa5\u3040-\u30ff]+$/.test(dec) && dec.length >= 2) {
      return { type: 'name', name: dec }
    }
  } catch {}
  // Treat as plain name
  return { type: 'name', name: id }
}

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(12000)
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

// ─── Leaderboard scan ───────────────────────────────────────────────────────

async function scanLeaderboard() {
  console.log('Scanning OKX leaderboard to build trader map...')
  // Map: key → { uniqueCode, pnlRatios[] }
  // Keys: uniqueCode (hex16/numeric) AND nickName
  const map = new Map()

  let totalPages = 30
  for (let page = 1; page <= totalPages; page++) {
    try {
      const json = await fetchJSON(`${BASE}/public-lead-traders?instType=SWAP&page=${page}`)
      if (!json || json.code !== '0' || !json.data?.length) break

      const item = json.data[0]
      if (page === 1) {
        totalPages = Math.min(parseInt(item.totalPage || 30), 200)
        console.log(`  Leaderboard pages: ${totalPages} (~${totalPages * 10} traders)`)
      }
      const ranks = item.ranks || []
      if (!ranks.length) break

      for (const t of ranks) {
        const entry = { uniqueCode: t.uniqueCode, pnlRatios: t.pnlRatios || [], nickName: t.nickName }
        if (t.uniqueCode) map.set(t.uniqueCode, entry)
        if (t.nickName) map.set(t.nickName, entry)
      }

      if (page % 10 === 0) process.stdout.write(`  Page ${page}/${totalPages}, traders=${map.size / 2}\r`)
      await sleep(250)
    } catch (e) {
      console.log(`  Page ${page} error: ${e.message}`)
      break
    }
  }

  console.log(`\n  Leaderboard scan done: ${map.size} entries (unique codes + names)`)
  return map
}

// ─── ROI computation from weekly PnL entries ────────────────────────────────
// Used when public-weekly-pnl returns per-week pnlRatio (decimal, e.g. 0.0266 = 2.66%)

function computeFromWeeklyPnl(weeks) {
  if (!weeks?.length) return {}
  const sorted = [...weeks].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  const now = Date.now()
  const WEEK_MS = 7 * 24 * 3600 * 1000

  const recent7d = sorted.filter(w => now - parseInt(w.beginTs) <= WEEK_MS * 1.5)
  const recent30d = sorted.filter(w => now - parseInt(w.beginTs) <= WEEK_MS * 5)

  const result = {}

  if (recent7d.length > 0) {
    const last = recent7d[recent7d.length - 1]
    const ratio = parseFloat(last.pnlRatio)
    const pnl = parseFloat(last.pnl)
    if (!isNaN(ratio)) result.roi_7d = parseFloat((ratio * 100).toFixed(2))
    if (!isNaN(pnl)) result.pnl_7d = parseFloat(pnl.toFixed(2))
  }

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

// ─── ROI computation from cumulative pnlRatios ──────────────────────────────
// Used when pnlRatios[] from public-lead-traders (cumulative, decimal, e.g. 3.1192 = +311.92%)
// Each entry: { beginTs, pnlRatio } where pnlRatio is cumulative from account start

function computeFromCumulativePnlRatios(pnlRatios) {
  if (!pnlRatios?.length) return {}
  const sorted = [...pnlRatios].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  if (sorted.length < 2) return {}

  const now = Date.now()
  const DAY_MS = 24 * 3600 * 1000

  // Get the latest ratio
  const latest = sorted[sorted.length - 1]
  const latestRatio = parseFloat(latest.pnlRatio)
  if (isNaN(latestRatio)) return {}

  const result = {}

  // 7d: find entry closest to 7 days ago, but at most 10 days ago
  const sevenDaysAgo = now - 7 * DAY_MS
  const tenDaysAgo = now - 10 * DAY_MS
  const entry7d = [...sorted].reverse().find(e =>
    parseInt(e.beginTs) <= sevenDaysAgo && parseInt(e.beginTs) >= tenDaysAgo
  ) || sorted.find(e => parseInt(e.beginTs) <= sevenDaysAgo) // fallback: any entry <= 7d ago

  if (entry7d) {
    const oldRatio = parseFloat(entry7d.pnlRatio)
    if (!isNaN(oldRatio)) {
      const roi7d = ((1 + latestRatio) / (1 + oldRatio) - 1) * 100
      if (isFinite(roi7d)) result.roi_7d = parseFloat(roi7d.toFixed(2))
    }
  }

  // 30d: find entry closest to 30 days ago, but at most 35 days ago
  const thirtyDaysAgo = now - 30 * DAY_MS
  const thirtyFiveDaysAgo = now - 35 * DAY_MS
  const entry30d = [...sorted].reverse().find(e =>
    parseInt(e.beginTs) <= thirtyDaysAgo && parseInt(e.beginTs) >= thirtyFiveDaysAgo
  ) || sorted.find(e => parseInt(e.beginTs) <= thirtyDaysAgo) // fallback

  if (entry30d) {
    const oldRatio = parseFloat(entry30d.pnlRatio)
    if (!isNaN(oldRatio)) {
      const roi30d = ((1 + latestRatio) / (1 + oldRatio) - 1) * 100
      if (isFinite(roi30d)) result.roi_30d = parseFloat(roi30d.toFixed(2))
    }
  }

  return result
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('OKX Futures — 7d/30d ROI+PNL enrichment (v2)')
  if (DRY_RUN) console.log('[DRY RUN]')

  // 1. Fetch all OKX rows needing enrichment
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

  // 2. Scan leaderboard to build map
  const leaderboardMap = await scanLeaderboard()

  // 3. Also get handles for numeric/name IDs from trader_sources
  const traderIds = entries.map(([id]) => id)
  const handleMap = new Map()
  for (let i = 0; i < traderIds.length; i += 200) {
    const chunk = traderIds.slice(i, i + 200)
    const { data } = await supabase.from('trader_sources')
      .select('source_trader_id, handle')
      .eq('source', 'okx_futures')
      .in('source_trader_id', chunk)
    for (const r of data || []) {
      if (r.handle) handleMap.set(r.source_trader_id, r.handle)
    }
  }
  console.log(`Got handles for ${handleMap.size}/${entries.length} traders`)

  let updated = 0, skipped = 0, failed = 0

  for (let i = 0; i < entries.length; i++) {
    const [traderId, rows] = entries[i]
    const { type, name } = decodeId(traderId)
    let metrics = {}
    let source = null

    // ── Strategy A: hex16 uniqueCode → try public-weekly-pnl ─────────────
    if (type === 'hex16') {
      const json = await fetchJSON(`${BASE}/public-weekly-pnl?instType=SWAP&uniqueCode=${traderId}`)
      if (json?.code === '0' && json.data?.length > 0) {
        metrics = computeFromWeeklyPnl(json.data)
        source = 'weekly-pnl'
      }
    }

    // ── Strategy B: look up in leaderboard map ───────────────────────────
    if (!Object.keys(metrics).length) {
      // Try multiple keys: traderId, decoded name, handle
      const lookupKeys = new Set([
        traderId,          // exact traderId (could be uniqueCode or plain name)
        name,              // decoded name (for base64 IDs)
      ])
      const handle = handleMap.get(traderId)
      if (handle) lookupKeys.add(handle)

      for (const key of lookupKeys) {
        const entry = leaderboardMap.get(key)
        if (entry?.pnlRatios?.length >= 2) {
          metrics = computeFromCumulativePnlRatios(entry.pnlRatios)
          if (Object.keys(metrics).length) {
            source = `leaderboard(${key})`
            break
          }
        }
      }
    }

    if (!Object.keys(metrics).length) {
      skipped++
      if (i < 5 || i % 50 === 0)
        console.log(`  [${i + 1}] ${traderId} (type=${type}, name="${name}") — no data`)
      await sleep(100)
      continue
    }

    // ── Write to DB ──────────────────────────────────────────────────────
    for (const row of rows) {
      const updates = {}
      if (row.roi_7d == null && metrics.roi_7d != null) updates.roi_7d = metrics.roi_7d
      if (row.roi_30d == null && metrics.roi_30d != null) updates.roi_30d = metrics.roi_30d
      if (row.pnl_7d == null && metrics.pnl_7d != null) updates.pnl_7d = metrics.pnl_7d
      if (row.pnl_30d == null && metrics.pnl_30d != null) updates.pnl_30d = metrics.pnl_30d

      if (!Object.keys(updates).length) continue

      if (DRY_RUN) {
        console.log(`  [DRY] ${traderId} (${source}) row ${row.id}:`, updates)
        updated++
      } else {
        const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', row.id)
        if (!error) updated++
        else { failed++; if (failed <= 3) console.log(`  DB error row ${row.id}:`, error.message) }
      }
    }

    if ((i + 1) % 50 === 0 || i < 3)
      console.log(`  [${i + 1}/${entries.length}] updated=${updated} skipped=${skipped} failed=${failed} | last: ${traderId} → ${source}`)

    await sleep(type === 'hex16' ? 300 : 50) // hex16 hits API; others just map lookup
  }

  console.log(`\nDONE: updated=${updated} skipped=${skipped} failed=${failed}`)

  // ── Post-run DB check ──────────────────────────────────────────────────
  const { count: nullRoi7d } = await supabase.from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'okx_futures').is('roi_7d', null)
  const { count: nullRoi30d } = await supabase.from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'okx_futures').is('roi_30d', null)

  console.log(`\nDB check: okx_futures null_roi_7d=${nullRoi7d} null_roi_30d=${nullRoi30d}`)
}

main().catch(console.error)
