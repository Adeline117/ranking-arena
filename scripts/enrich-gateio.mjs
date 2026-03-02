#!/usr/bin/env node
/**
 * enrich-gateio.mjs
 * 
 * Fetch Gate.io copy trading leaderboard data via public Web API.
 * 
 * Data Source: https://www.gate.io/apiw/v2/copy/leader/list
 * Documentation: ~/ranking-arena/docs/exchange-apis/gateio.md
 * 
 * Features:
 * - No API keys required (uses public frontend API)
 * - Fetches multiple ranking criteria (ROI, AUM, Win Rate, etc.)
 * - Supports different time periods (week, month, quarter)
 * - Handles pagination automatically
 * - Stores enriched data in Supabase
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// API Configuration
const BASE_URL = 'https://www.gate.io/apiw/v2/copy/leader/list'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.gate.io/copytrading',
  'Origin': 'https://www.gate.io',
}

const DELAY_MS = 400 // Rate limiting delay
const MAX_PAGES_PER_CATEGORY = 50 // Pagination limit
const PAGE_SIZE = 100

// Ranking categories to fetch
const ORDER_BY_OPTIONS = [
  'profit_rate',   // ROI
  'profit',        // Absolute profit
  'aum',          // Assets Under Management
  'win_rate',     // Win rate
  'max_drawdown', // Maximum drawdown
  'sharp_ratio'   // Sharpe ratio
]

const CYCLE_OPTIONS = ['week', 'month', 'quarter']

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Fetch a single page from Gate.io API
 */
