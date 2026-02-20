#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks for okx_web3
 * Fetches from OKX Web3 ranking API
 * Fields: win_rate, max_drawdown, trades_count
 *
 * Key insight: All source_trader_id values are truncated Solana addresses (chainId=501).
 * DB has traders at ranks up to ~7000, so we fetch up to rank 8000.
 *
 * Strategy:
 * 1. Get all null WR + null MDD rows from DB
 * 2. Fetch ALL available traders from OKX API:
 *    - chainId=501 only (all targets are Solana addresses)
 *    - rankBy=1,2,3 (PnL, WinRate, ROI sorting — reveals different traders)
 *    - Up to rank 8000 per combination
 * 3. computeMDD returns 0.0 for no-drawdown traders (not null)
 * 4. Match and update DB
 */

import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'okx_web3'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'
const PERIOD_MAP = { '7D': '1', '30D': '2', '90D': '3' }
// Only Solana — all source_trader_id values are truncated Solana (base58) addresses
const CHAINS = [501]
const RANK_BY = [1, 2, 3]   // 1=PnL, 2=WinRate, 3=ROI
const MAX_RANK = 8000        // DB has traders up to rank ~7000, fetch up to 8000

function truncateAddress(addr) {
  if (!addr || addr.length < 11) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

/**
 * Compute max drawdown from pnlHistory.
 * Returns 0.0 when trader has no drawdown (flat or perfect upward PnL).
 * Returns null only when pnlHistory is missing/insufficient or all values ≤ 0.
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

  if (!hasPositivePeak) return null  // All-negative PnL, can't compute MDD from peak
  maxDD = Math.min(Math.max(maxDD, 0), 100)
  return parseFloat(maxDD.toFixed(2))
}

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

async function fetchAllTradersForConfig(periodType, chainId, rankBy, targetIds) {
  const all = new Map()
  let emptyCount = 0
  let targetHits = 0

  for (let start = 0; start < MAX_RANK; start += 20) {
    const url = `${BASE}?rankStart=${start}&periodType=${periodType}&rankBy=${rankBy}&label=all&desc=true&rankEnd=${start + 20}&chainId=${chainId}`
    const json = await fetchJSON(url)
    const infos = json?.data?.rankingInfos || []

    if (infos.length === 0) {
      emptyCount++
      if (emptyCount >= 3) break
      await sleep(300)
      continue
    }
    emptyCount = 0

    for (const t of infos) {
      const addr = t.walletAddress
      if (!addr) continue
      const trunc = truncateAddress(addr)
      if (!all.has(trunc)) {
        const entry = {
          winRate: t.winRate != null ? parseFloat(t.winRate) : null,
          mdd: computeMDD(t.pnlHistory),
          tx: t.tx != null ? parseInt(t.tx) : null,
        }
        all.set(trunc, entry)
        if (targetIds.has(trunc)) targetHits++
      }
    }

    if (start % 500 === 0 && start > 0) {
      process.stdout.write(`\r    ... rank ${start}, ${all.size} traders, ${targetHits} target hits`)
    }
    await sleep(150)
  }
  if (all.size > 0) process.stdout.write('\n')
  return { all, targetHits }
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`OKX Web3 — Enrich leaderboard_ranks (WR + MDD) v3`)
  console.log(`${'='.repeat(60)}`)

  // Step 1: Get all rows needing enrichment
  console.log('\n[1] Fetching rows needing enrichment...')
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
  console.log(`  Total rows: ${allRows.length}`)

  if (!allRows.length) {
    console.log('  Nothing to do!')
    return
  }

  const bySeason = {}
  for (const row of allRows) {
    if (!bySeason[row.season_id]) bySeason[row.season_id] = []
    bySeason[row.season_id].push(row)
  }
  console.log('  By season:', Object.entries(bySeason).map(([k, v]) => `${k}:${v.length}`).join(', '))

  const nullIds = new Set(allRows.map(r => r.source_trader_id))
  console.log(`  Unique addresses: ${nullIds.size}`)

  // Step 2: Fetch from OKX API — Solana only, multiple rankBy, up to rank 8000
  console.log(`\n[2] Fetching from OKX API (chainId=501, rankBy=[1,2,3], maxRank=${MAX_RANK})...`)
  const bigMap = new Map()  // key: `trunc|period` or `trunc`
  let totalTargetHits = 0

  for (const [period, periodType] of Object.entries(PERIOD_MAP)) {
    if (!bySeason[period]) {
      console.log(`  ${period}: no null rows, skipping`)
      continue
    }
    console.log(`\n  Period ${period} (type=${periodType}) — ${bySeason[period].length} rows`)

    const periodMap = new Map()

    for (const chainId of CHAINS) {
      for (const rankBy of RANK_BY) {
        process.stdout.write(`    Chain ${chainId} rankBy=${rankBy}: fetching...`)
        const { all: traders, targetHits } = await fetchAllTradersForConfig(periodType, chainId, rankBy, nullIds)
        if (traders.size === 0) {
          console.log(` no data`)
          continue
        }
        console.log(` ${traders.size} traders, ${targetHits} targets found`)

        for (const [trunc, data] of traders) {
          if (!periodMap.has(trunc)) {
            periodMap.set(trunc, data)
          } else {
            // Merge: prefer non-null mdd over null
            const existing = periodMap.get(trunc)
            if (existing.mdd == null && data.mdd != null) {
              periodMap.set(trunc, { ...existing, mdd: data.mdd })
            }
          }
        }
        await sleep(300)
      }
    }

    // Merge periodMap into bigMap
    let hits = 0
    for (const [trunc, data] of periodMap) {
      const key = `${trunc}|${period}`
      if (!bigMap.has(key)) bigMap.set(key, data)
      if (!bigMap.has(trunc)) bigMap.set(trunc, data)
      if (nullIds.has(trunc)) hits++
    }
    console.log(`  -> ${hits} unique target addresses in ${period} map`)
    totalTargetHits += hits
    await sleep(500)
  }
  console.log(`\n  API map size: ${bigMap.size}, total target hits: ${totalTargetHits}`)

  // Step 3: Match and update
  console.log('\n[3] Matching and updating...')
  let updated = 0, notFound = 0, noUpdates = 0

  for (const row of allRows) {
    const key1 = `${row.source_trader_id}|${row.season_id}`
    const key2 = row.source_trader_id
    const data = bigMap.get(key1) || bigMap.get(key2)

    if (!data) { notFound++; continue }

    const updates = {}
    if (row.win_rate == null && data.winRate != null && !isNaN(data.winRate)) {
      updates.win_rate = data.winRate
    }
    if (row.max_drawdown == null && data.mdd != null) {
      updates.max_drawdown = data.mdd
    }
    if (row.trades_count == null && data.tx != null) {
      updates.trades_count = data.tx
    }

    if (Object.keys(updates).length === 0) { noUpdates++; continue }

    const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) {
      updated++
      if (updated <= 10 || updated % 200 === 0) {
        console.log(`  [${updated}] id=${row.id} ${row.source_trader_id} ${row.season_id} wr=${updates.win_rate ?? '-'} mdd=${updates.max_drawdown ?? '-'}`)
      }
    } else {
      console.error(`  ERROR id=${row.id}:`, error.message)
    }
  }

  // Step 4: Summary
  console.log(`\n${'='.repeat(60)}`)
  console.log(`RESULTS:`)
  console.log(`  Rows processed:  ${allRows.length}`)
  console.log(`  Updated:         ${updated}`)
  console.log(`  Not in API:      ${notFound}`)
  console.log(`  No new data:     ${noUpdates}`)

  const [
    { count: wrNull },
    { count: mddNull },
  ] = await Promise.all([
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null),
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null),
  ])
  console.log(`\n  Remaining null WR:  ${wrNull}`)
  console.log(`  Remaining null MDD: ${mddNull}`)

  if (notFound > 0) {
    console.log(`\n[!] ${notFound} traders not found in API (ranks > ${MAX_RANK} or dropped off leaderboard)`)
  }
  console.log('='.repeat(60))
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
