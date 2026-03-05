#!/usr/bin/env node
/**
 * Debug: Click the Leaderboard and Smart Ranking tabs on BingX copy trading
 * and intercept API responses — might have many more traders than recommend
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

const TARGET_UIDS = new Set([
  '1339191395874545700', '856009244589367300', '1378910400354312200',
  '1469964778594295800', '1532885692632047623', '1373505428236574700',
  '1998800000085953', '1518262070860882000', '1008921387662278659',
  '1533572897230856200', '945576862554107900', '879438778013589500',
  '1393239522299535400', '1378910400354312200', '1373505428236574700',
])

async function main() {
  console.log('🔍 BingX Leaderboard Tab Test\n')

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const allFound = new Map()
  const apiUrlsSeen = new Map()

  const page = await ctx.newPage()

  page.on('response', async resp => {
    const url = resp.url()
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    
    try {
      const json = await resp.json().catch(() => null)
      if (!json || json.code !== 0) return
      
      const items = json?.data?.result || json?.data?.list || json?.data?.records ||
                    json?.data?.traders || json?.data?.data ||
                    (Array.isArray(json?.data) ? json.data : [])
      
      if (items.length > 0) {
        const shortUrl = url.replace(/\?.*$/, '').split('/').slice(-3).join('/')
        const prev = apiUrlsSeen.get(shortUrl) || 0
        apiUrlsSeen.set(shortUrl, prev + items.length)
        
        if (prev === 0) {
          const sample = items[0]
          const trader = sample.trader || sample.traderInfo || {}
          const stat = sample.rankStat || sample.stat || sample.traderStat || {}
          const mddKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('draw'))
          const wrKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('win'))
          console.log(`  NEW API: ${shortUrl} - first ${items.length} items (total=${json?.data?.total || json?.data?.totalCount || '?'})`)
          console.log(`    MDD fields: ${mddKeys.join(', ') || 'NONE'}`)
          console.log(`    WR fields: ${wrKeys.join(', ') || 'NONE'}`)
        }
        
        for (const item of items) {
          const trader = item.trader || item.traderInfo || {}
          const uid = String(trader.uid || trader.uniqueId || item.uid || item.traderId || '')
          const nick = trader.nickName || trader.nickname || trader.traderName || item.nickName || ''
          const stat = item.rankStat || item.stat || item.traderStat || {}

          // Parse MDD
          const mddCandidates = ['maxDrawDown90d', 'maxDrawdown90d', 'maximumDrawDown90d',
            'maxDrawDown', 'maxDrawdown', 'maximumDrawDown', 'maxDrawDown30d', 'maxDrawDown7d']
          let mdd = null
          for (const k of mddCandidates) {
            if (stat[k] != null) { mdd = stat[k]; break }
          }
          const wr = stat.winRate90d ?? stat.winRate ?? stat.winRate30d
          
          if (uid && uid !== '0') {
            allFound.set(uid, { uid, nick, mdd, wr })
            if (TARGET_UIDS.has(uid)) {
              console.log(`  🎯 TARGET: ${uid} (${nick}) mdd=${mdd} wr=${wr}`)
            }
          }
        }
      }
    } catch {}
  })

  console.log('Loading main copy trading page...')
  await page.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 60000
  }).catch(() => {})
  await sleep(5000)
  console.log(`  After main load: ${allFound.size} traders`)

  // Find and click Leaderboard tab
  console.log('\nLooking for Leaderboard tab...')
  const tabSelectors = [
    '[class*="tab"]:has-text("Leaderboard")',
    'button:has-text("Leaderboard")',
    'text="Leaderboard"',
    '[data-tab="leaderboard"]',
  ]
  for (const sel of tabSelectors) {
    try {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 2000 })) {
        console.log(`  Found Leaderboard tab with selector: ${sel}`)
        await el.click()
        await sleep(5000)
        console.log(`  After Leaderboard click: ${allFound.size} traders`)
        break
      }
    } catch {}
  }

  // Scroll through leaderboard
  console.log('\nScrolling through leaderboard...')
  const prevCount = allFound.size
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollBy(0, 800))
    await sleep(1000)
  }
  console.log(`  After scroll: ${allFound.size} traders (+${allFound.size - prevCount} new)`)

  // Try different time period tabs
  for (const period of ['7D ROI', '90D', '30D', '180D', 'All Time']) {
    try {
      const el = page.locator(`text="${period}"`).first()
      if (await el.isVisible({ timeout: 1000 })) {
        console.log(`\nClicking period: ${period}`)
        await el.click()
        await sleep(3000)
        for (let i = 0; i < 10; i++) {
          await page.evaluate(() => window.scrollBy(0, 800))
          await sleep(800)
        }
        console.log(`  After ${period}: ${allFound.size} traders`)
      }
    } catch {}
  }

  // Try Smart Ranking tab
  console.log('\nLooking for Smart Ranking tab...')
  try {
    const el = page.locator('text="Smart Ranking"').first()
    if (await el.isVisible({ timeout: 2000 })) {
      await el.click()
      await sleep(4000)
      for (let i = 0; i < 15; i++) {
        await page.evaluate(() => window.scrollBy(0, 800))
        await sleep(800)
      }
      console.log(`  After Smart Ranking: ${allFound.size} traders`)
    }
  } catch {}

  // Also try navigating directly to the leaderboard URL
  console.log('\nNavigating to leaderboard URL directly...')
  await page.goto('https://bingx.com/en/CopyTrading/leaderBoard?type=global', {
    waitUntil: 'networkidle', timeout: 30000
  }).catch(() => {})
  await sleep(5000)
  console.log(`  After direct URL: ${allFound.size} traders`)

  // Scroll the leaderboard page
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollBy(0, 800))
    await sleep(800)
  }
  console.log(`  After scroll: ${allFound.size} traders`)

  await browser.close()

  console.log(`\n=== SUMMARY ===`)
  console.log(`Total traders found: ${allFound.size}`)
  const targetsFound = [...TARGET_UIDS].filter(uid => allFound.has(uid))
  console.log(`Target traders found: ${targetsFound.length}/${TARGET_UIDS.size}`)
  for (const uid of targetsFound) {
    const d = allFound.get(uid)
    console.log(`  ${uid} (${d.nick}): mdd=${d.mdd} wr=${d.wr}`)
  }
  
  console.log('\nAPI calls summary:')
  for (const [url, count] of apiUrlsSeen) {
    console.log(`  ${url}: ${count} items`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
