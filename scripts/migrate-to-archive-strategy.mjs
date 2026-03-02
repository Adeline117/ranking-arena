#!/usr/bin/env node
/**
 * Migrate to Archive Strategy
 * 
 * 1. Create leaderboard_history table
 * 2. Detect dropped traders (not in current API)
 * 3. Move to history
 * 4. Verify
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const sleep = ms => new Promise(r => setTimeout(r, ms))

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('🗄️  Archive Strategy Migration')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
if (DRY_RUN) console.log('  [DRY RUN MODE]\n')

// ============================================
// Step 1: Create leaderboard_history table
// ============================================
console.log('Step 1: Creating leaderboard_history table...\n')

const createTableSQL = `
CREATE TABLE IF NOT EXISTS leaderboard_history (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  season_id TEXT,
  handle TEXT,
  avatar_url TEXT,
  win_rate NUMERIC,
  max_drawdown NUMERIC,
  trades_count INTEGER,
  roi NUMERIC,
  pnl NUMERIC,
  followers INTEGER,
  roi_7d NUMERIC,
  roi_30d NUMERIC,
  roi_90d NUMERIC,
  win_rate_7d NUMERIC,
  win_rate_30d NUMERIC,
  win_rate_90d NUMERIC,
  max_drawdown_7d NUMERIC,
  max_drawdown_30d NUMERIC,
  max_drawdown_90d NUMERIC,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  snapshot_data JSONB,
  enrichment_status TEXT DEFAULT 'pending',
  UNIQUE(source, source_trader_id, season_id, archived_at)
);

CREATE INDEX IF NOT EXISTS idx_history_source ON leaderboard_history(source);
CREATE INDEX IF NOT EXISTS idx_history_trader ON leaderboard_history(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_history_archived ON leaderboard_history(archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_enrichment ON leaderboard_history(enrichment_status);
`

if (!DRY_RUN) {
  const { error } = await sb.rpc('exec_sql', { sql: createTableSQL }).catch(() => ({ error: 'RPC not available, using direct query' }))
  
  if (error && error !== 'RPC not available, using direct query') {
    console.log('  ⚠️  Could not create via RPC, using supabase.sql...')
    // Alternative: Use Supabase SQL editor or direct connection
    console.log('  📝 SQL to run in Supabase SQL Editor:\n')
    console.log(createTableSQL)
    console.log('\n  ⏸️  Pausing for manual table creation...')
    process.exit(0)
  }
}

console.log('  ✓ leaderboard_history table ready\n')

// ============================================
// Step 2: Detect dropped traders
// ============================================
console.log('Step 2: Detecting dropped traders...\n')

// For Binance Web3, fetch current leaderboard
const currentTraders = new Set()

console.log('  Fetching current Binance Web3 leaderboard...')

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

        if (json.code !== '000000' || !json.data?.data || json.data.data.length === 0) break

        for (const item of json.data.data) {
          const addr = (item.address || '').toLowerCase()
          const season = seasonMap[period]
          const key = `binance_web3:${addr}:${season}`
          currentTraders.add(key)
        }

        if (json.data.data.length < 100) break
        page++
        await sleep(500)
      } catch (e) {
        console.log(`    Chain ${chain} period ${period} page ${page}: ${e.message}`)
        break
      }
    }
  }
}

console.log(`  ✓ Current traders: ${currentTraders.size}\n`)

// Get all Binance Web3 traders from DB
const { data: dbTraders, error: dbError } = await sb
  .from('leaderboard_ranks')
  .select('*')
  .eq('source', 'binance_web3')

if (dbError) {
  console.log(`  ✗ DB query error: ${dbError.message}`)
  process.exit(1)
}

console.log(`  DB traders: ${dbTraders?.length || 0}`)

const droppedTraders = []

for (const trader of dbTraders || []) {
  const addr = trader.source_trader_id.toLowerCase()
  const season = trader.season_id || 'ALL'
  const key = `${trader.source}:${addr}:${season}`
  
  if (!currentTraders.has(key)) {
    droppedTraders.push(trader)
  }
}

console.log(`  ✓ Dropped traders: ${droppedTraders.length}\n`)

if (droppedTraders.length === 0) {
  console.log('✅ No traders to archive. All current!\n')
  process.exit(0)
}

// ============================================
// Step 3: Move to history
// ============================================
console.log('Step 3: Moving dropped traders to history...\n')

let archived = 0

for (const trader of droppedTraders) {
  const historyRecord = {
    source: trader.source,
    source_trader_id: trader.source_trader_id,
    season_id: trader.season_id,
    handle: trader.handle,
    avatar_url: trader.avatar_url,
    win_rate: trader.win_rate,
    max_drawdown: trader.max_drawdown,
    trades_count: trader.trades_count,
    roi: trader.roi,
    pnl: trader.pnl,
    followers: trader.followers,
    roi_7d: trader.roi_7d,
    roi_30d: trader.roi_30d,
    roi_90d: trader.roi_90d,
    win_rate_7d: trader.win_rate_7d,
    win_rate_30d: trader.win_rate_30d,
    win_rate_90d: trader.win_rate_90d,
    max_drawdown_7d: trader.max_drawdown_7d,
    max_drawdown_30d: trader.max_drawdown_30d,
    max_drawdown_90d: trader.max_drawdown_90d,
    last_seen_at: new Date().toISOString(),
    snapshot_data: trader,
    enrichment_status: trader.win_rate != null ? 'complete' : 'pending',
  }

  if (DRY_RUN) {
    console.log(`  [DRY] Archive ${trader.source_trader_id.slice(0, 10)}... (${trader.season_id})`)
    archived++
  } else {
    const { error } = await sb.from('leaderboard_history').insert(historyRecord)
    if (!error) {
      archived++
      if (archived <= 20) {
        console.log(`  ✓ ${trader.source_trader_id.slice(0, 10)}... (${trader.season_id})`)
      }
    } else {
      console.log(`  ✗ ${trader.source_trader_id.slice(0, 10)}...: ${error.message}`)
    }
  }
}

console.log(`\n  ✓ Archived ${archived}/${droppedTraders.length} traders\n`)

// ============================================
// Step 4: Optional cleanup
// ============================================
console.log('Step 4: Cleanup leaderboard_ranks...\n')

if (DRY_RUN) {
  console.log(`  [DRY] Would delete ${droppedTraders.length} dropped traders from leaderboard_ranks\n`)
} else {
  const idsToDelete = droppedTraders.map(t => t.id)
  
  // Delete in batches
  const batchSize = 100
  let deleted = 0
  
  for (let i = 0; i < idsToDelete.length; i += batchSize) {
    const batch = idsToDelete.slice(i, i + batchSize)
    const { error } = await sb.from('leaderboard_ranks').delete().in('id', batch)
    if (!error) {
      deleted += batch.length
    }
  }
  
  console.log(`  ✓ Deleted ${deleted} traders from leaderboard_ranks\n`)
}

// ============================================
// Step 5: Verify
// ============================================
console.log('Step 5: Verification...\n')

const { count: currentCount } = await sb
  .from('leaderboard_ranks')
  .select('*', { count: 'exact', head: true })
  .eq('source', 'binance_web3')

const { count: historyCount } = await sb
  .from('leaderboard_history')
  .select('*', { count: 'exact', head: true })
  .eq('source', 'binance_web3')

console.log(`  Binance Web3 current: ${currentCount}`)
console.log(`  Binance Web3 history: ${historyCount || 0}`)
console.log(`  API current traders: ${currentTraders.size}`)

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('✅ Migration Complete')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

console.log('Next steps:')
console.log('1. Deploy archive-dropped-traders.mjs to daily cron')
console.log('2. Update enrichment scripts to check both tables')
console.log('3. Monitor archive growth\n')
