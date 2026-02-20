#!/usr/bin/env node
/**
 * Enrich OKX trader_snapshots with roi_7d and roi_30d for ALL OKX sources
 *
 * Handles two source types:
 *   - okx_futures: hex16/numeric/name uniqueCodes → public-weekly-pnl API
 *   - okx_web3: hex16 uniqueCodes → public-weekly-pnl API
 *               truncated wallet addresses (e.g. "AbcDef...XyzW") → smartmoney ranking API
 *
 * Strategy:
 *   1. Fetch all null roi_7d / roi_30d rows for okx_futures + okx_web3
 *   2. For hex16 uniqueCodes: call public-weekly-pnl individually → compound roi_7d/roi_30d
 *   3. For truncated wallet addresses: batch scan smartmoney ranking for periodType=1 (7D) and =2 (30D)
 *   4. Fallback for hex16 not found: scan SWAP leaderboard pnlRatios
 *
 * Usage:
 *   node scripts/enrich-okx-all-roi.mjs
 *   node scripts/enrich-okx-all-roi.mjs --dry-run
 *   node scripts/enrich-okx-all-roi.mjs --source=okx_web3
 *   node scripts/enrich-okx-all-roi.mjs --source=okx_futures
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dir, '..', '.env.local')

// Parse .env.local manually
const envContent = readFileSync(envPath, 'utf8')
const env = {}
for (const line of envContent.split('\n')) {
  const m = line.match(/^([^=]+)=(.*)$/)
  if (!m) continue
  const key = m[1].trim()
  let val = m[2].trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1)
  }
  env[key] = val
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SWAP_BASE = 'https://www.okx.com/api/v5/copytrading'
const SMARTMONEY_BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Helpers ────────────────────────────────────────────────────────────────

function isHex16(id) { return /^[0-9A-F]{16}$/.test(id) }
function isNumeric(id) { return /^\d{15,}$/.test(id) }
function isTruncatedAddr(id) { return /^.{6}\.{3}.{4}$/.test(id) }

async function fetchJSON(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000)
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < retries - 1) await sleep(1000 * (i + 1)) }
  }
  return null
}

// ─── Weekly PnL → compute roi_7d and roi_30d ────────────────────────────────

function computeFromWeeklyPnl(weeks) {
  if (!weeks?.length) return {}
  const sorted = [...weeks].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  const now = Date.now()
  const WEEK_MS = 7 * 24 * 3600 * 1000

  // 7d: last week (most recent entry within 10 days)
  const recent = [...sorted].reverse().find(w => now - parseInt(w.beginTs) <= WEEK_MS * 1.5)
  // 30d: up to 5 most recent weeks
  const last5 = sorted.filter(w => now - parseInt(w.beginTs) <= WEEK_MS * 5.5)

  const result = {}

  if (recent) {
    const ratio = parseFloat(recent.pnlRatio)
    if (!isNaN(ratio)) result.roi_7d = parseFloat((ratio * 100).toFixed(4))
  }

  if (last5.length >= 1) {
    let compound = 1
    for (const w of last5) {
      const ratio = parseFloat(w.pnlRatio)
      if (!isNaN(ratio)) compound *= (1 + ratio)
    }
    result.roi_30d = parseFloat(((compound - 1) * 100).toFixed(4))
  }

  return result
}

// ─── Cumulative pnlRatios → compute roi_7d and roi_30d ──────────────────────

function computeFromCumulativeRatios(pnlRatios) {
  if (!pnlRatios?.length || pnlRatios.length < 2) return {}
  const sorted = [...pnlRatios].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  const now = Date.now()
  const DAY_MS = 24 * 3600 * 1000

  const latest = sorted[sorted.length - 1]
  const latestRatio = parseFloat(latest.pnlRatio)
  if (isNaN(latestRatio)) return {}

  const result = {}

  // 7d: find entry ~7 days ago
  const target7 = now - 7 * DAY_MS
  const entry7 = sorted.slice().reverse().find(e => parseInt(e.beginTs) <= target7)
  if (entry7) {
    const old = parseFloat(entry7.pnlRatio)
    if (!isNaN(old)) {
      const roi = ((1 + latestRatio) / (1 + old) - 1) * 100
      if (isFinite(roi)) result.roi_7d = parseFloat(roi.toFixed(4))
    }
  }

  // 30d: find entry ~30 days ago
  const target30 = now - 30 * DAY_MS
  const entry30 = sorted.slice().reverse().find(e => parseInt(e.beginTs) <= target30)
  if (entry30) {
    const old = parseFloat(entry30.pnlRatio)
    if (!isNaN(old)) {
      const roi = ((1 + latestRatio) / (1 + old) - 1) * 100
      if (isFinite(roi)) result.roi_30d = parseFloat(roi.toFixed(4))
    }
  }

  return result
}

// ─── Enrich hex16/numeric traders via public-weekly-pnl ────────────────────

async function enrichViaWeeklyPnl(entries) {
  console.log(`\n[Strategy A] public-weekly-pnl for ${entries.length} hex16/numeric traders...`)
  const results = new Map() // traderId → {roi_7d, roi_30d}

  let fetched = 0, found = 0, failed = 0

  for (let i = 0; i < entries.length; i++) {
    const traderId = entries[i]
    fetched++

    const json = await fetchJSON(`${SWAP_BASE}/public-weekly-pnl?instType=SWAP&uniqueCode=${traderId}`)

    if (json?.code === '0' && json.data?.length > 0) {
      const metrics = computeFromWeeklyPnl(json.data)
      if (Object.keys(metrics).length > 0) {
        results.set(traderId, metrics)
        found++
      } else {
        failed++
        if (failed <= 3) console.log(`  [${traderId}] weekly-pnl: no computable metrics from ${json.data.length} weeks`)
      }
    } else {
      failed++
      if (failed <= 5) console.log(`  [${traderId}] weekly-pnl: ${json?.code || 'null'} ${json?.msg || ''}`)
    }

    if ((i + 1) % 20 === 0 || i < 3)
      process.stdout.write(`  [${i+1}/${entries.length}] found=${found} failed=${failed}\r`)

    await sleep(250)
  }

  console.log(`\n  → hex16/numeric: found=${found}/${fetched} via weekly-pnl`)
  return results
}

// ─── Enrich hex16 via leaderboard scan (fallback) ───────────────────────────

async function buildLeaderboardMap() {
  console.log('\n[Strategy B] Scanning SWAP leaderboard for pnlRatios...')
  const map = new Map() // uniqueCode → {pnlRatios, nickName}

  let totalPages = 30
  for (let page = 1; page <= Math.min(totalPages, 200); page++) {
    const json = await fetchJSON(`${SWAP_BASE}/public-lead-traders?instType=SWAP&page=${page}`)
    if (!json || json.code !== '0' || !json.data?.length) break

    const item = json.data[0]
    if (page === 1) {
      totalPages = parseInt(item.totalPage || 30)
      console.log(`  totalPages=${totalPages} (~${totalPages * 10} traders)`)
    }
    const ranks = item.ranks || []
    if (!ranks.length) break

    for (const t of ranks) {
      if (t.uniqueCode) {
        map.set(t.uniqueCode, { pnlRatios: t.pnlRatios || [], nickName: t.nickName })
        if (t.nickName) map.set(t.nickName, { pnlRatios: t.pnlRatios || [], nickName: t.nickName, uniqueCode: t.uniqueCode })
      }
    }

    if (page % 5 === 0) process.stdout.write(`  Page ${page}/${totalPages} (${map.size} entries)\r`)
    await sleep(200)
  }
  console.log(`\n  Leaderboard map: ${map.size} entries`)
  return map
}

// ─── Smartmoney scan for truncated wallet addresses ────────────────────────

async function buildSmartmoneyMap(periodType, chainIds = [501, 1, 56, 8453, 137, 10, 42161]) {
  const map = new Map() // truncated_addr → roi (percent)
  const PERIOD_NAME = periodType === '1' ? '7D' : periodType === '2' ? '30D' : periodType

  console.log(`\n  Scanning smartmoney for periodType=${periodType} (${PERIOD_NAME})...`)

  for (const chainId of chainIds) {
    let pageEmptyStreak = 0
    let fetched = 0

    for (let start = 0; start < 5000; start += 20) {
      const url = `${SMARTMONEY_BASE}?rankStart=${start}&periodType=${periodType}&rankBy=1&label=all&desc=true&rankEnd=${start+20}&chainId=${chainId}`
      const json = await fetchJSON(url)
      const infos = json?.data?.rankingInfos || []

      if (!infos.length) {
        pageEmptyStreak++
        if (pageEmptyStreak >= 3) break
        await sleep(300)
        continue
      }
      pageEmptyStreak = 0

      for (const t of infos) {
        if (!t.walletAddress) continue
        const addr = t.walletAddress
        const trunc = addr.length >= 10 ? `${addr.slice(0,6)}...${addr.slice(-4)}` : addr
        const roi = parseFloat(t.roi || t.pnl || 'NaN')
        // roi from API is already a percentage
        if (!isNaN(roi)) {
          if (!map.has(trunc)) map.set(trunc, roi)
          if (!map.has(addr)) map.set(addr, roi)
        }
      }

      fetched += infos.length
      await sleep(150)
    }
    process.stdout.write(`    chain=${chainId}: ${fetched} traders scanned, map size=${map.size}\n`)
  }

  return map
}

// ─── Fetch rows from DB ──────────────────────────────────────────────────────

async function fetchNullRows(source) {
  let allRows = [], offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d, season_id')
      .eq('source', source)
      .or('roi_7d.is.null,roi_30d.is.null')
      .range(offset, offset + 999)
    if (error) { console.error(`DB error:`, error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  return allRows
}

// ─── Apply updates to DB ────────────────────────────────────────────────────

async function applyUpdate(id, updates, dryRun) {
  if (!Object.keys(updates).length) return false
  if (dryRun) return true
  const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', id)
  return !error
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function processSource(source) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`Processing source: ${source}`)
  console.log(`${'═'.repeat(60)}`)

  // 1. Fetch null rows
  let rows = await fetchNullRows(source)
  if (LIMIT) rows = rows.slice(0, LIMIT)
  console.log(`Found ${rows.length} rows with null roi_7d or roi_30d`)
  if (!rows.length) return { updated: 0, skipped: 0 }

  // Categorize by trader type
  const hex16Traders = new Set()
  const numericTraders = new Set()
  const truncAddrTraders = new Set()
  const otherTraders = new Set()

  for (const r of rows) {
    const id = r.source_trader_id
    if (isHex16(id)) hex16Traders.add(id)
    else if (isNumeric(id)) numericTraders.add(id)
    else if (isTruncatedAddr(id)) truncAddrTraders.add(id)
    else otherTraders.add(id)
  }

  console.log(`Trader types: hex16=${hex16Traders.size} numeric=${numericTraders.size} truncAddr=${truncAddrTraders.size} other=${otherTraders.size}`)

  // ── Strategy A: hex16 + numeric via public-weekly-pnl ──────────────────────
  const weeklyResults = await enrichViaWeeklyPnl([...hex16Traders, ...numericTraders])

  // ── Strategy B: hex16 not found → try leaderboard pnlRatios ───────────────
  const notFoundHex16 = [...hex16Traders].filter(id => !weeklyResults.has(id))
  let leaderboardMap = null

  if (notFoundHex16.length > 0) {
    console.log(`\n${notFoundHex16.length} hex16 traders not found via weekly-pnl, trying leaderboard...`)
    leaderboardMap = await buildLeaderboardMap()

    for (const traderId of notFoundHex16) {
      const entry = leaderboardMap.get(traderId)
      if (entry?.pnlRatios?.length >= 2) {
        const metrics = computeFromCumulativeRatios(entry.pnlRatios)
        if (Object.keys(metrics).length > 0) weeklyResults.set(traderId, metrics)
      }
    }
  }

  // ── Also try name-based IDs against leaderboard ────────────────────────────
  if (otherTraders.size > 0) {
    if (!leaderboardMap) leaderboardMap = await buildLeaderboardMap()
    console.log(`\nLooking up ${otherTraders.size} other traders by name in leaderboard...`)
    let nameFound = 0
    for (const traderId of otherTraders) {
      // Try direct key, then try base64 decode
      let lookupName = traderId
      try {
        const dec = Buffer.from(traderId, 'base64').toString('utf8')
        if (/^[\x20-\x7E\u4e00-\u9fa5\u3040-\u30ff]+$/.test(dec) && dec.length >= 2) {
          lookupName = dec
        }
      } catch {}
      const entry = leaderboardMap.get(lookupName) || leaderboardMap.get(traderId)
      if (entry?.pnlRatios?.length >= 2) {
        const metrics = computeFromCumulativeRatios(entry.pnlRatios)
        if (Object.keys(metrics).length > 0) {
          weeklyResults.set(traderId, metrics)
          nameFound++
        }
      }
    }
    console.log(`  Found ${nameFound}/${otherTraders.size} name-based traders in leaderboard`)
  }

  // ── Strategy C: truncated wallet addresses via smartmoney API ─────────────
  let smartmoney7dMap = new Map()
  let smartmoney30dMap = new Map()

  if (truncAddrTraders.size > 0) {
    console.log(`\n[Strategy C] Smartmoney API for ${truncAddrTraders.size} truncated address traders...`)

    // Check which need 7d vs 30d
    const need7d = new Set()
    const need30d = new Set()
    for (const r of rows) {
      if (truncAddrTraders.has(r.source_trader_id)) {
        if (r.roi_7d == null) need7d.add(r.source_trader_id)
        if (r.roi_30d == null) need30d.add(r.source_trader_id)
      }
    }

    if (need7d.size > 0) {
      smartmoney7dMap = await buildSmartmoneyMap('1') // 7D
    }
    if (need30d.size > 0) {
      smartmoney30dMap = await buildSmartmoneyMap('2') // 30D
    }

    const found7d = [...need7d].filter(id => smartmoney7dMap.has(id)).length
    const found30d = [...need30d].filter(id => smartmoney30dMap.has(id)).length
    console.log(`  Smartmoney: found ${found7d}/${need7d.size} for 7D, ${found30d}/${need30d.size} for 30D`)
  }

  // ── Apply updates ──────────────────────────────────────────────────────────
  console.log(`\n[Applying updates...]`)
  let updated = 0, skipped = 0, failed = 0

  // Group rows by trader_id for efficiency
  const rowsByTrader = new Map()
  for (const r of rows) {
    if (!rowsByTrader.has(r.source_trader_id)) rowsByTrader.set(r.source_trader_id, [])
    rowsByTrader.get(r.source_trader_id).push(r)
  }

  let processed = 0
  for (const [traderId, traderRows] of rowsByTrader) {
    processed++

    // Get metrics for this trader
    let roi_7d_val = null
    let roi_30d_val = null

    if (weeklyResults.has(traderId)) {
      const m = weeklyResults.get(traderId)
      roi_7d_val = m.roi_7d ?? null
      roi_30d_val = m.roi_30d ?? null
    } else if (truncAddrTraders.has(traderId)) {
      roi_7d_val = smartmoney7dMap.has(traderId) ? smartmoney7dMap.get(traderId) : null
      roi_30d_val = smartmoney30dMap.has(traderId) ? smartmoney30dMap.get(traderId) : null
    }

    if (roi_7d_val == null && roi_30d_val == null) {
      skipped += traderRows.length
      continue
    }

    for (const row of traderRows) {
      const updates = {}
      if (row.roi_7d == null && roi_7d_val != null) updates.roi_7d = roi_7d_val
      if (row.roi_30d == null && roi_30d_val != null) updates.roi_30d = roi_30d_val

      if (!Object.keys(updates).length) continue

      if (DRY_RUN) {
        if (updated < 5) console.log(`  [DRY] id=${row.id} ${traderId}: `, updates)
        updated++
      } else {
        const ok = await applyUpdate(row.id, updates, false)
        if (ok) {
          updated++
          if (updated <= 3 || updated % 100 === 0)
            console.log(`  [${updated}] Updated id=${row.id} ${traderId} →`, updates)
        } else {
          failed++
          if (failed <= 3) console.log(`  ERROR updating id=${row.id}`)
        }
      }
    }

    if (processed % 100 === 0)
      process.stdout.write(`  [${processed}/${rowsByTrader.size}] updated=${updated} skipped=${skipped}\r`)
  }

  console.log(`\n  Source ${source}: updated=${updated} skipped=${skipped} failed=${failed}`)
  return { updated, skipped, failed }
}

async function main() {
  console.log('OKX ROI Enrichment — all OKX sources (roi_7d + roi_30d)')
  if (DRY_RUN) console.log('[DRY RUN]')
  if (SOURCE_FILTER) console.log(`[Source filter: ${SOURCE_FILTER}]`)

  const sources = SOURCE_FILTER ? [SOURCE_FILTER] : ['okx_futures', 'okx_web3']
  let totalUpdated = 0

  for (const source of sources) {
    const { updated } = await processSource(source)
    totalUpdated += updated
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`TOTAL UPDATED: ${totalUpdated}`)

  // Final DB check
  console.log('\nFinal DB check:')
  for (const source of sources) {
    const { count: null7d } = await supabase
      .from('trader_snapshots').select('*', { count: 'exact', head: true })
      .eq('source', source).is('roi_7d', null)
    const { count: null30d } = await supabase
      .from('trader_snapshots').select('*', { count: 'exact', head: true })
      .eq('source', source).is('roi_30d', null)
    console.log(`  ${source}: null_roi_7d=${null7d} null_roi_30d=${null30d}`)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
