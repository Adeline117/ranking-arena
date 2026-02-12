/**
 * Enrich Binance Spot trader_snapshots with win_rate and trades_count
 * 
 * Since the Binance Spot API doesn't expose winRate/tradesCount directly,
 * we compute them from the listing API's chart data:
 * - win_rate: % of days with positive ROI change (from chartItems)
 * - trades_count: tradingDays from the API
 * 
 * Usage: node scripts/import/enrich_binance_spot_v2.mjs [7D|30D|90D|ALL]
 * 
 * NOTE: Run from VPS (Singapore) - Binance geo-blocks US IPs.
 */

import {
  getSupabaseClient,
  sleep,
  getTargetPeriods,
} from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'binance_spot'
const API_URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list'
const PER_PAGE = 100
const MAX_PAGES = 25

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Encoding': 'identity',
}

function computeWinRate(chartItems) {
  if (!chartItems || chartItems.length < 2) return null
  let wins = 0, losses = 0
  for (let i = 1; i < chartItems.length; i++) {
    const delta = chartItems[i].value - chartItems[i - 1].value
    if (delta > 0) wins++
    else if (delta < 0) losses++
  }
  const total = wins + losses
  if (total === 0) return null
  return parseFloat((wins / total * 100).toFixed(2))
}

async function fetchAllTraders(period) {
  const traders = new Map()
  
  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          pageNumber: page,
          pageSize: PER_PAGE,
          timeRange: period,
          dataType: 'ROI',
          order: 'DESC',
        }),
        signal: AbortSignal.timeout(15000),
      })
      
      const json = await res.json()
      if (json.code !== '000000' || !json.data) {
        console.log(`  Page ${page}: API error ${json.code} - ${json.message}`)
        break
      }
      
      const list = json.data.list || []
      if (list.length === 0) break
      
      for (const item of list) {
        const id = String(item.leadPortfolioId || '')
        if (!id || traders.has(id)) continue
        
        const winRate = computeWinRate(item.chartItems)
        traders.set(id, {
          traderId: id,
          winRate,
          tradingDays: item.tradingDays || null,
        })
      }
      
      const total = json.data.total || 0
      console.log(`  Page ${page}: +${list.length}, total ${traders.size}/${total}`)
      
      if (traders.size >= total) break
      await sleep(500)
    } catch (e) {
      console.log(`  Page ${page} error: ${e.message}`)
      break
    }
  }
  
  return traders
}

async function enrichPeriod(period) {
  console.log(`\n=== Enriching ${SOURCE} ${period} ===`)
  
  // Fetch all traders from API
  console.log('  Fetching traders from listing API...')
  const apiTraders = await fetchAllTraders(period)
  console.log(`  Fetched ${apiTraders.size} traders from API`)
  
  if (apiTraders.size === 0) return 0
  
  // Get snapshots needing enrichment (paginate)
  let missing = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, win_rate, trades_count')
      .eq('source', SOURCE)
      .eq('season_id', period)
      .or('win_rate.is.null,trades_count.is.null')
      .range(from, from + PAGE - 1)
    if (error) { console.error(`  DB Error: ${error.message}`); return 0 }
    missing = missing.concat(data || [])
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  
  console.log(`  Found ${missing.length} snapshots needing enrichment`)
  if (!missing.length) return 0
  
  let updated = 0
  let matched = 0
  
  // Batch updates for efficiency
  const BATCH = 50
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    
    for (const snap of batch) {
      const apiData = apiTraders.get(snap.source_trader_id)
      if (!apiData) continue
      matched++
      
      const updates = {}
      if (snap.win_rate == null && apiData.winRate != null) {
        updates.win_rate = apiData.winRate
      }
      if (snap.trades_count == null && apiData.tradingDays != null && apiData.tradingDays > 0) {
        updates.trades_count = apiData.tradingDays
      }
      
      if (Object.keys(updates).length > 0) {
        const { error } = await supabase
          .from('trader_snapshots')
          .update(updates)
          .eq('id', snap.id)
        if (!error) updated++
      }
    }
    
    if ((i + BATCH) % 200 === 0 || i + BATCH >= missing.length) {
      console.log(`  Progress: ${Math.min(i + BATCH, missing.length)}/${missing.length} | matched: ${matched} | updated: ${updated}`)
    }
  }
  
  console.log(`  ✅ Updated ${updated}/${missing.length} (matched ${matched} from API)`)
  return updated
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log('Binance Spot Enrichment v2 (win_rate from chart, trades_count from tradingDays)')
  console.log('Periods:', periods.join(', '))
  
  // Before stats
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
  
  // After stats
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
