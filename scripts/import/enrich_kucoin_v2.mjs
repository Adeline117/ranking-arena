/**
 * KuCoin Enrichment v2 — WR/MDD from API trade data
 * 
 * Fetches real trade history and PnL curves from KuCoin's copy-trading API,
 * then computes win rate and max drawdown from actual data.
 * 
 * Win Rate: from positionHistory (closePnl > 0 = win)
 * Max Drawdown: from pnl/history cumulative ratio curve
 * 
 * Usage: node scripts/import/enrich_kucoin_v2.mjs
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

puppeteer.use(StealthPlugin())

const supabase = getSupabaseClient()
const CONCURRENCY = 3
const DELAY_MS = 800

// Compute win rate from position history
function computeWinRate(positions) {
  if (!positions || positions.length === 0) return null
  const wins = positions.filter(p => parseFloat(p.closePnl) > 0).length
  return (wins / positions.length) * 100
}

// Compute MDD from cumulative PnL ratio curve
function computeMDD(pnlHistory) {
  if (!pnlHistory || pnlHistory.length < 2) return null
  
  const ratios = pnlHistory.map(p => parseFloat(p.ratio))
  let peak = ratios[0]
  let maxDD = 0
  
  for (const ratio of ratios) {
    if (ratio > peak) peak = ratio
    const dd = peak - ratio
    if (dd > maxDD) maxDD = dd
  }
  
  // Convert to percentage (ratios are already in percentage form, e.g. 9.17 = 917%)
  // MDD as percentage points of the ratio
  return maxDD * 100
}

async function main() {
  console.log('=== KuCoin Enrichment v2: WR/MDD from API ===\n')
  
  // Get all KuCoin traders missing WR or MDD
  const { data: traders, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'kucoin')
    .or('win_rate.is.null,max_drawdown.is.null')
  
  if (error) {
    console.error('DB error:', error.message)
    process.exit(1)
  }
  
  console.log(`Found ${traders.length} traders needing enrichment`)
  
  if (traders.length === 0) {
    console.log('Nothing to do!')
    process.exit(0)
  }
  
  // Deduplicate by source_trader_id (may have multiple seasons)
  const uniqueIds = [...new Set(traders.map(t => t.source_trader_id))]
  console.log(`Unique trader IDs: ${uniqueIds.length}`)
  
  // Launch browser to get session cookies
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  
  // Load the copytrading page to establish session
  console.log('Loading KuCoin copytrading page...')
  await page.goto('https://www.kucoin.com/copytrading', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('Session established\n')
  
  // Process traders in batches
  let enriched = 0, failed = 0, noData = 0
  
  for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
    const batch = uniqueIds.slice(i, i + CONCURRENCY)
    
    const results = await Promise.all(batch.map(async (traderId) => {
      try {
        const [posResult, pnlResult] = await Promise.all([
          page.evaluate(async (id) => {
            const r = await fetch(`/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?leadConfigId=${id}&period=90d&lang=en_US`)
            return r.json()
          }, traderId),
          page.evaluate(async (id) => {
            const r = await fetch(`/_api/ct-copy-trade/v1/copyTrading/leadShow/pnl/history?leadConfigId=${id}&period=90d&lang=en_US`)
            return r.json()
          }, traderId),
        ])
        
        const positions = posResult.success ? posResult.data : null
        const pnlHistory = pnlResult.success ? pnlResult.data : null
        
        const winRate = computeWinRate(positions)
        const maxDrawdown = computeMDD(pnlHistory)
        
        return { traderId, winRate, maxDrawdown, tradeCount: positions?.length || 0 }
      } catch (e) {
        return { traderId, error: e.message }
      }
    }))
    
    // Update DB for each result
    for (const r of results) {
      if (r.error) {
        failed++
        continue
      }
      
      if (r.winRate === null && r.maxDrawdown === null) {
        noData++
        continue
      }
      
      // Find all snapshots for this trader
      const traderSnapshots = traders.filter(t => t.source_trader_id === r.traderId)
      
      for (const snap of traderSnapshots) {
        const updates = {}
        if (r.winRate !== null && snap.win_rate === null) updates.win_rate = Math.round(r.winRate * 100) / 100
        if (r.maxDrawdown !== null && snap.max_drawdown === null) updates.max_drawdown = Math.round(r.maxDrawdown * 100) / 100
        
        if (Object.keys(updates).length === 0) continue
        
        // Recalculate arena score with new data
        const newWR = updates.win_rate ?? snap.win_rate
        const newMDD = updates.max_drawdown ?? snap.max_drawdown
        const score = calculateArenaScore(snap.roi, snap.pnl, newMDD, newWR, snap.season_id)
        updates.arena_score = score.totalScore
        
        const { error: updateError } = await supabase
          .from('trader_snapshots')
          .update(updates)
          .eq('source', 'kucoin')
          .eq('source_trader_id', r.traderId)
          .eq('season_id', snap.season_id)
        
        if (updateError) {
          console.error(`  ✗ ${r.traderId}/${snap.season_id}: ${updateError.message}`)
          failed++
        } else {
          enriched++
        }
      }
      
      if (i % 30 === 0 || i + CONCURRENCY >= uniqueIds.length) {
        console.log(`Progress: ${i + batch.length}/${uniqueIds.length} | enriched=${enriched} noData=${noData} failed=${failed}`)
      }
    }
    
    await sleep(DELAY_MS)
  }
  
  await browser.close()
  
  console.log(`\n=== Done ===`)
  console.log(`Enriched: ${enriched}`)
  console.log(`No data: ${noData}`)
  console.log(`Failed: ${failed}`)
  
  // Verify
  const { data: verify } = await supabase
    .from('trader_snapshots')
    .select('season_id')
    .eq('source', 'kucoin')
    .not('win_rate', 'is', null)
  
  console.log(`\nTotal KuCoin traders with WR: ${verify?.length || 0}`)
}

main().catch(console.error)
