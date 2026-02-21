#!/usr/bin/env node
/**
 * Test: Call BingX API directly with shortUid to get trader stats
 * Strategy: Get CF cookies from main page, then try API endpoints with shortUid
 */
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SHORT_UID = '7933020'  // corresponds to source_trader_id '1003380878977749000'

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

await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  window.chrome = { runtime: {} }
})

// Step 1: Visit main CopyTrading page and intercept API headers + responses
console.log('Step 1: Visiting main CopyTrading page...')
const mainPage = await ctx.newPage()
let capturedHeaders = null
const traderDataFromMain = []

mainPage.on('request', req => {
  const url = req.url()
  if (url.includes('qq-os.com') && !capturedHeaders) {
    capturedHeaders = req.headers()
    console.log('  Captured request headers from:', url.slice(0, 80))
  }
})

mainPage.on('response', async (resp) => {
  const url = resp.url()
  if (!url.includes('qq-os.com')) return
  try {
    const json = await resp.json()
    const str = JSON.stringify(json)
    if (str.includes('maxDrawDown') || str.includes('rankStat')) {
      console.log(`  *** MAIN PAGE rankStat found: ${url.slice(0, 80)}`)
      traderDataFromMain.push({ url, json })
    }
  } catch {}
})

await mainPage.goto('https://bingx.com/en/CopyTrading/', {
  waitUntil: 'networkidle',
  timeout: 30000
}).catch(e => console.log('Main page note:', e.message))
await sleep(4000)

const cookies = await ctx.cookies()
const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
console.log(`Got ${cookies.length} cookies, capturedHeaders: ${capturedHeaders ? 'yes' : 'no'}`)
console.log(`Found ${traderDataFromMain.length} responses with rankStat on main page`)

// Build fetch headers
const fetchHeaders = {
  ...(capturedHeaders || {}),
  'Cookie': cookieStr,
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'Referer': `https://bingx.com/en/CopyTrading/trader-detail/${SHORT_UID}`,
  'Origin': 'https://bingx.com',
}

// Step 2: Try various API endpoints with shortUid via page.evaluate
console.log(`\nStep 2: Trying API endpoints for shortUid=${SHORT_UID}...`)

const apiEndpoints = [
  // Trader detail endpoints
  `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/detail?shortUid=${SHORT_UID}`,
  `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/detail?shortUid=${SHORT_UID}`,
  `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/detail/${SHORT_UID}`,
  `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/rank?shortUid=${SHORT_UID}`,
  `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/stat?shortUid=${SHORT_UID}`,
  `https://api-app.qq-os.com/api/copy-trade-facade/v1/rank/detail?shortUid=${SHORT_UID}`,
  `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/info?shortUid=${SHORT_UID}`,
  // The personal profile page uses these
  `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/homepage?shortUid=${SHORT_UID}`,
  `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/page?shortUid=${SHORT_UID}`,
]

for (const url of apiEndpoints) {
  try {
    const result = await mainPage.evaluate(async ({ url, headers }) => {
      try {
        const r = await fetch(url, { headers, credentials: 'include' })
        const text = await r.text()
        return { status: r.status, text: text.slice(0, 500) }
      } catch (e) {
        return { error: e.message }
      }
    }, { url, headers: fetchHeaders })
    
    if (result.error) {
      console.log(`  ${url.split('?')[0].split('/').slice(-2).join('/')}: ERROR ${result.error}`)
    } else if (result.status === 200 && (result.text.includes('maxDrawDown') || result.text.includes('rankStat') || result.text.includes('winRate'))) {
      console.log(`\n  ✅ ${url}`)
      console.log(`  Status: ${result.status}`)
      console.log(`  Response: ${result.text}`)
    } else {
      console.log(`  ${url.split('?')[0].split('/').slice(-2).join('/')}: ${result.status} - ${result.text.slice(0, 100)}`)
    }
  } catch (e) {
    console.log(`  Error calling ${url}: ${e.message}`)
  }
  await sleep(300)
}

// Step 3: Try navigating within the SPA (navigate from main page to detail page)
console.log('\nStep 3: SPA navigation - goto detail from main page context...')

// Intercept on mainPage
let spaApiData = null
const responseListener = async (resp) => {
  const url = resp.url()
  if (!url.includes('qq-os.com')) return
  try {
    const json = await resp.json()
    const str = JSON.stringify(json)
    if ((str.includes('maxDrawDown') || str.includes('rankStat')) && str.includes(SHORT_UID)) {
      console.log(`  *** SPA found rankStat: ${url}`)
      spaApiData = json
    }
  } catch {}
}
mainPage.on('response', responseListener)

await mainPage.goto(`https://bingx.com/en/CopyTrading/trader-detail/${SHORT_UID}`, {
  waitUntil: 'domcontentloaded',
  timeout: 30000
}).catch(e => console.log('SPA nav note:', e.message))
await sleep(8000)

if (spaApiData) {
  console.log('SPA data found:', JSON.stringify(spaApiData).slice(0, 500))
} else {
  // Try pushing history state to trigger SPA routing
  console.log('  No data from direct nav, trying JS router...')
  await mainPage.evaluate((uid) => {
    history.pushState({}, '', `/en/CopyTrading/trader-detail/${uid}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, SHORT_UID)
  await sleep(5000)
  if (spaApiData) console.log('SPA router data:', JSON.stringify(spaApiData).slice(0, 500))
  else console.log('  Still no data from SPA router')
}

await mainPage.close()
await browser.close()
console.log('\nDone.')
