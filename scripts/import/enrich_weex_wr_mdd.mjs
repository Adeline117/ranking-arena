/**
 * Enrich Weex traders with Win Rate and Max Drawdown
 * 
 * Strategy: Use Playwright to navigate the Weex copy-trading page,
 * intercept API responses that contain winRate/maxDrawdown data,
 * then try per-trader detail pages.
 * 
 * Usage: node scripts/import/enrich_weex_wr_mdd.mjs
 */
import { chromium } from 'playwright'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const PROXY = 'http://127.0.0.1:7890'

async function main() {
  console.log('Weex WR/MDD enrichment\n')

  const { data: dbTraders } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown, roi, pnl')
    .eq('source', 'weex')

  console.log(`DB has ${dbTraders.length} weex snapshot rows`)
  const traderIds = new Set(dbTraders.map(r => r.source_trader_id))
  console.log(`Unique traders: ${traderIds.size}`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await ctx.newPage()

  // Collect trader data from ALL API responses
  const traderData = new Map()
  
  page.on('response', async (r) => {
    const url = r.url()
    if (!url.includes('/trace/')) return
    try {
      const json = await r.json()
      if (json.code !== 'SUCCESS') return
      
      // Handle list responses
      const rows = json.data?.rows || []
      for (const item of rows) {
        const id = String(item.traderUserId || '')
        if (!id || !traderIds.has(id)) continue
        
        let wr = item.winRate != null ? parseFloat(String(item.winRate)) : null
        if (wr != null && wr > 0 && wr <= 1) wr *= 100
        let dd = item.maxDrawdown != null ? Math.abs(parseFloat(String(item.maxDrawdown))) : null
        if (dd != null && dd > 0 && dd <= 1) dd *= 100
        
        if (wr != null || dd != null) {
          traderData.set(id, { wr, dd })
        }
      }
      
      // Handle detail responses
      if (json.data?.traderUserId) {
        const id = String(json.data.traderUserId)
        if (!traderIds.has(id)) return
        let wr = json.data.winRate != null ? parseFloat(String(json.data.winRate)) : null
        if (wr != null && wr > 0 && wr <= 1) wr *= 100
        let dd = json.data.maxDrawdown != null ? Math.abs(parseFloat(String(json.data.maxDrawdown))) : null
        if (dd != null && dd > 0 && dd <= 1) dd *= 100
        if (wr != null || dd != null) {
          traderData.set(id, { wr, dd })
        }
      }
    } catch {}
  })

  // Load page and let it fetch data naturally
  console.log('Loading Weex copy-trading page...')
  await page.goto('https://www.weex.com/copy-trading', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await sleep(8000)
  console.log(`  Intercepted so far: ${traderData.size}`)

  // Click through sort options and scroll to trigger more API calls
  const sortSelectors = ['[data-sort]', '.sort-item', '.tab-item']
  for (const sel of sortSelectors) {
    try {
      const buttons = await page.$$(sel)
      for (const btn of buttons) {
        await btn.click().catch(() => {})
        await sleep(3000)
      }
    } catch {}
  }
  console.log(`  After sort clicks: ${traderData.size}`)

  // Scroll down repeatedly
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollBy(0, 800))
    await sleep(1500)
  }
  console.log(`  After scroll: ${traderData.size}`)

  // Try pagination by clicking "load more" or next page buttons
  for (let i = 0; i < 10; i++) {
    try {
      const nextBtn = await page.$('.pagination .next:not(.disabled), [class*="next"]:not([disabled]), button:has-text("Next")')
      if (nextBtn) {
        await nextBtn.click()
        await sleep(3000)
      } else break
    } catch { break }
  }
  console.log(`  After pagination: ${traderData.size}`)

  // Now try individual trader detail pages for remaining traders
  const stillNeed = [...traderIds].filter(id => !traderData.has(id))
  console.log(`\nStill need: ${stillNeed.length} traders. Trying detail pages...`)
  
  for (const id of stillNeed) {
    try {
      await page.goto(`https://www.weex.com/copy-trading/trader/${id}`, { timeout: 20000, waitUntil: 'domcontentloaded' })
      await sleep(5000)
    } catch {}
    if (traderData.has(id)) continue
    
    // Try alternate URL patterns
    try {
      await page.goto(`https://www.weex.com/copy-trading/detail/${id}`, { timeout: 15000, waitUntil: 'domcontentloaded' })
      await sleep(3000)
    } catch {}
    
    if (traderData.size % 10 === 0) console.log(`  Progress: ${traderData.size}/${traderIds.size}`)
  }

  console.log(`\nTotal enrichment data: ${traderData.size} traders`)
  await browser.close()

  // Update DB
  let updated = 0
  for (const row of dbTraders) {
    const data = traderData.get(row.source_trader_id)
    if (!data) continue
    const updateObj = {}
    if (data.wr != null && row.win_rate == null) updateObj.win_rate = Math.round(data.wr * 100) / 100
    if (data.dd != null && row.max_drawdown == null) updateObj.max_drawdown = Math.round(data.dd * 100) / 100
    if (!Object.keys(updateObj).length) continue
    const newWR = updateObj.win_rate ?? row.win_rate
    const newMDD = updateObj.max_drawdown ?? row.max_drawdown
    updateObj.arena_score = calculateArenaScore(row.roi, row.pnl, newMDD, newWR, row.season_id).totalScore
    const { error } = await supabase.from('trader_snapshots').update(updateObj)
      .eq('source', 'weex').eq('source_trader_id', row.source_trader_id).eq('season_id', row.season_id)
    if (!error) updated++
  }

  console.log(`\n✅ Updated ${updated} rows`)

  // Verify
  for (const period of ['7D', '30D', '90D']) {
    const { data: v } = await supabase.from('trader_snapshots').select('win_rate,max_drawdown')
      .eq('source', 'weex').eq('season_id', period)
    const t = v.length, wr = v.filter(r => r.win_rate != null).length, mdd = v.filter(r => r.max_drawdown != null).length
    console.log(`  ${period}: ${t} | WR: ${wr}/${t} (${Math.round(100*wr/t)}%) | MDD: ${mdd}/${t} (${Math.round(100*mdd/t)}%)`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
