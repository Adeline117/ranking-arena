/**
 * Enrich Weex traders with Win Rate via Playwright API interception
 * Strategy: Navigate to copy-trading page, intercept traderListView responses
 * across all data ranges (7D/30D/90D) and pages by clicking through the UI.
 */
import { chromium } from 'playwright'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const PROXY = 'http://127.0.0.1:7890'

async function main() {
  console.log('Weex WR enrichment v3 (interception-only)\n')

  const { data: dbTraders } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown, roi, pnl')
    .eq('source', 'weex')

  console.log(`DB: ${dbTraders.length} rows`)
  const needWR = dbTraders.filter(r => r.win_rate == null)
  console.log(`Need WR: ${needWR.length}`)
  if (!needWR.length) { console.log('Nothing to do'); return }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })

  // wrData: traderId -> winRate
  const wrData = new Map()
  let interceptCount = 0

  const page = await ctx.newPage()
  page.on('response', async (r) => {
    if (!r.url().includes('traderListView') && !r.url().includes('topTraderListView')) return
    try {
      const json = await r.json()
      if (json.code !== 'SUCCESS') return
      interceptCount++
      for (const item of (json.data?.rows || [])) {
        const id = String(item.traderUserId || '')
        if (!id) continue
        for (const col of (item.itemVoList || [])) {
          if ((col.showColumnDesc || '').toLowerCase().includes('win rate')) {
            const val = parseFloat(col.showColumnValue)
            if (!isNaN(val) && val >= 0 && val <= 100) wrData.set(id, val)
          }
        }
      }
    } catch {}
  })

  // Navigate and let it load
  console.log('Loading copy-trading page...')
  await page.goto('https://www.weex.com/copy-trading', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await sleep(15000)
  console.log(`After initial load: ${wrData.size} traders (${interceptCount} API calls)`)

  // Try scrolling to trigger more loads
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(3000)
  }
  console.log(`After scrolling: ${wrData.size} traders (${interceptCount} API calls)`)

  // Try clicking "next page" if available
  for (let i = 0; i < 5; i++) {
    try {
      const next = await page.$('.ant-pagination-next:not(.ant-pagination-disabled), [class*="next"]:not([disabled]), button:has-text("Next")')
      if (!next) break
      await next.click()
      await sleep(5000)
    } catch { break }
  }
  console.log(`After pagination: ${wrData.size} traders (${interceptCount} API calls)`)

  // Also try different data range tabs (7D, 30D, 90D)
  for (const range of ['7 Days', '30 Days', '90 Days', '7D', '30D', '90D']) {
    try {
      const tab = await page.$(`text="${range}"`)
      if (tab) {
        await tab.click()
        await sleep(8000)
        // Scroll again
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
          await sleep(2000)
        }
      }
    } catch {}
  }
  console.log(`After all tabs: ${wrData.size} traders (${interceptCount} API calls)`)

  await browser.close()

  // Update DB
  let updated = 0
  for (const row of needWR) {
    const wr = wrData.get(row.source_trader_id)
    if (wr == null) continue
    const updateObj = { win_rate: Math.round(wr * 100) / 100 }
    updateObj.arena_score = calculateArenaScore(row.roi, row.pnl, row.max_drawdown, wr, row.season_id).totalScore
    const { error } = await supabase.from('trader_snapshots').update(updateObj)
      .eq('source', 'weex').eq('source_trader_id', row.source_trader_id).eq('season_id', row.season_id)
    if (!error) updated++
  }
  console.log(`\n✅ Updated ${updated} snapshot rows`)

  // Also update leaderboard_ranks
  const { data: lrRows } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate')
    .eq('source', 'weex')
    .is('win_rate', null)
  
  let lrUpdated = 0
  for (const row of (lrRows || [])) {
    const wr = wrData.get(row.source_trader_id)
    if (wr == null) continue
    const { error } = await supabase.from('leaderboard_ranks').update({ win_rate: Math.round(wr * 100) / 100 }).eq('id', row.id)
    if (!error) lrUpdated++
  }
  console.log(`✅ Updated ${lrUpdated} leaderboard_ranks rows`)

  // Verify
  for (const table of ['trader_snapshots', 'leaderboard_ranks']) {
    console.log(`\n${table}:`)
    for (const period of ['7D', '30D', '90D']) {
      const { data: v } = await supabase.from(table).select('win_rate,max_drawdown')
        .eq('source', 'weex').eq('season_id', period)
      const t = v.length, wr = v.filter(r => r.win_rate != null).length
      console.log(`  ${period}: ${t} | WR: ${wr}/${t} (${Math.round(100 * wr / t)}%)`)
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
