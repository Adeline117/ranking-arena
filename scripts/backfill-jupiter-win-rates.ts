#!/usr/bin/env tsx

/**
 * Backfill Jupiter Perps trader win_rate data
 * 
 * The issue: Jupiter Perps trader IDs were stored as lowercase in the database,
 * but the trades API requires the original mixed-case addresses.
 * 
 * This script:
 * 1. Fetches current trader data from Jupiter API (mixed-case addresses)
 * 2. Maps lowercase DB addresses to mixed-case API addresses  
 * 3. Enriches existing DB records with win_rate data via trades API
 */

import { createClient } from '@supabase/supabase-js'
import { fetchJson, sleep } from '../lib/cron/fetchers/shared'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase credentials')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Jupiter API constants
const API_BASE = 'https://perps-api.jup.ag/v1/top-traders'
const TRADES_API = 'https://perps-api.jup.ag/v1/trades'

const MARKET_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
}

interface JupiterTraderEntry {
  owner: string
  totalPnlUsd: string
  totalVolumeUsd: string
}

interface JupiterTopTradersResponse {
  topTradersByPnl: JupiterTraderEntry[]
  topTradersByVolume: JupiterTraderEntry[]
}

interface JupiterTrade {
  action: string
  pnl: string | null
  createdTime: number
}

interface JupiterTradesResponse {
  dataList: JupiterTrade[]
  count: number
}

interface TraderStats {
  winRate: number | null
  tradesCount: number | null
}

// Fetch current trader data from Jupiter API
async function fetchCurrentTraders(): Promise<Map<string, string>> {
  const allTraders = new Set<string>()
  
  for (const market of Object.keys(MARKET_MINTS) as Array<keyof typeof MARKET_MINTS>) {
    try {
      const mint = MARKET_MINTS[market]
      const year = new Date().getFullYear()
      const url = `${API_BASE}?marketMint=${mint}&year=${year}&week=current`
      
      const data = await fetchJson<JupiterTopTradersResponse>(url, { timeoutMs: 15000 })
      
      for (const trader of [...(data.topTradersByPnl || []), ...(data.topTradersByVolume || [])]) {
        if (trader.owner) {
          allTraders.add(trader.owner)
        }
      }
      
      await sleep(500)
    } catch (error) {
      console.warn(`Failed to fetch ${market} traders:`, error)
    }
  }
  
  // Create mapping: lowercase -> original case
  const mapping = new Map<string, string>()
  for (const original of allTraders) {
    mapping.set(original.toLowerCase(), original)
  }
  
  console.log(`Fetched ${allTraders.size} unique traders from Jupiter API`)
  return mapping
}

// Fetch trader stats from trades API
async function fetchTraderStats(originalAddress: string): Promise<TraderStats> {
  try {
    const url = `${TRADES_API}?walletAddress=${originalAddress}&limit=100`
    const data = await fetchJson<JupiterTradesResponse>(url, { timeoutMs: 10000 })
    
    if (!data?.dataList || data.dataList.length === 0) {
      return { winRate: null, tradesCount: null }
    }
    
    // Only consider closing trades with PnL
    const closingTrades = data.dataList.filter(
      (t) => t.pnl != null && t.action !== 'Increase'
    )
    
    if (closingTrades.length === 0) {
      return { winRate: null, tradesCount: data.count || data.dataList.length }
    }
    
    const wins = closingTrades.filter((t) => parseFloat(t.pnl || '0') > 0)
    const winRate = (wins.length / closingTrades.length) * 100
    
    return {
      winRate,
      tradesCount: data.count || data.dataList.length,
    }
  } catch {
    return { winRate: null, tradesCount: null }
  }
}

// Get traders that need backfilling
async function getTradersToBackfill() {
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id')
    .eq('source', 'jupiter_perps')
    .is('win_rate', null)
    .gte('captured_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  
  if (error) {
    throw new Error(`Failed to fetch traders: ${error.message}`)
  }
  
  return data || []
}

// Update trader win_rate in database
async function updateTraderStats(lowercaseId: string, seasonId: string, stats: TraderStats) {
  const updates: any = {}
  if (stats.winRate !== null) updates.win_rate = stats.winRate
  if (stats.tradesCount !== null) updates.trades_count = stats.tradesCount
  
  if (Object.keys(updates).length === 0) return false
  
  const { error } = await supabase
    .from('trader_snapshots')
    .update(updates)
    .eq('source', 'jupiter_perps')
    .eq('source_trader_id', lowercaseId)
    .eq('season_id', seasonId)
  
  if (error) {
    console.warn(`Failed to update ${lowercaseId}:`, error.message)
    return false
  }
  
  return true
}

async function main() {
  console.log('🚀 Starting Jupiter Perps win_rate backfill...')
  
  // Step 1: Fetch current traders from Jupiter API
  console.log('📡 Fetching current traders from Jupiter API...')
  const addressMapping = await fetchCurrentTraders()
  
  // Step 2: Get traders that need backfilling
  console.log('🔍 Fetching traders that need backfilling...')
  const tradersToBackfill = await getTradersToBackfill()
  console.log(`Found ${tradersToBackfill.length} traders to backfill`)
  
  // Step 3: Process traders in batches
  const BATCH_SIZE = 10
  const DELAY_MS = 1000
  let processed = 0
  let enriched = 0
  let skipped = 0
  
  for (let i = 0; i < tradersToBackfill.length; i += BATCH_SIZE) {
    const batch = tradersToBackfill.slice(i, i + BATCH_SIZE)
    
    await Promise.all(
      batch.map(async (trader) => {
        const { source_trader_id: lowercaseId, season_id: seasonId } = trader
        const originalAddress = addressMapping.get(lowercaseId)
        
        if (!originalAddress) {
          console.warn(`⚠️  No mapping found for ${lowercaseId}`)
          skipped++
          return
        }
        
        try {
          const stats = await fetchTraderStats(originalAddress)
          if (stats.winRate !== null) {
            const updated = await updateTraderStats(lowercaseId, seasonId, stats)
            if (updated) {
              enriched++
              console.log(`✅ Updated ${lowercaseId} -> win_rate: ${stats.winRate?.toFixed(1)}%`)
            }
          } else {
            skipped++
          }
        } catch (error) {
          console.warn(`❌ Failed to process ${lowercaseId}:`, error)
          skipped++
        } finally {
          processed++
        }
      })
    )
    
    console.log(`📊 Progress: ${processed}/${tradersToBackfill.length} (${enriched} enriched, ${skipped} skipped)`)
    
    if (i + BATCH_SIZE < tradersToBackfill.length) {
      await sleep(DELAY_MS)
    }
  }
  
  console.log('✨ Backfill complete!')
  console.log(`📈 Final stats: ${enriched} traders enriched, ${skipped} skipped, ${processed} total processed`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Backfill failed:', error)
    process.exit(1)
  })
}