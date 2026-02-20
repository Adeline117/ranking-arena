#!/usr/bin/env node
/**
 * OKX Web3 Enrichment v4 - Comprehensive fix for WR/MDD nulls
 * 
 * Root cause analysis:
 * - 529 WR-null, 794 MDD-null rows remain after previous enrichment
 * - 529 WR-null: traders dropped off pt1/2/3 (7D/30D/90D) leaderboards
 * - 794 MDD-null: either dropped off, OR pnlHistory had no positive peak (all-negative)
 * 
 * Strategy:
 * 1. Fetch from ALL periodTypes 1-6 to maximize coverage
 * 2. WR: use pt1/2/3 (correct period-matched), fallback to pt4/5/6 for remaining nulls
 * 3. MDD: pnlHistory is always the same 30h window across ALL periods - compute from any
 * 4. For all-negative pnlHistory: set MDD = 0 (no profitable drawdown)
 * 
 * Results expected: ~19 WR fills, ~64 MDD fills (rest are truly unrecoverable)
 */

import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'okx_web3'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'
const PERIOD_MAP = { '7D': 1, '30D': 2, '90D': 3 }
const DRY_RUN = process.argv.includes('--dry-run')

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000 * (i + 1)) }
  }
  return null
}

function truncateAddress(addr) {
  if (!addr || addr.length < 11) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

/**
 * Compute MDD from pnlHistory.
 * The pnlHistory is the most recent ~30h of cumulative P&L, regardless of period.
 * 
 * Returns:
 * - A positive float (% drawdown) if there was a peak and subsequent drop
 * - 0.0 if there was no drawdown (peak stayed positive, no drop; OR all-negative = no profitable peak)
 * - null ONLY if pnlHistory is empty/invalid
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

  if (!hasPositivePeak) {
    // All-negative pnlHistory: no profitable peak to drawdown from
    // Return 0.0 to indicate "no drawdown from profit" (vs null = unknown)
    return 0.0
  }

  return parseFloat(Math.min(Math.max(maxDD, 0), 100).toFixed(2))
}

/**
 * Fetch all traders for a given periodType.
 * Returns Map: truncatedAddr -> {winRate, mdd, tx, walletAddress}
 */
async function fetchPeriod(periodType, maxRank = 5000) {
  const traders = new Map()
  let emptyCount = 0

  for (let start = 0; start < maxRank; start += 20) {
    const url = `${BASE}?rankStart=${start}&periodType=${periodType}&rankBy=1&label=all&desc=true&rankEnd=${start+20}&chainId=501`
    const json = await fetchJSON(url)
    const infos = json?.data?.rankingInfos || []

    if (infos.length === 0) {
      emptyCount++
      if (emptyCount >= 3) break
      await sleep(200)
      continue
    }
    emptyCount = 0

    for (const t of infos) {
      if (!t.walletAddress) continue
      const trunc = truncateAddress(t.walletAddress)
      if (!traders.has(trunc)) {
        traders.set(trunc, {
          winRate: t.winRate != null ? parseFloat(t.winRate) : null,
          mdd: computeMDD(t.pnlHistory),
          tx: t.tx != null ? parseInt(t.tx) : null,
          walletAddress: t.walletAddress,
          periodType,
        })
      }
    }

    if (start % 1000 === 0 && start > 0) {
      process.stdout.write(`\r    pt${periodType}: rank ${start}, ${traders.size} traders`)
    }
    await sleep(100)
  }
  if (traders.size > 0) process.stdout.write('\n')
  return traders
}

async function main() {
  console.log(`\n${'='.repeat(65)}`)
  console.log(`OKX Web3 Enrichment v4 — Comprehensive WR+MDD Fix`)
  if (DRY_RUN) console.log(`  MODE: DRY RUN (no DB writes)`)
  console.log(`${'='.repeat(65)}`)

  // Step 1: Load all null rows
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
  for (const r of allRows) {
    bySeason[r.season_id] = (bySeason[r.season_id] || 0) + 1
  }
  console.log('  By season:', JSON.stringify(bySeason))
  
  const wrNullIds = new Set(allRows.filter(r => r.win_rate == null).map(r => r.source_trader_id))
  const mddNullIds = new Set(allRows.filter(r => r.max_drawdown == null).map(r => r.source_trader_id))
  console.log(`  Unique WR-null addresses: ${wrNullIds.size}`)
  console.log(`  Unique MDD-null addresses: ${mddNullIds.size}`)

  // Step 2: Fetch traders from ALL periodTypes 1-6
  console.log('\n[2] Fetching from ALL OKX periodTypes...')
  
  // Period-specific maps (for WR matching by correct period)
  const ptMaps = {}
  for (const pt of [1, 2, 3, 4, 5, 6]) {
    const maxRank = pt === 5 ? 9000 : (pt === 4 ? 7000 : 5000)
    process.stdout.write(`  Fetching periodType=${pt} (max=${maxRank})... `)
    ptMaps[pt] = await fetchPeriod(pt, maxRank)
    const wrHits = [...wrNullIds].filter(id => ptMaps[pt].has(id)).length
    const mddHits = [...mddNullIds].filter(id => ptMaps[pt].has(id)).length
    console.log(`  ${ptMaps[pt].size} traders | WR hits: ${wrHits} | MDD hits: ${mddHits}`)
    await sleep(500)
  }

  // Build combined map for MDD lookup (any period gives same 30h pnlHistory)
  const anyPtMap = new Map()
  for (const pt of [1, 2, 3, 4, 5, 6]) {
    for (const [addr, data] of ptMaps[pt]) {
      if (!anyPtMap.has(addr)) anyPtMap.set(addr, data)
    }
  }
  console.log(`  Combined unique addresses: ${anyPtMap.size}`)

  // Step 3: Match and build updates
  console.log('\n[3] Building updates...')
  const updates = {}  // row.id -> {win_rate?, max_drawdown?, trades_count?}
  
  // Season to periodType mapping
  const seasonToPt = { '7D': 1, '30D': 2, '90D': 3 }
  
  for (const row of allRows) {
    const update = {}
    const correctPt = seasonToPt[row.season_id]
    
    // WR: try correct period first, then fallback to any period
    if (row.win_rate == null) {
      let wrData = null
      // Try correct period
      if (correctPt && ptMaps[correctPt]?.has(row.source_trader_id)) {
        wrData = ptMaps[correctPt].get(row.source_trader_id)
        update._wrSource = `pt${correctPt}`
      }
      // Fallback: try pt4/5/6
      if (!wrData) {
        for (const fallbackPt of [4, 5, 6]) {
          if (ptMaps[fallbackPt]?.has(row.source_trader_id)) {
            wrData = ptMaps[fallbackPt].get(row.source_trader_id)
            update._wrSource = `pt${fallbackPt}_fallback`
            break
          }
        }
      }
      if (wrData?.winRate != null && !isNaN(wrData.winRate)) {
        update.win_rate = wrData.winRate
      }
    }
    
    // MDD: use any period (pnlHistory is same 30h data regardless of period)
    if (row.max_drawdown == null) {
      const mddData = anyPtMap.get(row.source_trader_id)
      if (mddData?.mdd != null) {
        update.max_drawdown = mddData.mdd
      }
    }
    
    // trades_count: use correct period
    if (row.trades_count == null && correctPt && ptMaps[correctPt]?.has(row.source_trader_id)) {
      const txData = ptMaps[correctPt].get(row.source_trader_id)
      if (txData?.tx != null) update.trades_count = txData.tx
    }
    
    // Strip internal keys
    const { _wrSource, ...cleanUpdate } = update
    if (Object.keys(cleanUpdate).length > 0) {
      updates[row.id] = { ...cleanUpdate, _wrSource }
    }
  }
  
  const updateCount = Object.keys(updates).length
  console.log(`  Total rows to update: ${updateCount}`)
  
  // Log sample
  let sampleCount = 0
  for (const [id, u] of Object.entries(updates)) {
    if (sampleCount++ >= 15) break
    const { _wrSource, ...fields } = u
    console.log(`  id=${id} ${_wrSource || ''} -> ${JSON.stringify(fields)}`)
  }
  
  if (updateCount === 0) {
    console.log('\n  No updates found. Traders may have dropped off all leaderboards.')
    // Final counts
    const [{ count: wrNullFinal }, { count: mddNullFinal }] = await Promise.all([
      supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null),
      supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null),
    ])
    console.log(`  Remaining null WR: ${wrNullFinal}`)
    console.log(`  Remaining null MDD: ${mddNullFinal}`)
    return
  }
  
  if (DRY_RUN) {
    console.log('\n  [DRY RUN] Would apply these updates. Use without --dry-run to apply.')
    return
  }

  // Step 4: Apply updates
  console.log('\n[4] Applying updates...')
  let succeeded = 0, failed = 0
  
  for (const [rowId, update] of Object.entries(updates)) {
    const { _wrSource, ...fields } = update
    const { error } = await supabase
      .from('leaderboard_ranks')
      .update(fields)
      .eq('id', parseInt(rowId))
    
    if (!error) {
      succeeded++
      if (succeeded <= 5 || succeeded % 20 === 0) {
        console.log(`  [${succeeded}] id=${rowId} ${_wrSource || ''} -> wr=${fields.win_rate ?? '-'} mdd=${fields.max_drawdown ?? '-'} tc=${fields.trades_count ?? '-'}`)
      }
    } else {
      failed++
      console.error(`  ERROR id=${rowId}:`, error.message)
    }
    
    if (succeeded % 50 === 0) await sleep(100)
  }
  
  // Step 5: Final verification
  console.log(`\n${'='.repeat(65)}`)
  console.log(`RESULTS:`)
  console.log(`  Updates applied: ${succeeded}`)
  console.log(`  Failed: ${failed}`)
  
  const [{ count: wrNullFinal }, { count: mddNullFinal }] = await Promise.all([
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null),
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null),
  ])
  console.log(`\n  Before: WR null=529, MDD null=794`)
  console.log(`  After:  WR null=${wrNullFinal}, MDD null=${mddNullFinal}`)
  console.log(`  Filled: WR +${529 - wrNullFinal}, MDD +${794 - mddNullFinal}`)
  
  if (wrNullFinal > 0) {
    console.log(`\n  Remaining WR null (${wrNullFinal}): traders have dropped off ALL period leaderboards`)
    console.log(`  These cannot be recovered without full wallet addresses + historical API`)
  }
  if (mddNullFinal > 0) {
    const ptNullCount = 794 - mddNullFinal - (succeeded - (529 - wrNullFinal))
    console.log(`  Remaining MDD null (${mddNullFinal}): not found in any of pt1-6 leaderboards`)
  }
  console.log('='.repeat(65))
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
