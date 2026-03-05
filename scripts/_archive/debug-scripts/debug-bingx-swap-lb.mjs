#!/usr/bin/env node
/**
 * Debug: Navigate to BingX swap/futures leaderboard pages
 * and intercept natural API responses to find missing traders
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
])

async function main() {
  console.log('🔍 BingX Swap Leaderboard Test\n')

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
  const apiUrlsSeen = new Set()

  function setupCapture(page) {
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
          if (!apiUrlsSeen.has(shortUrl)) {
            apiUrlsSeen.add(shortUrl)
            const sample = items[0]
            const trader = sample.trader || sample.traderInfo || {}
            const stat = sample.rankStat || sample.stat || sample.traderStat || {}
            const mddKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('draw'))
            const wrKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('win'))
            console.log(`  NEW API: ${shortUrl} - ${items.length} items (total=${json?.data?.total || '?'})`)
            console.log(`    MDD fields: ${mddKeys.join(', ') || 'NONE'}`)
            console.log(`    WR fields: ${wrKeys.join(', ') || 'NONE'}`)
          }
          
          for (const item of items) {
            const trader = item.trader || item.traderInfo || {}
            const uid = String(trader.uid || trader.uniqueId || item.uid || item.traderId || '')
            const nick = trader.nickName || trader.nickname || trader.traderName || item.nickName || ''
            const stat = item.rankStat || item.stat || item.traderStat || {}
            const mddKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('draw'))
            const mdd = mddKeys.length > 0 ? stat[mddKeys[0]] : null
            const wrKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('win'))
            const wr = wrKeys.length > 0 ? stat[wrKeys[0]] : null
            
            if (uid && uid !== '0') {
              allFound.set(uid, { uid, nick, mdd, wr })
              if (TARGET_UIDS.has(uid)) {
                console.log(`  🎯 TARGET FOUND: ${uid} (${nick}) mdd=${mdd} wr=${wr}`)
              }
            }
          }
        }
      } catch {}
    })
  }

  // Try multiple BingX leaderboard pages
  const pages_to_try = [
    'https://bingx.com/en/copytrading/',
    'https://bingx.com/en/copytrading/leaderBoard',
    'https://bingx.com/en/CopyTrading/leaderBoard',
    'https://bingx.com/en/futures/copytrading/',
    'https://bingx.com/en/futures/leaderboard/',
    'https://bingx.com/en/futures-trade/leaderboard/',
  ]

  for (const pageUrl of pages_to_try) {
    console.log(`\nLoading: ${pageUrl}`)
    const page = await ctx.newPage()
    setupCapture(page)

    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => {
      console.log(`  Nav error: ${e.message.slice(0, 50)}`)
    })
    await sleep(5000)

    const title = await page.title()
    const finalUrl = page.url()
    console.log(`  title: "${title.slice(0, 80)}"`)
    console.log(`  final URL: ${finalUrl}`)
    console.log(`  All traders so far: ${allFound.size}`)

    // Scroll to trigger more loads
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(1000)
    }
    console.log(`  After scroll: ${allFound.size}`)

    // Look for interesting tabs
    const tabs = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, [role="tab"], [class*="tab"], [class*="Tab"]')]
      return btns.slice(0, 20).map(b => b.textContent?.trim().slice(0, 30)).filter(t => t)
    })
    if (tabs.length > 0) console.log(`  Tabs: ${tabs.join(' | ')}`)

    await page.close()

    const targetsFound = [...TARGET_UIDS].filter(uid => allFound.has(uid))
    if (targetsFound.length > 0) {
      console.log(`\n✅ Found ${targetsFound.length} target traders!`)
      break
    }
  }

  await browser.close()

  console.log(`\n=== SUMMARY ===`)
  console.log(`Total traders found: ${allFound.size}`)
  const targetsFound = [...TARGET_UIDS].filter(uid => allFound.has(uid))
  console.log(`Target traders found: ${targetsFound.length}/${TARGET_UIDS.size}`)
  for (const uid of targetsFound) {
    const d = allFound.get(uid)
    console.log(`  ${uid} (${d.nick}): mdd=${d.mdd} wr=${d.wr}`)
  }
  console.log('\nAPI URLs seen:', [...apiUrlsSeen].join('\n  '))
}

main().catch(e => { console.error(e); process.exit(1) })
