#!/usr/bin/env node
/**
 * GMX Full Enrichment — AUM + max_drawdown + trades_count + win_rate
 * 
 * Fetches stats only for traders already in our DB (not all 243K accounts).
 * AUM: maxCapital from subsquid
 * max_drawdown: estimated from PnL and capital data
 * 
 * Usage: node scripts/import/enrich_gmx_full.mjs
 */

import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gmx'
const SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const VALUE_SCALE = 1e30

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`) }
function scaleDown(bigintStr) { return Number(BigInt(bigintStr || '0')) / VALUE_SCALE }

async function gqlFetch(query) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(SUBSQUID_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30000)
      })
      if (!res.ok) throw new Error(`GMX API ${res.status}`)
      return (await res.json()).data
    } catch (e) {
      if (attempt < 2) { await sleep(2000); continue }
      throw e
    }
  }
}

async function fetchStatsForAddresses(addresses) {
  // Fetch in batches of 50 using id_in filter
  const results = new Map()
  for (let i = 0; i < addresses.length; i += 50) {
    const batch = addresses.slice(i, i + 50)
    const idList = batch.map(a => `"${a}"`).join(',')
    const data = await gqlFetch(`{
      accountStats(where: { id_in: [${idList}] }, limit: 50) {
        id
        wins
        losses
        realizedPnl
        volume
        netCapital
        maxCapital
        closedCount
        realizedFees
        realizedPriceImpact
      }
    }`)
    for (const s of (data?.accountStats || [])) {
      results.set(s.id, s)
    }
    if (i + 50 < addresses.length) await sleep(300)
  }
  return results
}

async function main() {
  log('='.repeat(60))
  log('GMX Full Enrichment — AUM + max_drawdown')
  log('='.repeat(60))

  // Load all GMX snapshots
  const allSnapshots = []
  for (const season of ['7D', '30D', '90D']) {
    let page = 0, pageSize = 1000
    while (true) {
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('id, source_trader_id, season_id, roi, pnl, win_rate, max_drawdown, trades_count, aum')
        .eq('source', SOURCE)
        .eq('season_id', season)
        .range(page * pageSize, (page + 1) * pageSize - 1)
      if (error || !data?.length) break
      allSnapshots.push(...data)
      if (data.length < pageSize) break
      page++
    }
  }
  log(`Loaded ${allSnapshots.length} GMX snapshots`)

  // Get unique addresses
  const uniqueAddrs = [...new Set(allSnapshots.map(s => s.source_trader_id))]
  log(`Unique traders: ${uniqueAddrs.length}`)

  // Fetch stats from subgraph for only our traders
  log('Fetching stats from subsquid...')
  const statsMap = await fetchStatsForAddresses(uniqueAddrs)
  log(`Got stats for ${statsMap.size} traders`)

  // Count gaps before
  const gapsBefore = { aum: 0, mdd: 0, tc: 0, wr: 0 }
  for (const s of allSnapshots) {
    if (s.aum === null) gapsBefore.aum++
    if (s.max_drawdown === null) gapsBefore.mdd++
    if (s.trades_count === null || s.trades_count === 0) gapsBefore.tc++
    if (s.win_rate === null) gapsBefore.wr++
  }
  log(`Gaps before: aum=${gapsBefore.aum}, mdd=${gapsBefore.mdd}, tc=${gapsBefore.tc}, wr=${gapsBefore.wr}`)

  let filled = { aum: 0, mdd: 0, tc: 0, wr: 0, updated: 0 }

  // Batch updates
  const updates = []

  for (const snap of allSnapshots) {
    const stats = statsMap.get(snap.source_trader_id)
    if (!stats) continue

    const update = {}

    // AUM: maxCapital
    if (snap.aum === null) {
      const maxCap = scaleDown(stats.maxCapital)
      const netCap = scaleDown(stats.netCapital)
      const aum = maxCap > 0 ? maxCap : (netCap > 0 ? netCap : null)
      if (aum !== null && aum > 0) {
        update.aum = Math.round(aum * 100) / 100
        filled.aum++
      }
    }

    // max_drawdown estimate
    if (snap.max_drawdown === null) {
      const maxCap = scaleDown(stats.maxCapital)
      const realizedPnl = scaleDown(stats.realizedPnl)
      const wins = stats.wins || 0
      const losses = stats.losses || 0
      const total = wins + losses
      const volume = scaleDown(stats.volume)

      if (maxCap > 0 && total >= 3) {
        let mdd
        if (realizedPnl < 0) {
          mdd = Math.abs(realizedPnl) / maxCap * 100
        } else {
          // Estimate: use loss ratio and average trade impact
          const lossRate = losses / total
          const avgTradeSize = volume / total
          const estimatedAvgLoss = avgTradeSize * 0.015 // ~1.5% avg loss
          const estimatedMaxLoss = estimatedAvgLoss * Math.min(losses, 10) // consecutive losses
          mdd = Math.min(estimatedMaxLoss / maxCap * 100, 80)
        }
        mdd = Math.max(1, Math.min(Math.round(mdd * 100) / 100, 95))
        update.max_drawdown = mdd
        filled.mdd++
      }
    }

    // trades_count
    if (snap.trades_count === null || snap.trades_count === 0) {
      const total = (stats.wins || 0) + (stats.losses || 0)
      const closedCount = stats.closedCount || total
      if (closedCount > 0) {
        update.trades_count = closedCount
        filled.tc++
      }
    }

    // win_rate
    if (snap.win_rate === null) {
      const wins = stats.wins || 0
      const losses = stats.losses || 0
      const total = wins + losses
      if (total >= 3) {
        update.win_rate = Math.round((wins / total) * 10000) / 100
        filled.wr++
      }
    }

    if (Object.keys(update).length > 0) {
      const newWr = update.win_rate ?? snap.win_rate
      const newMdd = update.max_drawdown ?? snap.max_drawdown
      const { totalScore } = calculateArenaScore(snap.roi || 0, snap.pnl, newMdd, newWr, snap.season_id)
      update.arena_score = totalScore
      updates.push({ id: snap.id, update })
    }
  }

  log(`Prepared ${updates.length} updates`)

  // Execute updates in batches
  for (let i = 0; i < updates.length; i++) {
    const { id, update } = updates[i]
    const { error } = await supabase.from('trader_snapshots').update(update).eq('id', id)
    if (error) log(`  DB error ${id}: ${error.message}`)
    else filled.updated++

    if ((i + 1) % 200 === 0 || i === updates.length - 1) {
      log(`  DB updates: ${i + 1}/${updates.length}`)
    }
  }

  log('\n' + '='.repeat(60))
  log('✅ GMX enrichment complete')
  log(`  Updated: ${filled.updated}`)
  log(`  AUM filled: ${filled.aum}`)
  log(`  max_drawdown filled: ${filled.mdd}`)
  log(`  trades_count filled: ${filled.tc}`)
  log(`  win_rate filled: ${filled.wr}`)
  log('='.repeat(60))
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1) })
