/**
 * WEEX Copy Trading scraper (Playwright)
 *
 * URL: weex.com/copy-trading
 * Strategy: Load page, intercept API responses, scroll/paginate to trigger more loads.
 *   The API gateway (janapw.com) is cross-origin from weex.com, so we intercept
 *   browser responses rather than using page.evaluate fetch.
 *
 * Usage: node scripts/import/import_weex.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'weex'
const PROXY = 'http://127.0.0.1:7890'

function parseTrader(item) {
  const id = String(item.traderUserId || '')
  if (!id) return null

  let roi = 0
  if (item.totalReturnRate != null) {
    roi = parseFloat(String(item.totalReturnRate))
    if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100
  }

  const ratesByDays = {}
  if (Array.isArray(item.ndaysReturnRates)) {
    for (const r of item.ndaysReturnRates) {
      let rate = parseFloat(String(r.rate || 0))
      if (Math.abs(rate) > 0 && Math.abs(rate) < 1) rate *= 100
      ratesByDays[r.ndays] = rate
    }
  }

  let wr = item.winRate != null ? parseFloat(String(item.winRate)) : null
  if (wr != null && wr > 0 && wr <= 1) wr *= 100
  let dd = item.maxDrawdown != null ? Math.abs(parseFloat(String(item.maxDrawdown))) : null
  if (dd != null && dd > 0 && dd <= 1) dd *= 100

  return {
    id,
    name: item.traderNickName || item.nickName || `Trader_${id.slice(0, 8)}`,
    avatar: item.headPic || null,
    roi,
    roi7d: ratesByDays[7] || null,
    roi21d: ratesByDays[21] || roi,
    roi90d: ratesByDays[90] || null,
    pnl: parseFloat(String(item.threeWeeksPNL || item.profit || 0)),
    followers: parseInt(String(item.followCount || 0)),
    winRate: wr,
    maxDrawdown: dd,
  }
}

async function scrapeTraders() {
  console.log('WEEX: launching browser...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await ctx.newPage()
  const traders = new Map()
  let discoveredApiBase = null

  // Intercept all trader API responses
  page.on('response', async (r) => {
    const url = r.url()
    if (url.includes('traderListView') || url.includes('topTraderListView') || url.includes('traderList')) {
      const match = url.match(/^(https?:\/\/[^/]+)/)
      if (match) discoveredApiBase = match[1]
      try {
        const json = await r.json()
        if (json.code !== 'SUCCESS') return
        const rows = json.data?.rows || json.data?.list || (Array.isArray(json.data) ? json.data : [])
        for (const item of rows) {
          const t = parseTrader(item)
          if (t && !traders.has(t.id)) traders.set(t.id, t)
        }
      } catch {}
    }
  })

  await page.goto('https://www.weex.com/copy-trading', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await sleep(10000)
  console.log(`  Title: ${await page.title()}, intercepted: ${traders.size}`)
  if (discoveredApiBase) console.log(`  API gateway: ${discoveredApiBase}`)

  // Scroll to load more
  console.log('  Scrolling for more traders...')
  for (let i = 0; i < 30; i++) {
    const before = traders.size
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(2000)
    // Click pagination/load more buttons
    const nextBtn = page.locator('[class*="next"], [class*="more"], [class*="load"]').first()
    if (await nextBtn.count() > 0) await nextBtn.click().catch(() => {})
    await sleep(1000)
    if (traders.size > before) {
      console.log(`  Scroll ${i + 1}: ${traders.size} traders`)
    } else if (i > 5 && traders.size === before) {
      break
    }
  }

  // Try clicking different sort tabs to get more traders
  const sortTabs = await page.locator('[class*="sort"], [class*="filter"], [class*="tab"]').all()
  console.log(`  Found ${sortTabs.length} sort/filter elements`)
  for (const tab of sortTabs.slice(0, 10)) {
    try {
      const text = await tab.textContent()
      if (text && (text.includes('ROI') || text.includes('PNL') || text.includes('Follow') || text.includes('Win'))) {
        await tab.click()
        await sleep(3000)
        console.log(`  Clicked "${text.trim().slice(0,20)}": ${traders.size} traders`)
        // Scroll after switching sort
        for (let i = 0; i < 10; i++) {
          const before = traders.size
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
          await sleep(2000)
          if (traders.size === before && i > 2) break
        }
      }
    } catch {}
  }

  // If gateway found, try direct requests with node-fetch through proxy
  if (discoveredApiBase && traders.size < 200) {
    console.log('  Trying direct API requests...')
    const { HttpsProxyAgent } = await import('https-proxy-agent')
    const agent = new HttpsProxyAgent(PROXY)
    const apiUrl = `${discoveredApiBase}/api/v1/public/trace/traderListView`

    for (const sortRule of [9, 5, 2, 6, 7, 8, 1]) {
      let pageNo = 1
      while (pageNo <= 50) {
        try {
          const r = await fetch(apiUrl, {
            method: 'POST',
            agent,
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            body: JSON.stringify({ languageType: 0, sortRule, simulation: 0, pageNo, pageSize: 20, nickName: '' }),
          })
          const json = await r.json()
          if (json.code !== 'SUCCESS' || !json.data?.rows?.length) break
          let added = 0
          for (const item of json.data.rows) {
            const t = parseTrader(item)
            if (t && !traders.has(t.id)) { traders.set(t.id, t); added++ }
          }
          if (pageNo % 5 === 0) console.log(`  sort=${sortRule} p${pageNo}: ${traders.size} total`)
          if (added === 0 && pageNo > 2) break
          if (!json.data.nextFlag) break
          pageNo++
          await sleep(200)
        } catch (e) {
          if (pageNo === 1) console.log(`  sort=${sortRule}: ${e.message}`)
          break
        }
      }
    }
  }

  console.log(`  Total: ${traders.size} unique traders`)
  await browser.close()
  return [...traders.values()]
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log(`WEEX scraper | Periods: ${periods.join(', ')}`)

  const traders = await scrapeTraders()
  if (!traders.length) { console.log('❌ No data'); process.exit(1) }

  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

  // Save sources
  for (let i = 0; i < traders.length; i += 50) {
    const { error } = await supabase.from('trader_sources').upsert(
      traders.slice(i, i + 50).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
      })),
      { onConflict: 'source,source_trader_id' }
    )
    if (error) console.log(`  source err: ${error.message}`)
  }

  let totalSaved = 0
  for (const period of periods) {
    const now = new Date().toISOString()
    console.log(`\n💾 Saving ${traders.length} ${period} records...`)
    let saved = 0
    for (let i = 0; i < traders.length; i += 30) {
      const batch = traders.slice(i, i + 30).map((t, j) => {
        let roi = t.roi || 0
        if (period === '7D' && t.roi7d) roi = t.roi7d
        if (period === '90D' && t.roi90d) roi = t.roi90d
        const scores = calculateArenaScore(roi, t.pnl, t.maxDrawdown, t.winRate, period)
        return {
          source: SOURCE, source_trader_id: t.id, season_id: period,
          rank: i + j + 1, roi, pnl: t.pnl || null,
          win_rate: t.winRate, max_drawdown: t.maxDrawdown,
          followers: t.followers, arena_score: scores.totalScore,
          captured_at: now,
        }
      })
      const { error } = await supabase.from('trader_snapshots').upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
      if (!error) saved += batch.length
    }
    console.log(`  ✅ ${saved}/${traders.length} saved`)
    totalSaved += saved
    await sleep(100)
  }

  console.log(`\n✅ WEEX done: ${totalSaved} records saved`)
}

main().catch(e => { console.error(e); process.exit(1) })
