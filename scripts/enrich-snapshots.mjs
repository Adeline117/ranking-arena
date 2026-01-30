#!/usr/bin/env node
/**
 * enrich-snapshots.mjs — 用 connector API 补齐 snapshot 缺失字段
 *
 * 重新调各平台 leaderboard API，用返回数据更新缺失的 pnl/win_rate/max_drawdown/trades_count
 *
 * Usage: node scripts/enrich-snapshots.mjs [--source=xxx] [--dry-run]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { resolve } from 'path'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null

// Dynamic import connectors (TypeScript needs tsx)
async function loadConnector(name) {
  // Use the compiled connector via tsx
  try {
    const mod = await import(`../connectors/${name}/index.ts`)
    return mod
  } catch (e) {
    console.log(`  ⚠ Cannot load connector ${name}: ${e.message}`)
    return null
  }
}

// Map source names to connector module names + class names
const CONNECTOR_MAP = {
  binance_futures: { module: 'binance', class: 'BinanceFuturesConnector' },
  bybit: { module: 'bybit', class: 'BybitConnector' },
  bitget_futures: { module: 'bitget', class: 'BitgetFuturesConnector' },
  mexc: { module: 'mexc', class: 'MexcConnector' },
  kucoin: { module: 'kucoin', class: 'KuCoinConnector' },
  coinex: { module: 'coinex', class: 'CoinExConnector' },
  okx_futures: { module: 'okx', class: 'OkxFuturesConnector' },
  htx_futures: { module: 'htx', class: 'HtxFuturesConnector' },
}

async function enrichSource(source, connectorInfo) {
  console.log(`\n🔄 ${source}`)
  
  // Check what's missing
  const { count: totalSnaps } = await supabase.from('trader_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('source', source)
  
  const missingFields = {}
  for (const field of ['pnl', 'win_rate', 'max_drawdown', 'trades_count']) {
    const { count } = await supabase.from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('source', source)
      .is(field, null)
    missingFields[field] = count
  }
  
  console.log(`  Total snapshots: ${totalSnaps}`)
  console.log(`  Missing: pnl=${missingFields.pnl}, wr=${missingFields.win_rate}, dd=${missingFields.max_drawdown}, trades=${missingFields.trades_count}`)
  
  if (Object.values(missingFields).every(v => v === 0)) {
    console.log(`  ✅ All fields complete`)
    return
  }
  
  // Load connector and fetch leaderboard
  const mod = await loadConnector(connectorInfo.module)
  if (!mod || !mod[connectorInfo.class]) {
    console.log(`  ⚠ Connector not available`)
    return
  }
  
  const ConnectorClass = mod[connectorInfo.class]
  const connector = new ConnectorClass()
  
  // Fetch leaderboard for different windows
  const windows = ['90d', '30d', '7d']
  const allEntries = new Map() // trader_key → best metrics
  
  for (const window of windows) {
    try {
      console.log(`  Fetching ${window} leaderboard...`)
      const result = await connector.discoverLeaderboard(window, 200)
      if (result.success && result.data) {
        console.log(`    Got ${result.data.length} entries`)
        for (const entry of result.data) {
          const key = entry.trader_key
          const metrics = entry.metrics || {}
          
          if (!allEntries.has(key)) {
            allEntries.set(key, { windows: {} })
          }
          allEntries.get(key).windows[window] = metrics
        }
      }
    } catch (e) {
      console.log(`    ⚠ ${window} failed: ${e.message}`)
    }
  }
  
  console.log(`  Total traders from API: ${allEntries.size}`)
  
  // Update snapshots with missing data
  let updated = 0
  for (const [traderId, data] of allEntries) {
    // Get existing snapshots for this trader
    const { data: snapshots } = await supabase.from('trader_snapshots')
      .select('id, season_id, pnl, win_rate, max_drawdown, trades_count')
      .eq('source', source)
      .eq('source_trader_id', traderId)
    
    if (!snapshots?.length) continue
    
    for (const snap of snapshots) {
      const seasonKey = snap.season_id === '7D' ? '7d' : snap.season_id === '30D' ? '30d' : '90d'
      const metrics = data.windows[seasonKey] || data.windows['90d'] || data.windows['30d'] || Object.values(data.windows)[0]
      if (!metrics) continue
      
      const updates = {}
      if (snap.pnl === null && metrics.pnl_usd != null) updates.pnl = metrics.pnl_usd
      if (snap.win_rate === null && metrics.win_rate != null) updates.win_rate = metrics.win_rate
      if (snap.max_drawdown === null && metrics.max_drawdown != null) updates.max_drawdown = metrics.max_drawdown
      if (snap.trades_count === null && metrics.trades_count != null) updates.trades_count = metrics.trades_count
      
      if (Object.keys(updates).length === 0) continue
      
      if (!DRY_RUN) {
        const { error } = await supabase.from('trader_snapshots')
          .update(updates)
          .eq('id', snap.id)
        if (!error) updated++
      } else {
        updated++
      }
    }
  }
  
  console.log(`  ✅ ${updated} snapshots enriched ${DRY_RUN ? '(DRY RUN)' : ''}`)
}

async function main() {
  console.log(`\n📊 Snapshot Enrichment ${DRY_RUN ? '(DRY RUN)' : ''}\n`)
  
  const sources = SOURCE_FILTER 
    ? { [SOURCE_FILTER]: CONNECTOR_MAP[SOURCE_FILTER] }
    : CONNECTOR_MAP
  
  for (const [source, info] of Object.entries(sources)) {
    if (!info) { console.log(`⚠ No connector for ${source}`); continue }
    await enrichSource(source, info)
  }
  
  // Final stats
  console.log('\n═══ Final Stats ═══')
  for (const field of ['pnl', 'win_rate', 'max_drawdown', 'trades_count']) {
    const { count: total } = await supabase.from('trader_snapshots').select('id', { count: 'exact', head: true })
    const { count: filled } = await supabase.from('trader_snapshots').select('id', { count: 'exact', head: true }).not(field, 'is', null)
    console.log(`  ${field.padEnd(16)} ${filled}/${total} (${Math.round(filled/total*100)}%)`)
  }
}

main().catch(console.error)
