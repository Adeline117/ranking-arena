#!/usr/bin/env node
/**
 * OKX Web3 Enrichment v5 - Full exhaustive scan with pageIndex pagination
 *
 * Strategy:
 * 1. Load all okx_web3 rows with null win_rate OR max_drawdown
 * 2. Build Set of truncated addresses that need data
 * 3. Paginate ALL periods (1=7D, 2=30D, 3=90D, 4=180D, 5=ALL) exhaustively
 *    using rankStart/rankEnd approach (pageIndex doesn't work on this API)
 * 4. For each match: extract winRate, compute MDD from pnlHistory
 * 5. Update DB rows
 *
 * MDD = max drawdown % from pnlHistory cumulative P&L values
 */

import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'okx_web3'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'
const PAGE_SIZE = 20
const EMPTY_PAGE_LIMIT = 5   // stop period scan after N consecutive pages with no matches
const DRY_RUN = process.argv.includes('--dry-run')

// Period → season mapping (for win_rate - must match correct period)
const PT_TO_SEASON = { 1: '7D', 2: '30D', 3: '90D' }

async function fetchJSON(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20000),
      })
      if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch {
      if (attempt < 2) await sleep(1000 * (attempt + 1))
    }
  }
  return null
}

function truncateAddress(addr) {
  if (!addr || addr.length < 11) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

/**
 * Compute MDD from pnlHistory.
 * pnlHistory: array of {pnl: "123.45", time: ...} (cumulative P&L in USD)
 *
 * Returns:
 *   - positive float = max drawdown % from a profitable peak
 *   - 0.0 = no drawdown found (never reached positive territory, or never dropped)
 *   - null = insufficient data
 */
function computeMDD(pnlHistory) {
  if (!pnlHistory?.length || pnlHistory.length < 2) return null
  const values = pnlHistory.map(h => parseFloat(h.pnl)).filter(v => !isNaN(v))
  if (values.length < 2) return null

  let peak = values[0]
  let maxDD = 0
  let hasPositivePeak = false

  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) {
      hasPositivePeak = true
      const dd = ((peak - v) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }

  if (!hasPositivePeak) return 0.0
  return parseFloat(Math.min(Math.max(maxDD, 0), 100).toFixed(2))
}

/**
 * Fetch all traders for a given periodType, scanning until totalCount is reached.
 * Returns Map: truncatedAddr -> { winRate, mdd, tx, walletAddress, periodType }
 * Only keeps entries for addresses in `targetSet` (early stop optimization).
 */
async function fetchPeriodFull(periodType, targetSet, label = '') {
  const found = new Map()
  let consecutiveEmpty = 0
  let totalScanned = 0

  // First get totalCount
  const firstPage = await fetchJSON(`${BASE}?rankStart=0&rankEnd=${PAGE_SIZE}&periodType=${periodType}`)
  const totalCount = firstPage?.data?.totalCount || 0
  console.log(`  [pt${periodType}${label}] totalCount=${totalCount}`)

  // Process first page
  const firstInfos = firstPage?.data?.rankingInfos || []
  for (const t of firstInfos) {
    if (!t.walletAddress) continue
    const trunc = truncateAddress(t.walletAddress)
    if (targetSet.has(trunc) && !found.has(trunc)) {
      found.set(trunc, {
        winRate: t.winRate != null ? parseFloat(t.winRate) : null,
        mdd: computeMDD(t.pnlHistory),
        tx: t.tx != null ? parseInt(t.tx) : null,
        walletAddress: t.walletAddress,
        periodType,
      })
    }
  }
  totalScanned += firstInfos.length

  // Paginate the rest
  for (let start = PAGE_SIZE; start < totalCount; start += PAGE_SIZE) {
    const url = `${BASE}?rankStart=${start}&rankEnd=${start + PAGE_SIZE}&periodType=${periodType}`
    const json = await fetchJSON(url)
    const infos = json?.data?.rankingInfos || []

    if (infos.length === 0) {
      consecutiveEmpty++
      if (consecutiveEmpty >= EMPTY_PAGE_LIMIT) {
        console.log(`  [pt${periodType}] stopping - ${EMPTY_PAGE_LIMIT} consecutive empty pages at rank ${start}`)
        break
      }
      await sleep(300)
      continue
    }
    consecutiveEmpty = 0
    totalScanned += infos.length

    let pageMatches = 0
    for (const t of infos) {
      if (!t.walletAddress) continue
      const trunc = truncateAddress(t.walletAddress)
      if (targetSet.has(trunc) && !found.has(trunc)) {
        found.set(trunc, {
          winRate: t.winRate != null ? parseFloat(t.winRate) : null,
          mdd: computeMDD(t.pnlHistory),
          tx: t.tx != null ? parseInt(t.tx) : null,
          walletAddress: t.walletAddress,
          periodType,
        })
        pageMatches++
      }
    }

    if (start % 1000 === 0) {
      process.stdout.write(`\r    pt${periodType}: rank ${start}/${totalCount}, found ${found.size} matches`)
    }
    await sleep(80)
  }

  if (totalScanned > PAGE_SIZE) process.stdout.write('\n')
  console.log(`  [pt${periodType}${label}] scanned ${totalScanned}, matches: ${found.size}`)
  return found
}

async function main() {
  console.log(`\n${'='.repeat(65)}`)
  console.log(`OKX Web3 Enrichment v5 — Full Exhaustive Scan`)
  if (DRY_RUN) console.log(`  MODE: DRY RUN (no DB writes)`)
  console.log(`${'='.repeat(65)}`)

  // ── Step 1: Load null rows from DB ────────────────────────────────
  console.log('\n[1] Loading null rows from DB...')
  let allRows = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', SOURCE)
      .or('win_rate.is.null,max_drawdown.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`  Total null rows: ${allRows.length}`)
  const bySeason = {}
  for (const r of allRows) bySeason[r.season_id] = (bySeason[r.season_id] || 0) + 1
  console.log('  By season:', JSON.stringify(bySeason))

  const wrNullIds = new Set(allRows.filter(r => r.win_rate == null).map(r => r.source_trader_id))
  const mddNullIds = new Set(allRows.filter(r => r.max_drawdown == null).map(r => r.source_trader_id))
  const allNullIds = new Set([...wrNullIds, ...mddNullIds])
  console.log(`  Unique WR-null addresses: ${wrNullIds.size}`)
  console.log(`  Unique MDD-null addresses: ${mddNullIds.size}`)
  console.log(`  Total unique addresses to find: ${allNullIds.size}`)

  if (allNullIds.size === 0) {
    console.log('\n  Nothing to do — no null rows found!')
    return
  }

  // ── Step 2: Scan all periods ──────────────────────────────────────
  console.log('\n[2] Scanning OKX Web3 API across all periods...')

  // Collect per-period maps (pt1/2/3 needed for correct-period WR)
  const ptMaps = {}
  // pt1=7D, pt2=30D, pt3=90D for WR; pt4=180D, pt5=ALL for broader MDD coverage
  for (const pt of [1, 2, 3, 4, 5]) {
    ptMaps[pt] = await fetchPeriodFull(pt, allNullIds)
    await sleep(500)
  }

  // Build combined map: any period can provide MDD (pnlHistory is same 30h window)
  const anyPtMap = new Map()
  for (const pt of [1, 2, 3, 4, 5]) {
    for (const [addr, data] of ptMaps[pt]) {
      if (!anyPtMap.has(addr)) anyPtMap.set(addr, data)
    }
  }
  console.log(`\n  Combined unique matches: ${anyPtMap.size} of ${allNullIds.size}`)

  // ── Step 3: Build updates ─────────────────────────────────────────
  console.log('\n[3] Building updates...')
  const updates = {}  // row.id -> { win_rate?, max_drawdown?, trades_count?, _meta }

  for (const row of allRows) {
    const update = {}
    const meta = {}
    const correctPt = Object.entries(PT_TO_SEASON).find(([, s]) => s === row.season_id)?.[0]
    const ptNum = correctPt ? parseInt(correctPt) : null

    // Win rate: prefer correct period, fallback to any period
    if (row.win_rate == null) {
      let wrSource = null
      // Try correct period first
      if (ptNum && ptMaps[ptNum]?.has(row.source_trader_id)) {
        const d = ptMaps[ptNum].get(row.source_trader_id)
        if (d.winRate != null && !isNaN(d.winRate)) {
          update.win_rate = d.winRate
          wrSource = `pt${ptNum}`
        }
      }
      // Fallback: any period
      if (update.win_rate == null) {
        const d = anyPtMap.get(row.source_trader_id)
        if (d?.winRate != null && !isNaN(d.winRate)) {
          update.win_rate = d.winRate
          wrSource = `pt${d.periodType}_fallback`
        }
      }
      if (wrSource) meta.wrSource = wrSource
    }

    // MDD: use any period (pnlHistory = same 30h data regardless of period)
    if (row.max_drawdown == null) {
      const d = anyPtMap.get(row.source_trader_id)
      if (d?.mdd != null) {
        update.max_drawdown = d.mdd
        meta.mddSource = `pt${d.periodType}`
      }
    }

    // trades_count: use correct period if missing
    if (row.trades_count == null && ptNum && ptMaps[ptNum]?.has(row.source_trader_id)) {
      const d = ptMaps[ptNum].get(row.source_trader_id)
      if (d?.tx != null) update.trades_count = d.tx
    }

    if (Object.keys(update).length > 0) {
      updates[row.id] = { ...update, _meta: meta }
    }
  }

  const updateCount = Object.keys(updates).length
  const wrUpdateCount = Object.values(updates).filter(u => u.win_rate != null).length
  const mddUpdateCount = Object.values(updates).filter(u => u.max_drawdown != null).length
  console.log(`  Rows to update: ${updateCount}`)
  console.log(`  Will fill win_rate: ${wrUpdateCount}`)
  console.log(`  Will fill max_drawdown: ${mddUpdateCount}`)

  // Show sample
  let shown = 0
  for (const [id, u] of Object.entries(updates)) {
    if (shown++ >= 10) break
    const { _meta, ...fields } = u
    console.log(`  id=${id} [${_meta?.wrSource || ''}|${_meta?.mddSource || ''}] wr=${fields.win_rate ?? '-'} mdd=${fields.max_drawdown ?? '-'} tc=${fields.trades_count ?? '-'}`)
  }

  if (updateCount === 0) {
    console.log('\n  No updates to apply.')
  }

  if (DRY_RUN || updateCount === 0) {
    // Still show final DB counts
    const [{ count: wrNull }, { count: mddNull }] = await Promise.all([
      supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null),
      supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null),
    ])
    console.log(`\n  DB counts (unchanged): WR null=${wrNull}, MDD null=${mddNull}`)
    if (DRY_RUN) console.log('  [DRY RUN] No writes made.')
    return
  }

  // ── Step 4: Apply updates ─────────────────────────────────────────
  console.log('\n[4] Applying updates...')
  let succeeded = 0, failed = 0
  let wrFilled = 0, mddFilled = 0

  for (const [rowId, update] of Object.entries(updates)) {
    const { _meta, ...fields } = update

    const { error } = await supabase
      .from('leaderboard_ranks')
      .update(fields)
      .eq('id', parseInt(rowId))

    if (!error) {
      succeeded++
      if (fields.win_rate != null) wrFilled++
      if (fields.max_drawdown != null) mddFilled++
      if (succeeded <= 5 || succeeded % 50 === 0) {
        console.log(`  [${succeeded}] id=${rowId} wr=${fields.win_rate ?? '-'} mdd=${fields.max_drawdown ?? '-'}`)
      }
    } else {
      failed++
      console.error(`  ERROR id=${rowId}: ${error.message}`)
    }

    if (succeeded % 100 === 0) await sleep(100)
  }

  // ── Step 5: Final verification ────────────────────────────────────
  const [{ count: wrNullFinal }, { count: mddNullFinal }] = await Promise.all([
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null),
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null),
  ])

  console.log(`\n${'='.repeat(65)}`)
  console.log('RESULTS:')
  console.log(`  Updates applied:        ${succeeded}`)
  console.log(`  Failed:                 ${failed}`)
  console.log(`  win_rate filled:        ${wrFilled}`)
  console.log(`  max_drawdown filled:    ${mddFilled}`)
  console.log(`\n  Remaining WR null:      ${wrNullFinal}`)
  console.log(`  Remaining MDD null:     ${mddNullFinal}`)

  if (wrNullFinal > 0) {
    console.log(`\n  ⚠️  ${wrNullFinal} WR-null rows remain.`)
    console.log(`     These traders are not currently ranked on any OKX period leaderboard.`)
    console.log(`     They were likely removed from leaderboards before this script ran.`)
  }
  if (mddNullFinal > 0) {
    console.log(`\n  ⚠️  ${mddNullFinal} MDD-null rows remain.`)
    console.log(`     These traders had no pnlHistory available in any scanned period.`)
  }
  console.log('='.repeat(65))
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