async function fetchPage(orderBy, cycle, page, pageSize = PAGE_SIZE) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${BASE_URL}?page=${page}&page_size=${pageSize}&status=running&order_by=${orderBy}&sort_by=desc&cycle=${cycle}`
      
      const response = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000)
      })

      if (!response.ok) {
        console.warn(`  ⚠️  HTTP ${response.status} for ${orderBy}/${cycle} page ${page}`)
        if (attempt < 2) await sleep(2000)
        continue
      }

      const json = await response.json()
      
      if (json.code !== 0) {
        console.warn(`  ⚠️  API error (code=${json.code}): ${json.message}`)
        return null
      }

      return json
    } catch (error) {
      console.warn(`  ⚠️  Request failed (attempt ${attempt + 1}/3): ${error.message}`)
      if (attempt < 2) await sleep(2000)
    }
  }
  
  return null
}

/**
 * Convert API response to normalized trader data
 */
function normalizeTraderData(trader, cycle, orderBy) {
  return {
    leader_id: String(trader.leader_id || ''),
    nickname: trader.nickname || '',
    
    // Performance metrics (convert decimals to percentages)
    profit_rate: trader.profit_rate != null 
      ? (trader.profit_rate <= 1 ? Math.round(trader.profit_rate * 10000) / 100 : trader.profit_rate)
      : null,
    
    win_rate: trader.win_rate != null
      ? (trader.win_rate <= 1 ? Math.round(trader.win_rate * 10000) / 100 : trader.win_rate)
      : null,
    
    max_drawdown: trader.max_drawdown != null
      ? (Math.abs(trader.max_drawdown) <= 1 ? Math.round(Math.abs(trader.max_drawdown) * 10000) / 100 : Math.abs(trader.max_drawdown))
      : null,
    
    sharp_ratio: trader.sharp_ratio != null ? parseFloat(trader.sharp_ratio) : null,
    
    // Financial metrics
    profit: trader.profit != null ? parseFloat(trader.profit) : null,
    aum: trader.aum != null ? parseFloat(trader.aum) : null,
    total_pnl: trader.total_pnl != null ? parseFloat(trader.total_pnl) : null,
    
    // Trading stats
    follower_num: trader.follower_num || 0,
    position_num: trader.position_num || 0,
    close_position_num: trader.close_position_num || 0,
    
    // Avatar
    avatar: trader.avatar || null,
    
    // Metadata
    cycle,
    order_by: orderBy,
    fetched_at: new Date().toISOString()
  }
}

/**
 * Fetch all traders across all categories and cycles
 */
async function fetchAllTraders() {
  const tradersMap = new Map() // Use Map to deduplicate by leader_id
  let totalFetched = 0

  console.log('🔍 Starting Gate.io data collection...\n')

  for (const cycle of CYCLE_OPTIONS) {
    console.log(`\n📅 Cycle: ${cycle}`)
    
    for (const orderBy of ORDER_BY_OPTIONS) {
      console.log(`  📊 Order by: ${orderBy}`)
      
      let page = 1
      let consecutiveEmptyPages = 0

      while (page <= MAX_PAGES_PER_CATEGORY) {
        const json = await fetchPage(orderBy, cycle, page, PAGE_SIZE)
        
        if (!json || !json.data || !json.data.list) {
          console.log(`    ⏭️  No data on page ${page}, stopping this category`)
          break
        }

        const traders = json.data.list
        
        if (traders.length === 0) {
          consecutiveEmptyPages++
          if (consecutiveEmptyPages >= 2) {
            console.log(`    ⏭️  2 consecutive empty pages, stopping`)
            break
          }
          page++
          await sleep(DELAY_MS)
          continue
        }

        consecutiveEmptyPages = 0
        let newInPage = 0

        for (const trader of traders) {
          const leaderId = String(trader.leader_id || '')
          if (!leaderId) continue

          const normalized = normalizeTraderData(trader, cycle, orderBy)
          
          // Store or merge with existing data
          if (!tradersMap.has(leaderId)) {
            tradersMap.set(leaderId, normalized)
            newInPage++
          } else {
            // Update if we got better data (e.g., more complete metrics)
            const existing = tradersMap.get(leaderId)
            tradersMap.set(leaderId, { ...existing, ...normalized })
          }
        }

        totalFetched += traders.length
        console.log(`    📄 Page ${page}: ${traders.length} traders (${newInPage} new unique)`)

        // Check if there's a next page
        if (!json.data.has_next) {
          console.log(`    ✅ Reached last page`)
          break
        }

        page++
        await sleep(DELAY_MS) // Rate limiting
      }
    }
  }

  console.log(`\n✅ Collection complete!`)
  console.log(`   Total API responses: ${totalFetched}`)
  console.log(`   Unique traders: ${tradersMap.size}\n`)

  return Array.from(tradersMap.values())
}

/**
 * Store traders in database
 */
async function storeTraders(traders) {
  console.log('💾 Storing data in Supabase...')
  
  // TODO: Implement Supabase storage based on your schema
  // Example:
  /*
  const { data, error } = await sb
    .from('gateio_traders')
    .upsert(traders, { onConflict: 'leader_id' })
  
  if (error) {
    console.error('❌ Database error:', error)
    return false
  }
  
  console.log(`✅ Stored ${data?.length || 0} traders`)
  */
  
  // For now, just save to JSON file for inspection
  const fs = await import('fs')
  const outputPath = './data/gateio-traders.json'
  
  await fs.promises.mkdir('./data', { recursive: true })
  await fs.promises.writeFile(
    outputPath,
    JSON.stringify(traders, null, 2)
  )
  
  console.log(`✅ Saved ${traders.length} traders to ${outputPath}`)
  
  return true
}

/**
 * Main execution
 */
async function main() {
  console.log('═══════════════════════════════════════')
  console.log('  Gate.io Copy Trading Data Enrichment')
  console.log('═══════════════════════════════════════')
  console.log(`Started: ${new Date().toISOString()}\n`)

  try {
    const traders = await fetchAllTraders()
    
    if (traders.length === 0) {
      console.log('⚠️  No traders fetched. Exiting.')
      return
    }

    await storeTraders(traders)

    console.log('\n═══════════════════════════════════════')
    console.log('✅ Enrichment completed successfully!')
    console.log(`Finished: ${new Date().toISOString()}`)
    console.log('═══════════════════════════════════════')

  } catch (error) {
    console.error('\n❌ Fatal error:', error)
    process.exit(1)
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}

export { fetchAllTraders, fetchPage, normalizeTraderData }
