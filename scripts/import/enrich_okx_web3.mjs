#!/usr/bin/env node
/**
 * OKX Web3 Enrichment — fill win_rate and max_drawdown for existing traders
 *
 * Strategy:
 *   1. Fetch full ranking from OKX Web3 smartmoney API (paginated, 20/page)
 *   2. Match wallet addresses to existing truncated IDs in DB
 *   3. UPDATE nulls only (win_rate, max_drawdown)
 *   4. Compute max_drawdown from pnlHistory when available
 *
 * API: /priapi/v1/dx/market/v2/smartmoney/ranking/content
 *   periodType: 1=7D, 2=30D, 3=90D
 *   rankBy: 1=PnL, 2=ROI, 3=winRate
 *   chainId: 501=Solana (main chain for OKX Web3 copy-trade)
 *
 * Usage: node scripts/import/enrich_okx_web3.mjs
 */

import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'okx_web3'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'

const PERIOD_MAP = { '7D': '1', '30D': '2', '90D': '3' }
const CHAINS = [501] // Solana; add more if needed: 1=ETH, 56=BSC, 8453=Base

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

/**
 * Compute MDD from pnlHistory array [{pnl, time}, ...]
 */
function computeMDD(pnlHistory) {
  if (!pnlHistory?.length || pnlHistory.length < 2) return null
  const values = pnlHistory.map(h => parseFloat(h.pnl)).filter(v => !isNaN(v))
  if (values.length < 2) return null

  // MDD as percentage from peak
  let peak = values[0]
  let maxDD = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }
  return maxDD > 0 && maxDD <= 100 ? maxDD : null
}

/**
 * Truncate address to match DB format: first6...last4
 */
function truncateAddress(addr) {
  if (!addr || addr.length < 11) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

/**
 * Fetch all traders from the ranking API for a given period and chain
 */
async function fetchAllTraders(periodType, chainId) {
  const all = new Map()
  
  // Use multiple rankBy orders to discover more unique traders
  for (const rankBy of [1, 2, 3]) { // PnL, ROI, winRate
    for (const desc of ['true', 'false']) {
      let noNew = 0
      for (let start = 0; start < 2000; start += 20) {
        const url = `${BASE}?rankStart=${start}&periodType=${periodType}&rankBy=${rankBy}&label=all&desc=${desc}&rankEnd=${start + 20}&chainId=${chainId}`
        const json = await fetchJSON(url)
        const infos = json?.data?.rankingInfos || []
        if (infos.length === 0) break

        let newCount = 0
        for (const t of infos) {
          const addr = t.walletAddress
          if (!addr || all.has(addr)) continue
          all.set(addr, {
            walletAddress: addr,
            truncated: truncateAddress(addr),
            name: t.walletName || t.addressAlias || '',
            winRate: parseFloat(t.winRate) || null,
            roi: parseFloat(t.roi) || null,
            pnl: parseFloat(t.pnl) || null,
            mdd: computeMDD(t.pnlHistory),
          })
          newCount++
        }

        if (newCount === 0) { noNew++; if (noNew >= 3) break } else noNew = 0
        await sleep(300)
      }
    }
  }

  return [...all.values()]
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`OKX Web3 Enrichment — Fill win_rate & max_drawdown`)
  console.log(`${'='.repeat(60)}`)

  // Get all existing okx_web3 trader IDs from snapshots
  const { data: existing } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', SOURCE)

  if (!existing?.length) {
    console.log('No existing okx_web3 traders found')
    return
  }

  // Build lookup: truncated -> [{source_trader_id, season_id, ...}]
  const byTruncated = new Map()
  const byFullId = new Map()
  for (const row of existing) {
    const key = row.source_trader_id
    if (key.includes('...')) {
      const arr = byTruncated.get(key) || []
      arr.push(row)
      byTruncated.set(key, arr)
    } else {
      const arr = byFullId.get(key) || []
      arr.push(row)
      byFullId.set(key, arr)
    }
  }

  console.log(`DB: ${existing.length} snapshots, ${byTruncated.size} truncated IDs, ${byFullId.size} full IDs`)
  console.log(`Missing win_rate: ${existing.filter(r => r.win_rate == null).length}`)
  console.log(`Missing max_drawdown: ${existing.filter(r => r.max_drawdown == null).length}`)

  // Fetch from API for each period
  let totalUpdated = 0
  
  for (const [period, periodType] of Object.entries(PERIOD_MAP)) {
    console.log(`\n--- Fetching ${period} (periodType=${periodType}) ---`)
    
    for (const chainId of CHAINS) {
      const traders = await fetchAllTraders(periodType, chainId)
      console.log(`  Chain ${chainId}: fetched ${traders.length} traders`)

      let matched = 0, updated = 0

      for (const t of traders) {
        // Try to match by truncated address
        const rows = byTruncated.get(t.truncated) || []
        // Also try matching by full wallet address (for 16/18-char IDs)
        const fullRows = byFullId.get(t.walletAddress) || []
        const allRows = [...rows, ...fullRows].filter(r => r.season_id === period)
        
        if (allRows.length === 0) continue
        matched++

        for (const row of allRows) {
          const updates = {}
          if (row.win_rate == null && t.winRate != null) updates.win_rate = t.winRate
          if (row.max_drawdown == null && t.mdd != null) updates.max_drawdown = t.mdd
          
          if (Object.keys(updates).length === 0) continue

          // Recalculate arena_score if we're adding new data
          const newWr = updates.win_rate ?? row.win_rate
          const newMdd = updates.max_drawdown ?? row.max_drawdown

          const { error } = await supabase
            .from('trader_snapshots')
            .update(updates)
            .eq('source', SOURCE)
            .eq('source_trader_id', row.source_trader_id)
            .eq('season_id', period)
            .is('win_rate', row.win_rate == null ? null : undefined)

          if (!error) updated++
        }
      }

      console.log(`  Matched: ${matched}, Updated: ${updated}`)
      totalUpdated += updated
    }
  }

  // Also: for traders with pnlHistory, try to update those with truncated IDs 
  // to use full wallet addresses in trader_sources
  console.log(`\n--- Updating trader_sources with full wallet addresses ---`)
  for (const chainId of CHAINS) {
    const traders = await fetchAllTraders(PERIOD_MAP['90D'], chainId)
    let sourcesUpdated = 0
    for (const t of traders) {
      if (byTruncated.has(t.truncated)) {
        // Update trader_sources to have full wallet address stored
        const { error } = await supabase
          .from('trader_sources')
          .update({ 
            handle: t.name || t.truncated,
            profile_url: `https://web3.okx.com/zh-hans/copy-trade/trader/${t.walletAddress}`,
          })
          .eq('source', SOURCE)
          .eq('source_trader_id', t.truncated)
        if (!error) sourcesUpdated++
      }
    }
    console.log(`  Updated ${sourcesUpdated} trader_sources`)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ OKX Web3 enrichment done. Total updates: ${totalUpdated}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
