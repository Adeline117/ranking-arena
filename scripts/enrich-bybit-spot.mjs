#!/usr/bin/env node
/**
 * Enrich Bybit Spot trader_snapshots with multi-period metrics
 *
 * Strategy:
 *   1. Fetch all bybit_spot rows missing key metrics (roi_7d, roi_30d, etc.)
 *   2. Use Puppeteer to paginate listing API and get leaderUserId → leaderMark map
 *   3. Call leader-income API for each trader to get detailed metrics
 *   4. Update trader_snapshots with 7d/30d/90d ROI, PnL, win rate, MDD, etc.
 *
 * API Endpoints:
 *   - List: https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list
 *   - Income: https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=<base64>
 *
 * Usage:
 *   node scripts/enrich-bybit-spot.mjs
 *   node scripts/enrich-bybit-spot.mjs --dry-run
 *   node scripts/enrich-bybit-spot.mjs --limit=50
 *   node scripts/enrich-bybit-spot.mjs --concurrency=8
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || 0
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 5
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const INCOME_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income'
const LIST_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list'

function parseMetrics(result) {
  // Store even 0 values — 0% ROI in 7d is valid (no activity in that period)
  // Skip only if truly empty profile (no cumulative activity)
  const cumTrade = parseInt(result.cumTradeCount || '0')
  const cumYield = parseInt(result.cumYieldE8 || '0')
  if (cumTrade === 0 && cumYield === 0) return {}

  const metrics = {}
  
  // ROI (E4 = divide by 100 for percentage)
  if (result.sevenDayYieldRateE4 != null) 
    metrics.roi_7d = parseFloat((parseInt(result.sevenDayYieldRateE4) / 100).toFixed(2))
  if (result.thirtyDayYieldRateE4 != null) 
    metrics.roi_30d = parseFloat((parseInt(result.thirtyDayYieldRateE4) / 100).toFixed(2))
  if (result.ninetyDayYieldRateE4 != null)
    metrics.roi_90d = parseFloat((parseInt(result.ninetyDayYieldRateE4) / 100).toFixed(2))
  if (result.cumYieldRateE4 != null)
    metrics.roi = parseFloat((parseInt(result.cumYieldRateE4) / 100).toFixed(2))
  
  // PnL (E8 = divide by 10^8 for USDT)
  if (result.sevenDayProfitE8 != null)
    metrics.pnl_7d = parseFloat((parseInt(result.sevenDayProfitE8) / 1e8).toFixed(4))
  if (result.thirtyDayProfitE8 != null)
    metrics.pnl_30d = parseFloat((parseInt(result.thirtyDayProfitE8) / 1e8).toFixed(4))
  if (result.ninetyDayProfitE8 != null)
    metrics.pnl_90d = parseFloat((parseInt(result.ninetyDayProfitE8) / 1e8).toFixed(4))
  if (result.cumClosedPnlE8 != null)
    metrics.pnl = parseFloat((parseInt(result.cumClosedPnlE8) / 1e8).toFixed(4))
  
  // Win Rate (E4 = divide by 100 for percentage)
  if (result.sevenDayProfitWinRateE4 != null)
    metrics.win_rate_7d = parseFloat((parseInt(result.sevenDayProfitWinRateE4) / 100).toFixed(2))
  if (result.thirtyDayProfitWinRateE4 != null)
    metrics.win_rate_30d = parseFloat((parseInt(result.thirtyDayProfitWinRateE4) / 100).toFixed(2))
  if (result.ninetyDayProfitWinRateE4 != null)
    metrics.win_rate_90d = parseFloat((parseInt(result.ninetyDayProfitWinRateE4) / 100).toFixed(2))
  
  // Max Drawdown (E4 = divide by 100, already negative)
  if (result.sevenDayDrawDownE4 != null)
    metrics.max_drawdown_7d = parseFloat((parseInt(result.sevenDayDrawDownE4) / 100).toFixed(2))
  if (result.thirtyDayDrawDownE4 != null)
    metrics.max_drawdown_30d = parseFloat((parseInt(result.thirtyDayDrawDownE4) / 100).toFixed(2))
  if (result.ninetyDayDrawDownE4 != null)
    metrics.max_drawdown_90d = parseFloat((parseInt(result.ninetyDayDrawDownE4) / 100).toFixed(2))
  
  // Other metrics
  if (result.cumTradeCount != null)
    metrics.trades_count = parseInt(result.cumTradeCount)
  if (result.currentFollowerCount != null || result.cumFollowerNum != null)
    metrics.followers = parseInt(result.currentFollowerCount || result.cumFollowerNum || '0')
  if (result.aumE8 != null)
    metrics.aum = parseFloat((parseInt(result.aumE8) / 1e8).toFixed(2))
  
  // Sharpe ratio (E4 = divide by 10000 for decimal)
  if (result.thirtyDaySharpeRatioE4 != null)
    metrics.sharpe_ratio = parseFloat((parseInt(result.thirtyDaySharpeRatioE4) / 10000).toFixed(4))

  return metrics
}

async function fetchLeaderIncome(leaderMark) {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(
        `${INCOME_URL}?leaderMark=${encodeURIComponent(leaderMark)}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }
      )
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      const json = await res.json()
      if (json.retCode !== 0) return null
      return json.result
    } catch { if (i < 1) await sleep(500) }
  }
  return null
}

async function updateRows(rows, metrics) {
  let updated = 0
  for (const row of rows) {
    const updates = {}
    
    // Only update fields that are currently null
    for (const [key, value] of Object.entries(metrics)) {
      if (row[key] == null && value != null) {
        updates[key] = value
      }
    }
    
    if (!Object.keys(updates).length) continue

    if (DRY_RUN) {
      console.log(`  [DRY] ${row.source_trader_id} row ${row.id}:`, updates)
      updated++
    } else {
      const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) updated++
      else console.error(`  Update error row ${row.id}:`, error.message)
    }
  }
  return updated
}

// Parallel processing with semaphore
async function processParallel(traders, processFn, concurrency) {
  let updated = 0, skipped = 0, done = 0
  const total = traders.length

  async function worker(batch) {
    for (const item of batch) {
      const n = await processFn(item)
      if (n > 0) updated += n
      else skipped++
      done++
      if (done % 50 === 0 || done === total)
        process.stdout.write(`\r  Progress: ${done}/${total} | updated=${updated} skipped=${skipped}    `)
    }
  }

  const batchSize = Math.ceil(traders.length / concurrency)
  const batches = []
  for (let i = 0; i < concurrency; i++) {
    const batch = traders.slice(i * batchSize, (i + 1) * batchSize)
    if (batch.length) batches.push(worker(batch))
  }
  await Promise.all(batches)
  console.log()
  return updated
}

async function main() {
  console.log('═══ Bybit Spot — Multi-period metrics enrichment ═══')
  if (DRY_RUN) console.log('[DRY RUN]\n')

  const { count: before } = await supabase.from('trader_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'bybit_spot')
    .is('roi_7d', null)
  console.log(`BEFORE: bybit_spot roi_7d NULL = ${before}`)

  // Fetch all rows needing enrichment
  let allRows = [], offset = 0
  while (true) {
    const { data } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d, pnl_7d, pnl_30d, win_rate_7d, win_rate_30d, max_drawdown_7d, max_drawdown_30d, trades_count, followers, aum, sharpe_ratio')
      .eq('source', 'bybit_spot')
      .is('roi_7d', null)
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  console.log(`Total rows to enrich: ${allRows.length}`)

  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }
  let needUIDs = Array.from(traderMap.keys())
  if (LIMIT) needUIDs = needUIDs.slice(0, LIMIT)
  console.log(`Unique traders: ${needUIDs.length}`)

  // Launch Puppeteer
  let puppeteer, StealthPlugin
  try {
    const m1 = await import('puppeteer-extra')
    const m2 = await import('puppeteer-extra-plugin-stealth')
    puppeteer = m1.default; StealthPlugin = m2.default
    puppeteer.use(StealthPlugin())
  } catch (e) {
    console.error('Puppeteer not available:', e.message)
    console.error('Install: npm install puppeteer-extra puppeteer-extra-plugin-stealth')
    process.exit(1)
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)

  console.log('\n━━━ Fetching leaderUserId → leaderMark mapping ━━━')
  
  // Navigate to get cookie/session
  try {
    await page.goto('https://www.bybit.com/copyTrading/traderRanking', {
      waitUntil: 'domcontentloaded', timeout: 30000
    })
    await sleep(2000)
  } catch (e) {
    console.log('  Initial nav note:', e.message.slice(0, 60))
  }

  // Paginate listing API to collect all trader mappings
  const uidToMark = new Map()
  let pageNo = 1
  const maxPages = Math.ceil(needUIDs.length / 50) + 5 // +5 buffer
  
  while (pageNo <= maxPages && uidToMark.size < needUIDs.length) {
    const url = `${LIST_URL}?dataType=1&timeStamp=3&sortType=1&pageNo=${pageNo}&pageSize=50`
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 })
      if (!resp?.ok()) {
        console.log(`  Page ${pageNo}: HTTP ${resp?.status()}`)
        if (resp?.status() === 403) {
          console.error('  ❌ Geo-restricted or auth required')
          break
        }
        await sleep(2000)
        continue
      }
      
      const text = await page.evaluate(() => document.body?.innerText || '')
      if (!text || text.startsWith('<')) {
        console.log(`  Page ${pageNo}: No JSON`)
        await sleep(1000)
        continue
      }
      
      const json = JSON.parse(text)
      if (json.retCode !== 0 || !json.result?.dataList) {
        console.log(`  Page ${pageNo}: No data`)
        break
      }
      
      let foundNew = 0
      for (const trader of json.result.dataList) {
        if (trader.leaderUserId && trader.leaderMark && needUIDs.includes(trader.leaderUserId)) {
          uidToMark.set(trader.leaderUserId, trader.leaderMark)
          foundNew++
        }
      }
      
      process.stdout.write(`\r  Page ${pageNo}: +${foundNew} traders, total mapped: ${uidToMark.size}/${needUIDs.length}    `)
      
      if (json.result.dataList.length < 50) break // Last page
      pageNo++
      await sleep(800) // Rate limit
      
    } catch (e) {
      console.log(`\n  Page ${pageNo} error:`, e.message.slice(0, 60))
      await sleep(2000)
    }
  }
  
  await browser.close()
  console.log(`\n  Mapping complete: ${uidToMark.size}/${needUIDs.length} traders`)

  if (uidToMark.size === 0) {
    console.error('\n❌ Failed to fetch trader mapping. Check geo-restrictions or API changes.')
    process.exit(1)
  }

  // Process traders with mapped IDs
  console.log('\n━━━ Fetching income data for mapped traders ━━━')
  const mappedTraders = Array.from(uidToMark.entries()).map(([uid, mark]) => ({
    uid, mark, rows: traderMap.get(uid)
  }))
  
  const updated = await processParallel(mappedTraders, async ({ mark, rows }) => {
    const result = await fetchLeaderIncome(mark)
    if (!result) return 0
    const metrics = parseMetrics(result)
    if (!Object.keys(metrics).length) return 0
    return await updateRows(rows, metrics)
  }, CONCURRENCY)

  console.log(`\n✅ Enrichment complete: ${updated} rows updated`)

  // Final stats
  if (!DRY_RUN) {
    const { count: after } = await supabase.from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'bybit_spot')
      .is('roi_7d', null)
    console.log(`AFTER: bybit_spot roi_7d NULL = ${after}`)
    console.log(`Progress: ${before - after} rows enriched`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
