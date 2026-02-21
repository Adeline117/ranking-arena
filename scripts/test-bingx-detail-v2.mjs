#!/usr/bin/env node
/**
 * Test v2: First visit main page for CF cookies, then visit trader detail page
 */
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SHORT_UID = '7933020'

console.log('Launching browser...')
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
})
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US'
})

// Add stealth
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  window.chrome = { runtime: {} }
})

// Step 1: Visit main CopyTrading page to get CF cookies
console.log('Step 1: Visiting main page for CF cookies...')
const mainPage = await ctx.newPage()

const allUrls = new Set()
mainPage.on('response', async (resp) => {
  const url = resp.url()
  if (url.includes('qq-os.com') || url.includes('bingx.com/api')) {
    allUrls.add(url.split('?')[0])
  }
})

await mainPage.goto('https://bingx.com/en/CopyTrading/', {
  waitUntil: 'domcontentloaded',
  timeout: 30000
}).catch(e => console.log('Main page note:', e.message))
await sleep(4000)
await mainPage.close()

const cookies = await ctx.cookies()
console.log(`Got ${cookies.length} cookies:`, cookies.map(c => c.name).join(', '))
console.log(`APIs seen on main page: ${allUrls.size}`)

// Step 2: Visit trader detail page
console.log(`\nStep 2: Visiting trader detail page for shortUid=${SHORT_UID}`)
const detailPage = await ctx.newPage()

const capturedData = []

detailPage.on('response', async (resp) => {
  const url = resp.url()
  if (!url.includes('qq-os.com') && !url.includes('bingx.com/api')) return
  try {
    const text = await resp.text()
    if (text.includes('maxDrawDown') || text.includes('rankStat') || text.includes('winRate') || text.includes('traderDetail')) {
      const json = JSON.parse(text)
      console.log(`\n*** RELEVANT: ${url}`)
      const str = JSON.stringify(json.data || {})
      console.log('  data preview:', str.slice(0, 500))
      capturedData.push({ url, json })
    } else if (url.includes('trader') || url.includes('copy-trade') || url.includes('copyTrade')) {
      console.log(`[trader URL, no MDD] ${url}`)
    }
  } catch {}
})

// Also log ALL qq-os requests
detailPage.on('request', req => {
  const url = req.url()
  if (url.includes('trader') || url.includes('copy-trade') || url.includes('copyTrade') || url.includes('qq-os.com')) {
    console.log(`  → REQ: ${url.slice(0, 120)}`)
  }
})

await detailPage.goto(`https://bingx.com/en/CopyTrading/trader-detail/${SHORT_UID}`, {
  waitUntil: 'domcontentloaded',
  timeout: 30000
}).catch(e => console.log('Detail page note:', e.message))

console.log('\nWaiting 10s for API calls...')
await sleep(10000)

const title = await detailPage.title()
console.log('Page title:', title)

if (capturedData.length === 0) {
  console.log('\n❌ No relevant API responses captured')
  
  // Log all qq-os URLs we captured
  console.log('\nAll qq-os.com URLs seen on detail page:')
  const allDetailUrls = new Set()
  // Can't easily capture them after the fact. Let's check page HTML for data.
  const html = await detailPage.content()
  if (html.includes('maxDrawDown')) {
    console.log('✓ maxDrawDown found in page HTML!')
    const match = html.match(/"maxDrawDown"\s*:\s*([0-9.]+)/)
    if (match) console.log('  maxDrawDown:', match[1])
  } else {
    console.log('No maxDrawDown in page HTML')
  }
} else {
  console.log(`\n✅ Captured ${capturedData.length} relevant responses`)
  for (const { url, json } of capturedData) {
    console.log(`\n=== ${url} ===`)
    console.log(JSON.stringify(json, null, 2).slice(0, 3000))
  }
}

await browser.close()
