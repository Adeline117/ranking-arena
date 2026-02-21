#!/usr/bin/env node
/**
 * Capture ACTUAL POST request headers (not CORS preflight)
 * Then use them for direct Node.js API calls
 */
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))

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

const page = await ctx.newPage()
const client = await ctx.newCDPSession(page)
await client.send('Network.enable')

let actualPostHeaders = null  // POST request headers with sign/timestamp
let recommendData = null       // Actual response data from recommend API

client.on('Network.requestWillBeSent', ({ request, requestId }) => {
  const url = request.url
  if (!url.includes('qq-os.com')) return
  
  // Skip CORS preflight
  if (request.method === 'OPTIONS') return
  
  // Capture first actual API request headers
  if (!actualPostHeaders && request.headers?.sign) {
    actualPostHeaders = { ...request.headers, _requestId: requestId, _url: url }
    console.log(`\n✅ Captured POST headers from: ${url}`)
    console.log('  Headers present:', Object.keys(request.headers).join(', '))
    console.log('  sign:', request.headers.sign?.slice(0, 20) + '...')
    console.log('  timestamp:', request.headers.timestamp)
  }
})

// Capture response body
const responseBodyMap = new Map()
client.on('Network.responseReceived', async ({ requestId, response }) => {
  if (!response.url.includes('qq-os.com')) return
  if (response.url.includes('recommend') && response.status === 200) {
    try {
      const body = await client.send('Network.getResponseBody', { requestId })
      const json = JSON.parse(body.body)
      if (JSON.stringify(json).includes('maxDrawDown')) {
        recommendData = json
        console.log('\n✅ Captured recommend response with MDD data')
      }
    } catch {}
  }
})

console.log('Navigating to CopyTrading main page...')
await page.goto('https://bingx.com/en/CopyTrading/', {
  waitUntil: 'networkidle', timeout: 30000
}).catch(e => console.log('Nav:', e.message))
await sleep(5000)

if (!actualPostHeaders) {
  console.log('❌ No POST headers captured, waiting 5s more...')
  await sleep(5000)
}

console.log('\n\n=== POST HEADERS (with sign) ===')
console.log(JSON.stringify(actualPostHeaders, null, 2))

if (actualPostHeaders && actualPostHeaders.sign) {
  const cookies = await ctx.cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  
  const fetchHeaders = {
    ...actualPostHeaders,
    'Cookie': cookieStr,
    'Referer': 'https://bingx.com/en/CopyTrading/',
    'Origin': 'https://bingx.com',
    'Content-Type': 'application/json',
  }
  delete fetchHeaders._requestId
  delete fetchHeaders._url
  
  console.log('\n=== TESTING TRADER DETAIL APIS ===')
  const SHORT_UID = '7933020'
  
  // Update timestamp to current
  fetchHeaders.timestamp = String(Date.now())
  // Note: Sign may be stale but let's try
  
  const endpoints = [
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/detail?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/detail?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/rank/stat?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/copy/trader/stat?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/kpi?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/kpi?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/rank/stat?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/rank/detail?shortUid=${SHORT_UID}`,
    // Paginated rank list
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/rank/multi-rank?pageSize=100&page=0`,
  ]
  
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        method: url.includes('search') ? 'POST' : 'GET',
        headers: fetchHeaders,
        body: url.includes('search') ? JSON.stringify({ pageId: 0, pageSize: 20 }) : undefined,
        signal: AbortSignal.timeout(10000)
      })
      const text = await resp.text()
      const hasStats = text.includes('maxDrawDown') || text.includes('rankStat') || text.includes('winRate')
      console.log(`\n${hasStats ? '✅' : '  '} ${url.split('/').slice(-2).join('/')}:`)
      console.log(`  Status: ${resp.status}`)
      console.log(`  Body: ${text.slice(0, 300)}`)
    } catch (e) {
      console.log(`  ERROR for ${url.split('/').slice(-1)[0]}: ${e.message}`)
    }
    await sleep(300)
  }
}

await browser.close()
