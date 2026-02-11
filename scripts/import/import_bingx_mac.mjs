/**
 * BingX Copy Trading - Mac Mini版 (Playwright)
 *
 * BingX uses Cloudflare + timestamp-signed API requests.
 * Strategy: Use Playwright to click through all sort/filter combinations
 * and intercept API responses to collect unique traders.
 * Also extract from __NUXT__ SSR state.
 *
 * API endpoints discovered:
 *   - POST api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend (initial load, 12 traders)
 *   - POST api-app.we-api.com/api/copy-trade-facade/v1/trader/search (sort/filter, 12 per page)
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

function parseTrader(item) {
  const t = item.trader || item
  const stats = item.rankStat || item.traderStatistics || item.statistics || item
  const uid = String(t.uid || t.id || item.uid || item.id || '')
  if (!uid || uid === 'undefined') return null
  const name = t.nickName || t.realNickName || t.nickname || item.nickName || ''
  if (!name) return null

  let roi = parseFloat(stats.roi || stats.roiRate || stats.weeklyRoi || t.roi || 0)
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  return {
    uid,
    name,
    avatar: t.avatar || t.headUrl || item.avatar || null,
    shortUid: t.shortUid || item.shortUid || null,
    roi,
    pnl: parseFloat(stats.pnl || stats.totalPnl || stats.accEarning || t.totalPnl || 0),
    winRate: parseFloat(stats.winRate || stats.profitRate || t.winRate || 0) * (parseFloat(stats.winRate || t.winRate || 0) <= 1 ? 100 : 1),
    copiers: parseInt(stats.copierNum || stats.followers || t.copierNum || 0),
  }
}

async function scrapeTraders() {
  console.log('BingX: 启动浏览器...')
  const browser = await chromium.launch({ headless: true })
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

  // Intercept ALL JSON responses for trader data
  page.on('response', async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const j = await resp.json().catch(() => null)
      if (!j) return

      for (const path of [j?.data?.result, j?.data?.list, j?.data?.traders, j?.data]) {
        if (!Array.isArray(path) || path.length === 0) continue
        for (const item of path) {
          const trader = parseTrader(item)
          if (trader && !allTraders.has(trader.uid)) {
            allTraders.set(trader.uid, trader)
          }
        }
      }
    } catch {}
  })

  try {
    // ===== Page 1: CopyTrading main page =====
    console.log('  导航到 CopyTrading...')
    await page.goto('https://bingx.com/en/CopyTrading', { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(() => {})
    await sleep(12000)

    // Close popups
    for (const text of ['OK', 'Got it', 'Accept', 'Close']) {
      const btn = page.getByRole('button', { name: text })
      if (await btn.count() > 0) await btn.first().click().catch(() => {})
    }
    await sleep(2000)
    console.log(`  Initial: ${allTraders.size} traders`)

    // Click through all sort options to get different traders
    async function clickSort(text) {
      const el = page.getByText(text, { exact: true })
      if (await el.count() > 0) {
        await el.first().click().catch(() => {})
        await sleep(4000)
        // Scroll to load any lazy content
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollBy(0, 600))
          await sleep(800)
        }
        await page.evaluate(() => window.scrollTo(0, 0))
        await sleep(1000)
        return true
      }
      return false
    }

    // Click all sort options
    for (const sort of ['ROI', 'PnL', 'Copiers', 'AUM', 'Win Rate']) {
      if (await clickSort(sort)) {
        console.log(`  After "${sort}": ${allTraders.size}`)
      }
    }

    // Try View All / See All links
    for (const txt of ['View All', 'See All', 'See More', 'View More', 'More', 'All Traders']) {
      const el = page.getByText(txt, { exact: false })
      if (await el.count() > 0) {
        await el.first().click().catch(() => {})
        await sleep(5000)
        for (let i = 0; i < 10; i++) {
          await page.evaluate(() => window.scrollBy(0, 600))
          await sleep(800)
        }
        console.log(`  After "${txt}": ${allTraders.size}`)
      }
    }

    // ===== Page 2: LeaderBoard =====
    console.log('\n  导航到 leaderBoard...')
    await page.goto('https://bingx.com/en/CopyTrading/leaderBoard', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {})
    await sleep(10000)

    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(1000)
    }
    console.log(`  leaderBoard: ${allTraders.size} traders`)

    // ===== __NUXT__ extraction =====
    const nuxtTraders = await page.evaluate(() => {
      const n = window.__NUXT__
      if (!n) return []
      const r = [], seen = new Set()
      function find(obj, d) {
        if (d > 12 || !obj || typeof obj !== 'object') return
        if (obj.uid && (obj.nickName || obj.realNickName) && !seen.has(String(obj.uid))) {
          seen.add(String(obj.uid))
          r.push({
            uid: String(obj.uid),
            name: obj.nickName || obj.realNickName || '',
            avatar: obj.avatar || null,
            shortUid: obj.shortUid || null,
          })
        }
        if (Array.isArray(obj)) for (const i of obj) find(i, d + 1)
        else for (const k of Object.keys(obj)) find(obj[k], d + 1)
      }
      find(n, 0)
      return r
    }).catch(() => [])

    for (const t of nuxtTraders) {
      if (!allTraders.has(t.uid)) {
        allTraders.set(t.uid, { ...t, roi: 0, pnl: 0, winRate: 0, copiers: 0 })
      }
    }
    console.log(`  + NUXT: ${allTraders.size} traders total`)

    // ===== Go back to main page and try different tabs =====
    console.log('\n  返回主页尝试更多排序...')
    await page.goto('https://bingx.com/en/CopyTrading', { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(() => {})
    await sleep(12000)

    // Try clicking Spot tab
    if (await clickSort('Spot')) {
      console.log(`  After Spot: ${allTraders.size}`)
      for (const sort of ['ROI', 'PnL', 'Copiers']) {
        if (await clickSort(sort)) {
          console.log(`    After Spot "${sort}": ${allTraders.size}`)
        }
      }
    }

    // Try Futures tab and click through more sorts
    if (await clickSort('Futures')) {
      console.log(`  After Futures: ${allTraders.size}`)
    }

    console.log(`\n📊 Total unique traders: ${allTraders.size}`)

  } catch (e) {
    console.error(`Error: ${e.message}`)
  } finally {
    await browser.close()
  }

  return [...allTraders.values()]
}

async function saveTraders(traders, period) {
  if (traders.length === 0) return 0

  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const capturedAt = new Date().toISOString()

  // Save sources
  const sources = traders.map(t => ({
    source: SOURCE,
    source_trader_id: t.uid,
    handle: t.name,
    avatar_url: t.avatar,
    profile_url: `https://bingx.com/en/CopyTrading/trader-detail/${t.shortUid || t.uid}`,
    is_active: true,
  }))
  for (let i = 0; i < sources.length; i += 30) {
    await supabase.from('trader_sources').upsert(sources.slice(i, i + 30), { onConflict: 'source,source_trader_id' })
  }

  // Save snapshots
  let saved = 0
  const snapshots = traders.map((t, idx) => {
    const scores = calculateArenaScore(t.roi || 0, t.pnl || 0, null, t.winRate || 0, period)
    return {
      source: SOURCE,
      source_trader_id: t.uid,
      season_id: period,
      rank: idx + 1,
      roi: t.roi || 0,
      pnl: t.pnl || 0,
      win_rate: t.winRate || 0,
      followers: t.copiers || 0,
      arena_score: scores.totalScore,
      captured_at: capturedAt,
    }
  })

  for (let i = 0; i < snapshots.length; i += 30) {
    const batch = snapshots.slice(i, i + 30)
    const { error } = await supabase.from('trader_snapshots').upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
    if (!error) saved += batch.length
    else console.log(`  ⚠ upsert error: ${error.message}`)
  }

  return saved
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log('BingX 数据抓取开始...')
  console.log(`周期: ${periods.join(', ')}`)

  const traders = await scrapeTraders()

  if (traders.length === 0) {
    console.log('❌ 未获取到数据')
    return
  }

  let total = 0
  for (const period of periods) {
    const saved = await saveTraders(traders, period)
    total += saved
    console.log(`  ${period}: saved ${saved}/${traders.length}`)
  }

  console.log(`\n✅ BingX 完成，共保存 ${total} 条记录`)
}

main().catch(e => { console.error(e); process.exit(1) })
