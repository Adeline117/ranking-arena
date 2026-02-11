/**
 * Enrich Binance Web3 trader_snapshots with trades_count and win_rate
 * 
 * The web3 leaderboard API returns totalTxCnt and winRate but the import
 * script wasn't saving them. This script fetches them and UPDATEs existing rows.
 * 
 * Usage: node scripts/import/enrich_binance_web3.mjs [7D|30D|90D|ALL]
 */

import {
  getSupabaseClient,
  sleep,
  getTargetPeriods,
} from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'binance_web3'
const PERIOD_MAP = { '7D': '7d', '30D': '30d', '90D': '90d' }
const CHAINS = [
  { chainId: 56, name: 'BSC' },
  { chainId: 1, name: 'ETH' },
  { chainId: 8453, name: 'Base' },
]
const PAGE_SIZE = 100

async function fetchPage(period, chainId, pageNo) {
  const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=${pageNo}&pageSize=${PAGE_SIZE}&sortBy=0&orderBy=0&period=${period}&chainId=${chainId}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return json?.data?.data || []
}

async function fetchAllTraders(periodApi) {
  const tradersMap = new Map()
  for (const { chainId, name } of CHAINS) {
    let pageNo = 1
    while (true) {
      const items = await fetchPage(periodApi, chainId, pageNo)
      if (!items.length) break
      for (const t of items) {
        if (!tradersMap.has(t.address)) {
          tradersMap.set(t.address, {
            address: t.address,
            winRate: t.winRate,
            totalTxCnt: t.totalTxCnt,
          })
        }
      }
      console.log(`    ${name} page ${pageNo}: ${items.length} traders`)
      if (items.length < PAGE_SIZE) break
      pageNo++
      await sleep(300)
    }
    await sleep(500)
  }
  return tradersMap
}

async function enrichPeriod(period) {
  const periodApi = PERIOD_MAP[period]
  console.log(`\n=== Enriching ${SOURCE} ${period} ===`)

  // Fetch current data from API
  const apiData = await fetchAllTraders(periodApi)
  console.log(`  Fetched ${apiData.size} traders from API`)

  // Get existing snapshots that need enrichment
  const { data: existing, error } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, win_rate, trades_count')
    .eq('source', SOURCE)
    .eq('season_id', period)

  if (error) {
    console.error(`  Error fetching snapshots: ${error.message}`)
    return 0
  }

  console.log(`  Found ${existing.length} existing snapshots`)

  let updated = 0
  const batchSize = 50

  for (let i = 0; i < existing.length; i += batchSize) {
    const batch = existing.slice(i, i + batchSize)
    
    for (const snap of batch) {
      const api = apiData.get(snap.source_trader_id)
      if (!api) continue

      const updates = {}
      
      // Only update NULL fields
      if (snap.trades_count == null && api.totalTxCnt != null) {
        updates.trades_count = parseInt(api.totalTxCnt)
      }
      if (snap.win_rate == null && api.winRate != null) {
        const wr = parseFloat(api.winRate)
        updates.win_rate = wr <= 1 ? wr * 100 : wr
      }

      if (Object.keys(updates).length === 0) continue

      const { error: updateErr } = await supabase
        .from('trader_snapshots')
        .update(updates)
        .eq('id', snap.id)

      if (!updateErr) updated++
    }

    if ((i + batchSize) % 200 === 0 || i + batchSize >= existing.length) {
      console.log(`  Progress: ${Math.min(i + batchSize, existing.length)}/${existing.length}, updated: ${updated}`)
    }
  }

  console.log(`  ✅ Updated ${updated} snapshots for ${period}`)
  return updated
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log('Binance Web3 Enrichment')
  console.log('Periods:', periods.join(', '))

  // Before counts
  for (const p of periods) {
    const { count: total } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p)
    const { count: hasWr } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('win_rate', 'is', null)
    const { count: hasTc } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('trades_count', 'is', null)
    console.log(`  BEFORE ${p}: ${total} total, ${hasWr} win_rate, ${hasTc} trades_count`)
  }

  let totalUpdated = 0
  for (const p of periods) {
    totalUpdated += await enrichPeriod(p)
    await sleep(1000)
  }

  // After counts
  console.log('\n--- AFTER ---')
  for (const p of periods) {
    const { count: total } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p)
    const { count: hasWr } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('win_rate', 'is', null)
    const { count: hasTc } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('trades_count', 'is', null)
    console.log(`  AFTER ${p}: ${total} total, ${hasWr} win_rate, ${hasTc} trades_count`)
  }

  console.log(`\n🎉 Done. Total updated: ${totalUpdated}`)
}

main().catch(e => { console.error(e); process.exit(1) })
