#!/usr/bin/env node
/**
 * Final P0 Fix - Simplified
 * 
 * Skip Bitget (CloudFlare too strong, accept limitation)
 * Fix Binance Web3 only (deep scan all pages/chains)
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace('%', '').trim())
  return isNaN(n) ? null : n
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('🔧 Final P0 Fix: Binance Web3 Deep Scan')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

const { data: rows } = await sb
  .from('leaderboard_ranks')
  .select('id, source_trader_id, season_id, win_rate, trades_count, roi')
  .eq('source', 'binance_web3')
  .or('win_rate.is.null,trades_count.is.null,roi.is.null')

console.log(`Traders needing enrichment: ${rows.length}\n`)

if (rows.length === 0) {
  console.log('✅ All complete!')
  process.exit(0)
}

const periodMap = { '7D': '7d', '30D': '30d', '90D': '90d', 'ALL': '30d' }
const chains = [
  { id: 56, name: 'BSC' },
  { id: 1, name: 'ETH' },
  { id: 8453, name: 'Base' },
]

const allTraders = new Map() // "address:seasonId" -> data

console.log('Fetching from Binance Web3 API (all chains + periods)...\n')

for (const chain of chains) {
  for (const [seasonId, period] of Object.entries(periodMap)) {
    console.log(`📡 Chain=${chain.name} Period=${period}`)
    
    let page = 1
    let fetched = 0

    while (page <= 100) { // Max 100 pages
      try {
        const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=${page}&pageSize=100&sortBy=0&orderBy=0&period=${period}&chainId=${chain.id}`
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/json',
          }
        })

        if (!resp.ok) {
          console.log(`   Page ${page}: HTTP ${resp.status}`)
          break
        }

        const json = await resp.json()

        if (json.code !== '000000') {
          console.log(`   Page ${page}: code=${json.code}`)
          break
        }

        const items = json.data?.data || []
        if (items.length === 0) break

        for (const item of items) {
          const addr = (item.address || '').toLowerCase()
          const key = `${addr}:${seasonId}`
          
          // First seen wins (BSC priority)
          if (!allTraders.has(key)) {
            allTraders.set(key, {
              address: addr,
              winRate: item.winRate,
              totalTxCnt: item.totalTxCnt,
              realizedPnlPercent: item.realizedPnlPercent,
              realizedPnl: item.realizedPnl,
              chain: chain.name,
              period: period,
            })
            fetched++
          }
        }

        if (items.length < 100) break // Last page
        
        page++
        await sleep(500) // Rate limit
      } catch (e) {
        console.log(`   Error on page ${page}: ${e.message.slice(0, 60)}`)
        break
      }
    }

    console.log(`   → Fetched ${fetched} unique traders (${page - 1} pages)\n`)
    await sleep(1000) // Between periods
  }
}

console.log(`\n📊 Total unique address:season combos: ${allTraders.size}\n`)

// Match and update
console.log('Matching traders...\n')

let updated = 0, matched = 0, unmatched = 0

for (const row of rows) {
  const addr = row.source_trader_id.toLowerCase()
  const seasonId = row.season_id || 'ALL'
  const key = `${addr}:${seasonId}`
  
  const trader = allTraders.get(key)
  
  if (!trader) {
    unmatched++
    if (unmatched <= 10) {
      console.log(`✗ ${addr.slice(0, 10)}... (${seasonId}) - not found`)
    }
    continue
  }

  matched++
  const updates = {}

  // Win rate
  if (row.win_rate == null && trader.winRate != null) {
    let wr = parseNum(trader.winRate)
    if (wr != null && wr > 0 && wr <= 1) wr = wr * 100 // Convert decimal to %
    if (wr != null && wr >= 0 && wr <= 100) updates.win_rate = wr
  }

  // Trades count
  if (row.trades_count == null && trader.totalTxCnt != null) {
    const tc = parseInt(trader.totalTxCnt)
    if (!isNaN(tc) && tc >= 0) updates.trades_count = tc
  }

  // ROI
  if (row.roi == null && trader.realizedPnlPercent != null) {
    let roi = parseNum(trader.realizedPnlPercent)
    if (roi != null) roi = roi * 100 // Convert decimal to %
    if (roi != null) updates.roi = roi
  }

  if (Object.keys(updates).length === 0) {
    continue
  }

  if (DRY_RUN) {
    console.log(`[DRY] ${addr.slice(0, 10)}...: ${Object.keys(updates).join(', ')}`)
    updated++
  } else {
    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) {
      updated++
      if (updated <= 20) {
        console.log(`✓ ${addr.slice(0, 10)}... (${trader.chain}): ${Object.keys(updates).join(', ')}`)
      }
    }
  }
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
console.log(`✅ Complete`)
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
console.log(`   Matched: ${matched}`)
console.log(`   Updated: ${updated}`)
console.log(`   Unmatched: ${unmatched}`)
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)

// Final check
const { count: wrNull } = await sb
  .from('leaderboard_ranks')
  .select('*', { count: 'exact', head: true })
  .eq('source', 'binance_web3')
  .is('win_rate', null)

const { count: tcNull } = await sb
  .from('leaderboard_ranks')
  .select('*', { count: 'exact', head: true })
  .eq('source', 'binance_web3')
  .is('trades_count', null)

console.log(`📊 Final Binance Web3 nulls: WR=${wrNull} TC=${tcNull}\n`)
