/**
 * One-time script: Remove duplicate trader addresses (checksummed vs lowercase)
 * in leaderboard_ranks and trader_sources tables.
 * 
 * Usage: node scripts/fix-duplicate-addresses.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Parse .env.local
function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env.local')
  const content = readFileSync(envPath, 'utf-8')
  const vars = {}
  for (const line of content.split('\n')) {
    const match = line.match(/^([^#=]+)=["']?(.+?)["']?\s*$/)
    if (match) vars[match[1].trim()] = match[2]
  }
  return vars
}

const env = loadEnv()
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

const DEX_SOURCES = ['gmx', 'hyperliquid', 'dydx', 'jupiter_perps', 'gains', 'aevo', 'dune_gmx', 'dune_hyperliquid', 'dune_uniswap', 'dune_defi']

async function getDuplicatesForSource(table, source) {
  // Fetch all source_trader_ids for this source
  let allIds = []
  let offset = 0
  const batchSize = 1000
  
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('source_trader_id')
      .eq('source', source)
      .range(offset, offset + batchSize - 1)
    
    if (error) {
      console.error(`  Error fetching ${table}/${source}:`, error.message)
      return []
    }
    if (!data || data.length === 0) break
    allIds.push(...data)
    if (data.length < batchSize) break
    offset += batchSize
  }

  // Find checksummed IDs that have a lowercase counterpart
  const lowercaseSet = new Set()
  const checksummedIds = []
  
  for (const r of allIds) {
    const id = r.source_trader_id
    if (id === id.toLowerCase()) {
      lowercaseSet.add(id)
    }
  }
  
  for (const r of allIds) {
    const id = r.source_trader_id
    if (id !== id.toLowerCase() && lowercaseSet.has(id.toLowerCase())) {
      checksummedIds.push(id)
    }
  }
  
  return checksummedIds
}

async function deleteDuplicates(table, source, ids) {
  if (ids.length === 0) return 0
  
  let deleted = 0
  // Delete in batches of 100
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100)
    const { error, count } = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .eq('source', source)
      .in('source_trader_id', batch)
    
    if (error) {
      console.error(`  Error deleting from ${table}:`, error.message)
    } else {
      deleted += count || batch.length
    }
  }
  return deleted
}

async function main() {
  console.log('=== Duplicate Address Cleanup ===\n')
  
  let totalLeaderboard = 0
  let totalTraderSources = 0
  
  for (const source of DEX_SOURCES) {
    console.log(`Checking source: ${source}`)
    
    // Check leaderboard_ranks
    const lbDups = await getDuplicatesForSource('leaderboard_ranks', source)
    if (lbDups.length > 0) {
      console.log(`  leaderboard_ranks: ${lbDups.length} duplicates found`)
      const deleted = await deleteDuplicates('leaderboard_ranks', source, lbDups)
      console.log(`  leaderboard_ranks: ${deleted} records deleted`)
      totalLeaderboard += deleted
    } else {
      console.log(`  leaderboard_ranks: no duplicates`)
    }
    
    // Check trader_sources
    const tsDups = await getDuplicatesForSource('trader_sources', source)
    if (tsDups.length > 0) {
      console.log(`  trader_sources: ${tsDups.length} duplicates found`)
      const deleted = await deleteDuplicates('trader_sources', source, tsDups)
      console.log(`  trader_sources: ${deleted} records deleted`)
      totalTraderSources += deleted
    } else {
      console.log(`  trader_sources: no duplicates`)
    }
    
    console.log()
  }
  
  console.log('=== Summary ===')
  console.log(`leaderboard_ranks: ${totalLeaderboard} duplicates removed`)
  console.log(`trader_sources: ${totalTraderSources} duplicates removed`)
  console.log(`Total: ${totalLeaderboard + totalTraderSources} records cleaned`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
