#!/usr/bin/env node
/**
 * Enrich All Traders - Current + Historical
 * 
 * Searches both leaderboard_ranks and leaderboard_history
 * Uses connector layer for data fetching
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

function parseNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace('%', '').trim())
  return isNaN(n) ? null : n
}

// Simple connector implementations
const CONNECTORS = {
  async htx_futures(traderId) {
    const url = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=1&pageSize=50'
    const resp = await fetch(url)
    const json = await resp.json()
    
    if (json.code !== 200) return null
    
    const item = (json.data?.itemList || []).find(t => 
      (t.userSign || '').replace(/=+$/, '') === traderId
    )
    
    if (!item) return null
    
    let wr = parseNum(item.winRate)
    if (wr != null && wr > 0 && wr <= 1) wr = wr * 100
    
    return {
      win_rate: wr,
      max_drawdown: Math.abs(parseNum(item.mdd)),
      avatar_url: item.imgUrl,
      roi: parseNum(item.roi),
      pnl: parseNum(item.pnl),
    }
  },

  async binance_web3(traderId, seasonId = '30D') {
    const periodMap = { '7D': '7d', '30D': '30d', '90D': '90d' }
    const period = periodMap[seasonId] || '30d'
    
    // Try all chains
    for (const chainId of [56, 1, 8453]) {
      let page = 1
      while (page <= 20) {
        try {
          const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=${page}&pageSize=100&sortBy=0&orderBy=0&period=${period}&chainId=${chainId}`
          const resp = await fetch(url)
          const json = await resp.json()
          
          if (json.code !== '000000') break
          
          const item = (json.data?.data || []).find(t => 
            t.address.toLowerCase() === traderId.toLowerCase()
          )
          
          if (item) {
            let wr = parseNum(item.winRate)
            if (wr != null && wr > 0 && wr <= 1) wr = wr * 100
            
            let roi = parseNum(item.realizedPnlPercent)
            if (roi != null) roi = roi * 100
            
            return {
              win_rate: wr,
              trades_count: parseInt(item.totalTxCnt) || null,
              roi,
              pnl: parseNum(item.realizedPnl),
            }
          }
          
          if (json.data.data.length < 100) break
          page++
          await sleep(500)
        } catch { break }
      }
    }
    
    return null
  },

  // Add more connectors as needed
}

async function enrichSource(source) {
  console.log(`\n📊 Enriching ${source}...`)

  const connector = CONNECTORS[source]
  if (!connector) {
    console.log(`  ⚠️  No connector for ${source}`)
    return
  }

  // Get traders needing enrichment from BOTH tables
  const { data: currentTraders } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count, roi')
    .eq('source', source)
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .limit(100)

  const { data: historicalTraders } = await sb
    .from('leaderboard_history')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count, roi, enrichment_status')
    .eq('source', source)
    .eq('enrichment_status', 'pending')
    .limit(50)

  const totalNeeded = (currentTraders?.length || 0) + (historicalTraders?.length || 0)
  console.log(`  Current needs enrichment: ${currentTraders?.length || 0}`)
  console.log(`  Historical needs enrichment: ${historicalTraders?.length || 0}`)
  console.log(`  Total: ${totalNeeded}`)

  if (totalNeeded === 0) {
    console.log('  ✅ All enriched!')
    return
  }

  let updated = 0, failed = 0

  // Enrich current traders (priority)
  for (const trader of currentTraders || []) {
    try {
      const data = await connector(trader.source_trader_id, trader.season_id)
      
      if (!data) {
        failed++
        continue
      }

      const updates = {}
      if (trader.win_rate == null && data.win_rate != null) updates.win_rate = data.win_rate
      if (trader.max_drawdown == null && data.max_drawdown != null) updates.max_drawdown = data.max_drawdown
      if (trader.trades_count == null && data.trades_count != null) updates.trades_count = data.trades_count
      if (trader.roi == null && data.roi != null) updates.roi = data.roi

      if (Object.keys(updates).length === 0) continue

      if (!DRY_RUN) {
        await sb.from('leaderboard_ranks').update(updates).eq('id', trader.id)
      }

      updated++
      if (updated <= 10) {
        console.log(`  ✓ ${trader.source_trader_id.slice(0, 10)}... (current)`)
      }

      await sleep(200)
    } catch (e) {
      failed++
      console.log(`  ✗ ${trader.source_trader_id.slice(0, 10)}...: ${e.message.slice(0, 40)}`)
    }
  }

  // Enrich historical traders (lower priority)
  for (const trader of historicalTraders || []) {
    try {
      const data = await connector(trader.source_trader_id, trader.season_id)
      
      const updates = {}
      if (data) {
        if (trader.win_rate == null && data.win_rate != null) updates.win_rate = data.win_rate
        if (trader.max_drawdown == null && data.max_drawdown != null) updates.max_drawdown = data.max_drawdown
        if (trader.trades_count == null && data.trades_count != null) updates.trades_count = data.trades_count
        if (trader.roi == null && data.roi != null) updates.roi = data.roi
        updates.enrichment_status = 'complete'
      } else {
        updates.enrichment_status = 'api_unavailable'
      }

      if (!DRY_RUN) {
        await sb.from('leaderboard_history').update(updates).eq('id', trader.id)
      }

      updated++
      if (updated <= 10) {
        console.log(`  ✓ ${trader.source_trader_id.slice(0, 10)}... (historical)`)
      }

      await sleep(200)
    } catch (e) {
      if (!DRY_RUN) {
        await sb.from('leaderboard_history')
          .update({ enrichment_status: 'failed' })
          .eq('id', trader.id)
      }
      failed++
    }
  }

  console.log(`  ✅ Updated: ${updated}, Failed: ${failed}`)
}

async function main() {
  console.log('\n📊 Enrich All Traders (Current + Historical)\n')
  if (DRY_RUN) console.log('[DRY RUN]\n')

  const sources = SOURCES.length > 0 ? SOURCES : ['htx_futures', 'binance_web3']

  for (const source of sources) {
    await enrichSource(source)
  }

  console.log('\n✅ Enrichment complete\n')
}

main().catch(console.error)
