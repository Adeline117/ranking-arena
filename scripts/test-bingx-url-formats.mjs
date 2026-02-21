#!/usr/bin/env node
/**
 * Test different BingX URL formats to find which one loads the trader detail page
 */
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SHORT_UID = '7933020'

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
})
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US'
})
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  window.chrome = { runtime: {} }
})

const urlFormats = [
  `https://bingx.com/en/CopyTrading/trader-detail/${SHORT_UID}`,
  `https://bingx.com/en/CopyTrading/tradeDetail/${SHORT_UID}`,
  `https://bingx.com/en/CopyTrading/TradeDetail/${SHORT_UID}`,
  `https://bingx.com/en-us/CopyTrading/trader-detail/${SHORT_UID}`,
  `https://bingx.com/en/CopyTrading/${SHORT_UID}/`,
  `https://bingx.com/en/copy-trading/trader/${SHORT_UID}`,
  `https://bingx.com/en/CopyTrading/trader/${SHORT_UID}`,
  `https://bingx.com/copytrading/trader-detail/${SHORT_UID}`,
]

for (const url of urlFormats) {
  const page = await ctx.newPage()
  const apiCalls = []
  
  page.on('response', async (resp) => {
    const rurl = resp.url()
    if (!rurl.includes('qq-os.com')) return
    try {
      const json = await resp.json()
      const str = JSON.stringify(json)
      if (str.includes('maxDrawDown') || str.includes('rankStat') || str.includes('traderDetail')) {
        apiCalls.push(rurl)
      }
    } catch {}
  })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await sleep(4000)
    
    const title = await page.title()
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 100))
    const is404 = bodyText.includes('uncharted territory') || bodyText.toLowerCase().includes('not found')
    const hasStats = apiCalls.length > 0
    
    console.log(`${is404 ? '❌ 404' : hasStats ? '✅ FOUND' : '⚠️  loaded'} | ${url}`)
    if (hasStats) console.log('  API calls with stats:', apiCalls)
    if (!is404 && !hasStats) console.log('  Title:', title.slice(0, 60), '| Body:', bodyText.slice(0, 80))
  } catch (e) {
    console.log(`  ERROR: ${e.message.slice(0, 60)} | ${url}`)
  }
  
  await page.close()
}

// Also check main CopyTrading page to get the actual trader detail URL from the UI
console.log('\nChecking main page for trader detail URL pattern...')
const mainPage = await ctx.newPage()
const detailUrls = new Set()

mainPage.on('response', async (resp) => {
  const url = resp.url()
  if (!url.includes('recommend')) return
  try {
    const json = await resp.json()
    const items = json?.data?.result || []
    for (const item of items) {
      const t = item?.trader || {}
      if (t.shortUid) {
        // Check if there's a detailUrl field
        const fields = Object.entries(t).filter(([k]) => k.toLowerCase().includes('url') || k.toLowerCase().includes('link') || k.toLowerCase().includes('href'))
        if (fields.length > 0) console.log('  Trader URL fields:', fields)
        // Check item-level
        const itemFields = Object.entries(item).filter(([k]) => k.toLowerCase().includes('url') || k.toLowerCase().includes('link'))
        if (itemFields.length > 0) console.log('  Item URL fields:', itemFields)
      }
    }
  } catch {}
})

await mainPage.goto('https://bingx.com/en/CopyTrading/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
await sleep(4000)

// Look at page links for trader detail pattern
const links = await mainPage.evaluate(() => {
  const anchors = Array.from(document.querySelectorAll('a[href]'))
  return [...new Set(anchors.map(a => a.href))]
    .filter(h => h.includes('trader') || h.includes('detail') || h.includes('copy'))
    .slice(0, 20)
})
console.log('Links on main page:', links)

await browser.close()
