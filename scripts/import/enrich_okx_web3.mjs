#!/usr/bin/env node
/**
 * OKX Web3 Enrichment — fill win_rate and max_drawdown for existing traders
 *
 * API: /priapi/v1/dx/market/v2/smartmoney/ranking/content
 *   periodType: 1=7D, 2=30D, 3=90D
 *   rankBy: 1=PnL
 *   20 per page, can paginate up to 2000+
 *
 * Usage: node scripts/import/enrich_okx_web3.mjs
 */

import {
  getSupabaseClient,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'okx_web3'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'

const PERIOD_MAP = { '7D': '1', '30D': '2', '90D': '3' }

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

function computeMDD(pnlHistory) {
  if (!pnlHistory?.length || pnlHistory.length < 2) return null
  const values = pnlHistory.map(h => parseFloat(h.pnl)).filter(v => !isNaN(v))
  if (values.length < 2) return null
  let peak = values[0], maxDD = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) { const dd = ((peak - v) / peak) * 100; if (dd > maxDD) maxDD = dd }
  }
  return maxDD > 0 && maxDD <= 100 ? maxDD : null
}

function truncateAddress(addr) {
  if (!addr || addr.length < 11) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

async function fetchAllTraders(periodType, chainId, maxPages = 100) {
  const all = new Map()
  for (let start = 0; start < maxPages * 20; start += 20) {
    const url = `${BASE}?rankStart=${start}&periodType=${periodType}&rankBy=1&label=all&desc=true&rankEnd=${start + 20}&chainId=${chainId}`
    const json = await fetchJSON(url)
    const infos = json?.data?.rankingInfos || []
    if (infos.length === 0) break
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
    }
    if (all.size % 200 === 0) console.log(`    ... ${all.size} traders`)
    await sleep(150)
  }
  return all
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`OKX Web3 Enrichment — Fill win_rate & max_drawdown`)
  console.log(`${'='.repeat(60)}`)

  // Get all existing okx_web3 snapshots
  let existing = []
  let offset = 0
  while (true) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, season_id, win_rate, max_drawdown')
      .eq('source', SOURCE)
      .range(offset, offset + 999)
    if (!data?.length) break
    existing.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`DB: ${existing.length} total snapshots`)
  console.log(`Missing win_rate: ${existing.filter(r => r.win_rate == null).length}`)
  console.log(`Missing max_drawdown: ${existing.filter(r => r.max_drawdown == null).length}`)

  // Build lookup by truncated address and full ID
  const dbLookup = new Map() // key -> [{source_trader_id, season_id, win_rate, max_drawdown}]
  for (const row of existing) {
    // Index by trader ID itself
    const arr = dbLookup.get(row.source_trader_id) || []
    arr.push(row)
    dbLookup.set(row.source_trader_id, arr)
  }

  let totalUpdated = 0

  for (const [period, periodType] of Object.entries(PERIOD_MAP)) {
    console.log(`\n--- ${period} ---`)
    const apiTraders = await fetchAllTraders(periodType, 501)
    console.log(`  Fetched ${apiTraders.size} traders from API`)

    let matched = 0, updated = 0

    for (const [addr, t] of apiTraders) {
      // Try matching by truncated address (most common case)
      const truncated = t.truncated
      const candidates = dbLookup.get(truncated) || dbLookup.get(addr) || []
      const periodRows = candidates.filter(r => r.season_id === period)
      
      if (periodRows.length === 0) continue
      matched++

      for (const row of periodRows) {
        const updates = {}
        if (row.win_rate == null && t.winRate != null) updates.win_rate = t.winRate
        if (row.max_drawdown == null && t.mdd != null) updates.max_drawdown = t.mdd

        if (Object.keys(updates).length === 0) continue

        const { error } = await supabase
          .from('trader_snapshots')
          .update(updates)
          .eq('source', SOURCE)
          .eq('source_trader_id', row.source_trader_id)
          .eq('season_id', period)

        if (!error) updated++
      }
    }

    console.log(`  Matched: ${matched}, Updated: ${updated}`)
    totalUpdated += updated
  }

  // Final stats
  let after = []
  offset = 0
  while (true) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('win_rate, max_drawdown')
      .eq('source', SOURCE)
      .range(offset, offset + 999)
    if (!data?.length) break
    after.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ OKX Web3 enrichment done`)
  console.log(`   Total updates: ${totalUpdated}`)
  console.log(`   After — missing win_rate: ${after.filter(r => r.win_rate == null).length}, missing max_drawdown: ${after.filter(r => r.max_drawdown == null).length}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
