#!/usr/bin/env node
/**
 * Daily Archive - Detect and archive dropped traders
 * 
 * Run daily AFTER import scripts
 * Compares current API leaderboard with DB
 * Moves dropped traders to leaderboard_history
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCES = process.argv.slice(2).filter(a => !a.startsWith('--'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Exchange API fetchers
const FETCHERS = {
  async binance_web3() {
    const traders = new Set()
    const chains = [56, 1, 8453]
    const periods = ['7d', '30d', '90d']
    const seasonMap = { '7d': '7D', '30d': '30D', '90d': '90D' }

    for (const chain of chains) {
      for (const period of periods) {
        let page = 1
        while (page <= 20) {
          try {
            const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=${page}&pageSize=100&sortBy=0&orderBy=0&period=${period}&chainId=${chain}`
            const resp = await fetch(url)
            const json = await resp.json()
            if (json.code !== '000000' || !json.data?.data?.length) break

            for (const item of json.data.data) {
              const addr = (item.address || '').toLowerCase()
              const season = seasonMap[period]
              traders.add(`${addr}:${season}`)
            }

            if (json.data.data.length < 100) break
            page++
            await sleep(500)
          } catch { break }
        }
      }
    }
    return traders
  },

  async htx_futures() {
    const traders = new Set()
    let page = 1
    while (page <= 50) {
      try {
        const url = `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=50`
        const resp = await fetch(url)
        const json = await resp.json()
        if (json.code !== 200 || !json.data?.itemList?.length) break

        for (const item of json.data.itemList) {
          const sign = (item.userSign || '').replace(/=+$/, '')
          if (sign) traders.add(sign)
        }

        if (json.data.itemList.length < 50) break
        page++
        await sleep(300)
      } catch { break }
    }
    return traders
  },

  // Add more fetchers as needed
  // async bitget_futures() { ... }
  // async bingx_spot() { ... }
}

async function archiveSource(source) {
  console.log(`\n📦 Archiving ${source}...`)

  const fetcher = FETCHERS[source]
  if (!fetcher) {
    console.log(`  ⚠️  No fetcher for ${source}, skipping`)
    return
  }

  // Get current leaderboard from API
  console.log('  Fetching current leaderboard from API...')
  const currentSet = await fetcher()
  console.log(`  ✓ Current API traders: ${currentSet.size}`)

  // Get DB traders
  const { data: dbTraders } = await sb
    .from('leaderboard_ranks')
    .select('*')
    .eq('source', source)

  console.log(`  ✓ DB traders: ${dbTraders?.length || 0}`)

  // Detect dropped
  const dropped = []
  for (const trader of dbTraders || []) {
    const key = source === 'binance_web3'
      ? `${trader.source_trader_id.toLowerCase()}:${trader.season_id || 'ALL'}`
      : trader.source_trader_id.replace(/=+$/, '')

    if (!currentSet.has(key)) {
      dropped.push(trader)
    }
  }

  console.log(`  ✓ Dropped traders: ${dropped.length}`)

  if (dropped.length === 0) {
    console.log('  ✅ No traders to archive')
    return
  }

  // Move to history
  let archived = 0
  for (const trader of dropped) {
    const historyRecord = {
      ...trader,
      id: undefined, // Let DB generate new ID
      last_seen_at: new Date().toISOString(),
      snapshot_data: trader,
      enrichment_status: trader.win_rate != null ? 'complete' : 'pending',
    }
    delete historyRecord.id

    if (DRY_RUN) {
      archived++
    } else {
      const { error } = await sb.from('leaderboard_history').insert(historyRecord)
      if (!error) archived++
    }
  }

  console.log(`  ✓ Archived ${archived} traders`)

  // Delete from current
  if (!DRY_RUN && archived > 0) {
    const idsToDelete = dropped.map(t => t.id)
    const batchSize = 100
    let deleted = 0

    for (let i = 0; i < idsToDelete.length; i += batchSize) {
      const batch = idsToDelete.slice(i, i + batchSize)
      const { error } = await sb.from('leaderboard_ranks').delete().in('id', batch)
      if (!error) deleted += batch.length
    }

    console.log(`  ✓ Deleted ${deleted} from leaderboard_ranks`)
  }
}

async function main() {
  console.log('\n🗄️  Daily Archive - Dropped Traders\n')
  if (DRY_RUN) console.log('[DRY RUN]\n')

  const sources = SOURCES.length > 0 ? SOURCES : ['binance_web3', 'htx_futures']

  for (const source of sources) {
    await archiveSource(source)
  }

  console.log('\n✅ Archive complete\n')
}

main().catch(console.error)
