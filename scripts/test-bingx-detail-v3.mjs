#!/usr/bin/env node
/**
 * Test v3: Navigate to detail page, wait 20s, log ALL API calls
 * Also try: navigate main page first → then navigate to detail in same tab
 */
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SHORT_UID = '7933020'

console.log('Launching browser...')
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-web-security']
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

// Test 1: Navigate main page → same tab → detail page
console.log('\n=== Test 1: main page → same tab nav to detail ===')
const page = await ctx.newPage()
const allResponses1 = []

page.on('response', async (resp) => {
  const url = resp.url()
  if (!url.includes('qq-os.com')) return
  try {
    const json = await resp.json()
    const str = JSON.stringify(json)
    const hasStats = str.includes('maxDrawDown') || str.includes('rankStat') || str.includes('traderDetail')
    if (url.includes('copy-trade') || url.includes('trader') || hasStats) {
      allResponses1.push({ url: url.split('?')[0], hasStats, preview: str.slice(0, 200) })
      if (hasStats) console.log(`  *** STATS: ${url}`)
    }
  } catch {}
})

// Navigate to main first
await page.goto('https://bingx.com/en/CopyTrading/', {
  waitUntil: 'domcontentloaded', timeout: 30000
}).catch(e => console.log('Main nav:', e.message))
await sleep(3000)
console.log('Main page loaded. Navigating to detail...')

// Now navigate within same tab
await page.goto(`https://bingx.com/en/CopyTrading/trader-detail/${SHORT_UID}`, {
  waitUntil: 'domcontentloaded', timeout: 30000
}).catch(e => console.log('Detail nav:', e.message))
console.log('Waiting 15s...')
await sleep(15000)

console.log(`\nTest 1 API calls with copy-trade or stats:`)
allResponses1.forEach(r => console.log(`  ${r.hasStats ? '✅' : '  '} ${r.url}`))

// Test 2: Check page HTML for data
const html = await page.content()
const hasMaxDD = html.includes('maxDrawDown')
const hasWinRate = html.includes('winRate')
console.log(`\nPage HTML: hasMaxDrawDown=${hasMaxDD}, hasWinRate=${hasWinRate}`)
const pageTitle = await page.title()
console.log('Page title:', pageTitle)

// Test 3: Check if there are any network errors
const pageUrl = page.url()
console.log('Current URL:', pageUrl)

// Test 4: Wait for specific elements that would indicate trader data is loaded
try {
  const traderName = await page.waitForSelector('[class*="trader"], [class*="Trader"], [class*="nickname"], [class*="name"]', { timeout: 3000 })
  console.log('Found trader element!')
} catch {
  console.log('No trader element found in DOM')
}

// Try scrolling to trigger lazy loading
await page.evaluate(() => window.scrollTo(0, 500))
await sleep(3000)

// Try looking at what's in the page
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500))
console.log('\nBody text preview:', bodyText)

// Test 5: Try to find the react app and manually trigger routing
console.log('\n=== Test 5: Checking React router... ===')
const routerInfo = await page.evaluate(() => {
  const app = document.getElementById('__NEXT_DATA__') 
  if (app) {
    return JSON.parse(app.textContent || '{}')
  }
  return null
})
if (routerInfo) {
  console.log('Next.js data:', JSON.stringify(routerInfo).slice(0, 300))
}

// Check for any data attributes
const scripts = await page.evaluate(() => {
  const scripts = Array.from(document.scripts)
  return scripts.map(s => s.src).filter(s => s.includes('trader') || s.includes('copy'))
})
console.log('Trader-related scripts:', scripts)

await browser.close()
console.log('\nDone.')
