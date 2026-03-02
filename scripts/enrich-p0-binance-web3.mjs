#!/usr/bin/env node
/**
 * Binance Web3 P0 Enrichment
 * 
 * Priority fields: win_rate, trades_count, roi, pnl
 * Multi-chain: BSC (56), ETH (1), Base (8453)
 * Multi-period: 7d, 30d, 90d
 * 
 * Note: max_drawdown NOT available from API
 * 
 * Usage: node scripts/enrich-p0-binance-web3.mjs [--dry-run]
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE = 'binance_web3'
const API_URL = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v))
  return isNaN(n) ? null : n
}

async function fetchLeaderboard(period, chainId, pageNo, pageSize = 100) {
  const url = `${API_URL}?tag=ALL&pageNo=${pageNo}&pageSize=${pageSize}&sortBy=0&orderBy=0&period=${period}&chainId=${chainId}`
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    }
  })
  
  if (!response.ok) return null
  const json = await response.json()
  if (json.code !== '000000') return null
  return json.data || null
}

async function main() {
  console.log(`\n🚀 Binance Web3 P0 Enrichment (source='${SOURCE}')`)
  if (DRY_RUN) console.log('  [DRY RUN]\n')

  // Get rows needing enrichment
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, trades_count, roi, pnl, season_id')
    .eq('source', SOURCE)
    .or('win_rate.is.null,trades_count.is.null,roi.is.null')
    .limit(2000)

  if (error) { console.error('Query error:', error.message); process.exit(1) }
  console.log(`  DB rows needing enrichment: ${rows.length}`)
  if (rows.length === 0) {
    console.log('  ✅ All rows complete!')
    return
  }

  // Group by season_id to determine which period to fetch
  const periodMap = { '7D': '7d', '30D': '30d', '90D': '90d' }
  const rowsByPeriod = new Map()
  for (const row of rows) {
    const period = periodMap[row.season_id] || '30d'
    if (!rowsByPeriod.has(period)) rowsByPeriod.set(period, [])
    rowsByPeriod.get(period).push(row)
  }

  console.log('  Periods needed:', Array.from(rowsByPeriod.keys()))

  // Build map of needed addresses
  const needMap = new Map()
  for (const row of rows) {
    const addr = row.source_trader_id.toLowerCase()
    needMap.set(addr, row)
  }

  console.log(`  Unique addresses needed: ${needMap.size}`)
  console.log('\n📊 Fetching Binance Web3 leaderboard...')

  // Fetch all traders from all chains and periods
  const allTraders = []
  const chains = [
    { id: 56, name: 'BSC' },
    { id: 1, name: 'ETH' },
    { id: 8453, name: 'Base' },
  ]

  for (const [period, periodRows] of rowsByPeriod) {
    console.log(`\n  Period: ${period}`)
    
    for (const chain of chains) {
      console.log(`    Chain: ${chain.name} (${chain.id})`)
      let pageNo = 1
      let hasMore = true

      while (hasMore && pageNo <= 20) {
        const data = await fetchLeaderboard(period, chain.id, pageNo, 100)
        if (!data || !data.data || data.data.length === 0) {
          console.log(`      Page ${pageNo}: no data`)
          hasMore = false
          break
        }

        const items = data.data
        console.log(`      Page ${pageNo}: ${items.length} traders`)
        
        // Tag with period for matching
        for (const item of items) {
          item._period = period
          item._chain = chain.name
        }
        allTraders.push(...items)

        if (items.length < 100) {
          hasMore = false // Last page
        }

        pageNo++
        await sleep(400) // Rate limit
      }

      await sleep(500) // Between chains
    }
  }

  console.log(`  Total traders fetched: ${allTraders.length}`)

  // Build trader map by address
  const traderMap = new Map()
  for (const item of allTraders) {
    const addr = (item.address || '').toLowerCase()
    if (!addr) continue
    
    // Key: address + period
    const key = `${addr}:${item._period}`
    
    // BSC priority (first seen wins)
    if (!traderMap.has(key)) {
      traderMap.set(key, item)
    }
  }

  console.log(`  Unique address:period combos: ${traderMap.size}`)

  // Match and update
  console.log('\n📊 Matching traders...')
  let matched = 0, unmatched = 0, updated = 0, skipped = 0, errors = 0

  for (const row of rows) {
    const addr = row.source_trader_id.toLowerCase()
    const period = periodMap[row.season_id] || '30d'
    const key = `${addr}:${period}`
    
    const trader = traderMap.get(key)
    if (!trader) {
      console.log(`  ✗ ${row.handle} (${addr.slice(0, 10)}... ${period}) - not found`)
      unmatched++
      continue
    }

    matched++
    const updates = {}

    // CRITICAL: Only use real API data
    if (row.win_rate == null && trader.winRate != null) {
      let wr = parseNum(trader.winRate)
      // Binance returns decimal (0.685) → convert to %
      if (wr != null && wr > 0 && wr <= 1) wr = wr * 100
      if (wr != null && wr >= 0 && wr <= 100) updates.win_rate = wr
    }

    if (row.trades_count == null && trader.totalTxCnt != null) {
      const tc = parseInt(trader.totalTxCnt)
      if (!isNaN(tc) && tc >= 0) updates.trades_count = tc
    }

    if (row.roi == null && trader.realizedPnlPercent != null) {
      let roi = parseNum(trader.realizedPnlPercent)
      // API returns decimal (1.255) → convert to %
      if (roi != null) roi = roi * 100
      if (roi != null) updates.roi = roi
    }

    if (row.pnl == null && trader.realizedPnl != null) {
      const pnl = parseNum(trader.realizedPnl)
      if (pnl != null) updates.pnl = pnl
    }

    if (Object.keys(updates).length === 0) {
      console.log(`  - ${row.handle} - no updates needed`)
      skipped++
      continue
    }

    if (DRY_RUN) {
      console.log(`  [DRY] ${row.handle}: ${JSON.stringify(updates)}`)
      updated++
      continue
    }

    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) {
      updated++
      console.log(`  ✓ ${row.handle}: ${Object.keys(updates).join(', ')}`)
    } else {
      errors++
      console.error(`  Error updating ${row.handle}: ${ue.message}`)
    }
  }

  console.log(`\n✅ Complete: ${updated} updated, ${skipped} skipped, ${matched} matched, ${unmatched} unmatched, ${errors} errors`)

  // Final stats
  const { count: wrNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('win_rate', null)

  const { count: tcNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('trades_count', null)

  const { count: roiNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('roi', null)

  console.log(`\n📊 Final nulls: WR=${wrNull} TC=${tcNull} ROI=${roiNull}`)
  console.log('  ⚠️ max_drawdown NOT available from Binance Web3 API')
}

main().catch(e => { console.error(e); process.exit(1) })
