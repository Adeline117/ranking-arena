#!/usr/bin/env node
/**
 * Test: Use CDP to capture ALL request headers (including BingX signing headers)
 * Then use those headers from Node.js to call trader detail APIs directly
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

// Enable CDP
const client = await ctx.newCDPSession(page)
await client.send('Network.enable')

// Capture ALL qq-os.com request headers
const capturedRequests = []
client.on('Network.requestWillBeSent', ({ request }) => {
  if (request.url.includes('qq-os.com') || request.url.includes('bingx.com/api')) {
    capturedRequests.push({
      url: request.url,
      headers: request.headers,
      method: request.method,
      postData: request.postData
    })
    if (request.url.includes('recommend') || request.url.includes('trader')) {
      console.log(`\n[REQ] ${request.url}`)
      console.log('  Headers:', JSON.stringify(request.headers).slice(0, 400))
    }
  }
})

// Also capture responses
const capturedResponses = []
client.on('Network.responseReceived', async ({ requestId, response }) => {
  if (!response.url.includes('qq-os.com')) return
  if (response.url.includes('recommend') || response.url.includes('trader')) {
    console.log(`\n[RESP] ${response.status} ${response.url}`)
    try {
      const body = await client.send('Network.getResponseBody', { requestId })
      const json = JSON.parse(body.body)
      if (JSON.stringify(json).includes('maxDrawDown') || JSON.stringify(json).includes('rankStat')) {
        console.log('  *** Has rankStat/maxDrawDown! ***')
        console.log('  Preview:', JSON.stringify(json.data || {}).slice(0, 500))
      }
    } catch {}
  }
})

console.log('Navigating to main CopyTrading page...')
await page.goto('https://bingx.com/en/CopyTrading/', {
  waitUntil: 'networkidle',
  timeout: 30000
}).catch(e => console.log('Nav:', e.message))
await sleep(5000)

console.log('\n\n=== SUMMARY ===')
console.log(`Total qq-os.com requests: ${capturedRequests.length}`)
const uniqueUrls = [...new Set(capturedRequests.map(r => r.url.split('?')[0]))]
console.log('Unique URLs:')
uniqueUrls.forEach(u => console.log(' -', u))

// Find the recommend request headers
const recommendReq = capturedRequests.find(r => r.url.includes('recommend'))
if (recommendReq) {
  console.log('\n=== RECOMMEND REQUEST HEADERS ===')
  console.log(JSON.stringify(recommendReq.headers, null, 2))
  
  // Try to call trader detail API from Node.js using these exact headers
  const headers = { ...recommendReq.headers }
  const cookies = await ctx.cookies()
  headers['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  
  console.log('\n=== TESTING DIRECT NODE.JS API CALLS WITH CAPTURED HEADERS ===')
  const SHORT_UID = '7933020'
  
  const endpoints = [
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/detail?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/rank?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/kpi?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/detail?shortUid=${SHORT_UID}`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/homepage?shortUid=${SHORT_UID}`,
  ]
  
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10000)
      })
      const text = await resp.text()
      console.log(`\n${url.split('/').slice(-2).join('/')}:`)
      console.log(`  Status: ${resp.status}`)
      console.log(`  Body: ${text.slice(0, 300)}`)
      if (text.includes('maxDrawDown') || text.includes('rankStat')) {
        console.log('  *** HAS STATS! ***')
      }
    } catch (e) {
      console.log(`  ERROR: ${e.message}`)
    }
    await sleep(500)
  }
}

await browser.close()
