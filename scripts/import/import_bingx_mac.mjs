/**
 * BingX Copy Trading - Mac Mini版 (Playwright + Proxy)
 *
 * BingX is behind Cloudflare. Uses Playwright with local proxy (7890).
 * 
 * Strategy:
 *   1. Intercept API responses from page navigation
 *   2. Navigate to CopyTrading page, then leaderBoard page
 *   3. Try different sort/period tabs to collect unique traders
 *   4. Extract from __NUXT__ SSR state as fallback
 *   5. Scroll and click "Load More" / pagination buttons
 *
 * Usage: node scripts/import/import_bingx_mac.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'bingx'
const PROXY = 'http://127.0.0.1:7890'

function parseTraderFromItem(item) {
  const t = item.trader || item
  const stats = item.traderStatistics || item.statistics || item
  const uid = String(t.uid || t.id || item.uid || item.id || '')
  if (!uid) return null
  const name = t.nickName || t.realNickName || t.nickname || item.nickName || ''
  if (!name) return null

  let roi = parseFloat(stats.roi || stats.roiRate || stats.weeklyRoi || t.roi || t.roiRate || 0)
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  return {
    uid,
    name,
    avatar: t.avatar || t.headUrl || item.avatar || null,
    shortUid: t.shortUid || item.shortUid || null,
    roi,
    pnl: parseFloat(stats.totalPnl || stats.pnl || t.totalPnl || 0),
    winRate: parseFloat(stats.winRate || stats.profitRate || t.winRate || 0) * (parseFloat(stats.winRate || stats.profitRate || t.winRate || 0) <= 1 ? 100 : 1),
    tradeCount: parseInt(stats.tradeCount || stats.totalCount || t.tradeCount || 0),
    followers: parseInt(stats.copierNum || stats.followers || t.copierNum || 0),
  }
}

async function scrapeTraders(period) {
  console.log(`\n=== BingX ${period} ===`)

  const browser = await chromium.launch({
    headless: true,
    proxy: { server: PROXY },
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await context.newPage()
  const allTraders = new Map()

  // API interceptor - be careful to not hang on non-JSON responses
  page.on('response', async (resp) => {
    try {
      const url = resp.url()
      const ct = resp.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      // Only intercept copy trading related APIs
      const patterns = ['topRanking', 'trader', 'leaderboard', 'ranking', 'copy', 'CopyTrading']
      if (!patterns.some(p => url.toLowerCase().includes(p.toLowerCase()))) return

      const body = await resp.json().catch(() => null)
      if (!body) return

      for (const path of [body?.data?.result, body?.data?.list, body?.data?.traders, body?.result?.list, body?.data]) {
        if (!Array.isArray(path) || path.length === 0) continue
        for (const item of path) {
          const trader = parseTraderFromItem(item)
          if (trader && !allTraders.has(trader.uid)) {
            allTraders.set(trader.uid, trader)
          }
        }
      }
    } catch {}
  })

  try {
    // ============ Page 1: CopyTrading main page ============
    console.log('  导航到 CopyTrading...')
    await page.goto('https://bingx.com/en/CopyTrading', {
      timeout: 45000,
      waitUntil: 'domcontentloaded',
    }).catch(() => {})
    await sleep(12000)

    // Close popups
    for (const text of ['OK', 'Got it', 'Accept', 'Close']) {
      const btn = page.getByRole('button', { name: text })
      if (await btn.count() > 0) await btn.first().click().catch(() => {})
    }
    await sleep(2000)

    // Click Futures tab
    await page.click('text=Futures').catch(() => {})
    await sleep(3000)

    // Scroll to load
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(1000)
    }
    console.log(`  CopyTrading页: ${allTraders.size} traders`)

    // Try period tabs
    const periodTexts = {
      '7D': ['7 Days', '7D', 'Weekly'],
      '30D': ['30 Days', '30D', 'Monthly'],
      '90D': ['90 Days', '90D'],
    }
    for (const txt of (periodTexts[period] || [])) {
      const el = page.getByText(txt, { exact: true })
      if (await el.count() > 0) {
        await el.first().click().catch(() => {})
        await sleep(4000)
        for (let i = 0; i < 10; i++) {
          await page.evaluate(() => window.scrollBy(0, 600))
          await sleep(800)
        }
        console.log(`  周期 "${txt}": ${allTraders.size} traders`)
        break
      }
    }

    // Try sort options
    for (const sortText of ['ROI', 'PnL', 'Win Rate', 'Copiers', 'AUM']) {
      try {
        const el = page.getByText(sortText, { exact: true })
        if (await el.count() > 0) {
          await el.first().click()
          await sleep(3000)
          for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollBy(0, 600))
            await sleep(800)
          }
        }
      } catch {}
    }
    console.log(`  排序后: ${allTraders.size} traders`)

    // ============ Page 2: LeaderBoard page ============
    console.log('  导航到 leaderBoard...')
    await page.goto('https://bingx.com/en/CopyTrading/leaderBoard', {
      timeout: 30000,
      waitUntil: 'domcontentloaded',
    }).catch(() => {})
    await sleep(10000)

    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(1000)
    }
    console.log(`  leaderBoard页: ${allTraders.size} traders`)

    // Try Load More buttons
    for (let attempt = 0; attempt < 10; attempt++) {
      const moreBtn = page.getByText(/Load More|See More|Show More|View More/i)
      if (await moreBtn.count() > 0) {
        await moreBtn.first().click().catch(() => {})
        await sleep(2000)
      } else break
    }

    // Try pagination
    for (let pg = 0; pg < 10; pg++) {
      const nextBtn = page.locator('[class*="next"], button:has-text("›")').first()
      if (await nextBtn.count() > 0 && await nextBtn.isEnabled().catch(() => false)) {
        await nextBtn.click().catch(() => {})
        await sleep(3000)
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollBy(0, 600))
          await sleep(600)
        }
      } else break
    }
    console.log(`  分页后: ${allTraders.size} traders`)

    // ============ Extract from __NUXT__ ============
    const nuxtTraders = await page.evaluate(() => {
      const nuxt = window.__NUXT__
      if (!nuxt) return []
      const results = []
      const seen = new Set()
      function find(obj, d) {
        if (d > 12 || !obj || typeof obj !== 'object') return
        if (obj.uid && (obj.nickName || obj.realNickName) && !seen.has(String(obj.uid))) {
          seen.add(String(obj.uid))
          results.push({
            uid: String(obj.uid),
            name: obj.nickName || obj.realNickName || '',
            avatar: obj.avatar || null,
            shortUid: obj.shortUid || null,
          })
        }
        if (Array.isArray(obj)) for (const item of obj) find(item, d + 1)
        else for (const k of Object.keys(obj)) find(obj[k], d + 1)
      }
      find(nuxt, 0)
      return results
    }).catch(() => [])

    for (const t of nuxtTraders) {
      if (!allTraders.has(t.uid)) {
        allTraders.set(t.uid, { ...t, roi: 0, pnl: 0, winRate: 0, tradeCount: 0, followers: 0 })
      }
    }

    console.log(`  NUXT合并后: ${allTraders.size} traders`)

  } catch (e) {
    console.error(`  Error: ${e.message}`)
  } finally {
    await browser.close()
  }

  // Save to DB
  const traders = [...allTraders.values()].filter(t => t.name)
  if (traders.length === 0) return 0

  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

  let saved = 0
  const capturedAt = new Date().toISOString()

  for (let idx = 0; idx < traders.length; idx++) {
    const t = traders[idx]

    await supabase.from('trader_sources').upsert({
      source: SOURCE,
      source_trader_id: t.uid,
      handle: t.name,
      avatar_url: t.avatar,
      profile_url: `https://bingx.com/en/CopyTrading/trader-detail/${t.shortUid || t.uid}`,
      is_active: true,
      last_refreshed_at: capturedAt,
    }, { onConflict: 'source,source_trader_id' })

    const scores = calculateArenaScore(t.roi || 0, t.pnl || 0, null, t.winRate || 0, period)

    const { error } = await supabase.from('trader_snapshots').upsert({
      source: SOURCE,
      source_trader_id: t.uid,
      season_id: period,
      rank: idx + 1,
      roi: t.roi || 0,
      pnl: t.pnl || 0,
      win_rate: t.winRate || 0,
      trades_count: t.tradeCount || 0,
      followers: t.followers || 0,
      arena_score: scores.totalScore,
      handle: t.name,
      avatar_url: t.avatar,
      captured_at: capturedAt,
    }, { onConflict: 'source,source_trader_id,season_id' })

    if (!error) saved++
  }

  console.log(`  保存: ${saved}/${traders.length} traders`)
  return saved
}

const periods = getTargetPeriods(['7D', '30D', '90D'])
let total = 0
for (const p of periods) {
  total += await scrapeTraders(p)
  await sleep(3000)
}
console.log(`\n✅ BingX完成，共保存 ${total} 条记录`)
