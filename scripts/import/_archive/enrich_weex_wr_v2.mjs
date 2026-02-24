/**
 * Enrich Weex traders with Win Rate (v2 - list interception only, no detail pages)
 * 
 * Strategy: Browse multiple sort views to intercept API responses containing WR data.
 * Avoid visiting individual detail pages (too slow, often hangs).
 */
import { chromium } from 'playwright'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const PROXY = 'http://127.0.0.1:7890'

async function main() {
  console.log('Weex WR enrichment v2\n')

  const { data: dbTraders } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown, roi, pnl')
    .eq('source', 'weex')

  console.log(`DB has ${dbTraders.length} weex snapshot rows`)
  const needIds = new Set(dbTraders.filter(r => r.win_rate == null).map(r => r.source_trader_id))
  console.log(`Need WR: ${needIds.size} traders`)
  if (!needIds.size) { console.log('Nothing to do'); return }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })

  const wrData = new Map()

  const page = await ctx.newPage()
  page.on('response', async (r) => {
    if (!r.url().includes('traderListView') && !r.url().includes('topTraderListView') && !r.url().includes('traderList')) return
    try {
      const json = await r.json()
      if (json.code !== 'SUCCESS' && json.code !== '0') return
      const rows = json.data?.rows || json.data?.list || json.data?.records || []
      for (const item of rows) {
        const id = String(item.traderUserId || item.userId || item.uid || '')
        if (!id) continue
        // Try itemVoList first
        for (const col of (item.itemVoList || [])) {
          if ((col.showColumnDesc || '').toLowerCase().includes('win rate')) {
            const val = parseFloat(col.showColumnValue)
            if (!isNaN(val) && val >= 0 && val <= 100) wrData.set(id, val)
          }
        }
        // Try direct fields
        if (!wrData.has(id)) {
          const wr = item.winRate ?? item.winRatio ?? item.profitableTradesPct
          if (wr != null) {
            const val = parseFloat(wr)
            if (!isNaN(val) && val >= 0) wrData.set(id, val > 1 ? val : val * 100)
          }
        }
      }
    } catch {}
  })

  // Visit main page and scroll through different sorts
  await page.goto('https://www.weex.com/copy-trading', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await sleep(12000)
  console.log(`After initial load: ${wrData.size} traders`)

  // Try scrolling to load more
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, 800))
    await sleep(2000)
  }
  console.log(`After scrolling: ${wrData.size} traders`)

  // Try clicking different tabs/sort options
  const tabs = await page.$$('[class*="tab"], [class*="sort"], [class*="filter"]').catch(() => [])
  for (const tab of tabs.slice(0, 10)) {
    try {
      await tab.click()
      await sleep(5000)
    } catch {}
  }
  console.log(`After tab clicks: ${wrData.size} traders`)

  // Try direct API calls from browser context
  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    try {
      await page.evaluate(async (pn) => {
        try {
          const r = await fetch(`/server-api/api/v1/copy-trading/traderListView?pageNum=${pn}&pageSize=50&sortColumn=roi&sortDirection=desc&timeRange=30`)
          return await r.json()
        } catch { return null }
      }, pageNum)
      await sleep(1000)
    } catch {}
  }
  console.log(`After API pagination: ${wrData.size} traders`)

  // Also try the detail API for each remaining trader from within browser
  const remaining = [...needIds].filter(id => !wrData.has(id))
  console.log(`\nFetching detail API for ${remaining.length} remaining traders...`)
  
  let detailCount = 0
  for (const id of remaining) {
    try {
      const result = await page.evaluate(async (uid) => {
        try {
          const r = await fetch(`/server-api/api/v1/copy-trading/traderDetail?traderUserId=${uid}`)
          const json = await r.json()
          if (json.code === 'SUCCESS' && json.data) {
            const wr = json.data.winRate ?? json.data.profitRate ?? json.data.winRatio
            if (wr != null) return parseFloat(wr)
          }
        } catch {}
        return null
      }, id)
      
      if (result != null && result >= 0) {
        wrData.set(id, result > 1 ? result : result * 100)
        detailCount++
      }
    } catch {}
    await sleep(500)
  }
  console.log(`Detail API: got ${detailCount} more`)

  await browser.close()
  console.log(`\nTotal WR data: ${wrData.size} traders`)

  // Update DB
  let updated = 0
  for (const row of dbTraders) {
    const wr = wrData.get(row.source_trader_id)
    if (wr == null || row.win_rate != null) continue

    const updateObj = { win_rate: Math.round(wr * 100) / 100 }
    updateObj.arena_score = calculateArenaScore(row.roi, row.pnl, row.max_drawdown, wr, row.season_id).totalScore

    const { error } = await supabase.from('trader_snapshots').update(updateObj)
      .eq('source', 'weex').eq('source_trader_id', row.source_trader_id).eq('season_id', row.season_id)
    if (!error) updated++
  }

  console.log(`✅ Updated ${updated} rows`)

  // Verify
  for (const period of ['7D', '30D', '90D']) {
    const { data: v } = await supabase.from('trader_snapshots').select('win_rate,max_drawdown')
      .eq('source', 'weex').eq('season_id', period)
    const t = v.length, wr = v.filter(r => r.win_rate != null).length, mdd = v.filter(r => r.max_drawdown != null).length
    console.log(`  ${period}: ${t} | WR: ${wr}/${t} (${Math.round(100 * wr / t)}%) | MDD: ${mdd}/${t} (${Math.round(100 * mdd / t)}%)`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
