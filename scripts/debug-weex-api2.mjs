#!/usr/bin/env node
/**
 * Debug script to discover weex API endpoints for win_rate/max_drawdown
 * Uses Playwright page.evaluate to call from within browser context
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
})
const page = await context.newPage()

// Intercept all API responses to get request headers
const requestHeaders = {}
const client = await context.newCDPSession(page)
await client.send('Network.enable')
client.on('Network.requestWillBeSent', p => {
  const url = p.request.url
  if (url.includes('gateway1.weex.com') || url.includes('janapw.com')) {
    requestHeaders[p.requestId] = {
      url,
      headers: p.request.headers,
      postData: p.request.postData?.slice(0, 200)
    }
  }
})

try {
  await page.goto('https://www.weex.com/copy-trading', { waitUntil: 'networkidle', timeout: 35000 })
  await new Promise(r => setTimeout(r, 3000))
} catch (e) { console.log('Nav error:', e.message.slice(0, 100)) }

// Get the working headers from traderListView request
const workingHeaders = Object.values(requestHeaders)
  .find(r => r.url.includes('traderListView'))?.headers || {}

console.log('Working headers:', JSON.stringify(Object.fromEntries(
  Object.entries(workingHeaders).filter(([k]) => 
    ['vs', 'x-sig', 'sidecar', 'x-timestamp', 'terminalcode', 'language', 'locale', 'appversion', 'terminaltype'].includes(k)
  )
), null, 2))

// Try to fetch trader detail via page.evaluate (uses browser's XHR)
const TRADER_ID = 4188609913
const result = await page.evaluate(async (traderId) => {
  const detailEndpoints = [
    `/api/v1/public/trace/traderDetail?traderUserId=${traderId}`,
    `/api/v1/public/trace/traderHome?traderUserId=${traderId}`,
    `/api/v1/public/trace/traderPerformance?traderUserId=${traderId}`,
    `/api/v1/public/trace/traderStat?traderUserId=${traderId}`,
    `/api/v1/public/trace/traderAbstract?traderUserId=${traderId}`,
  ]
  
  const results = {}
  for (const ep of detailEndpoints) {
    try {
      const r = await fetch(ep, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      })
      results[ep] = { status: r.status, body: (await r.text()).slice(0, 500) }
    } catch (e) {
      results[ep] = { error: e.message }
    }
  }
  return results
}, TRADER_ID)

console.log('\n=== Trader Detail Endpoints ===')
for (const [ep, data] of Object.entries(result)) {
  console.log('\n--- ' + ep + ' ---')
  console.log(JSON.stringify(data, null, 2))
}

// Also try GET version with traderListView for specific trader
const listResult = await page.evaluate(async (traderId) => {
  try {
    const r = await fetch('/api/v1/public/trace/traderListView', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ languageType: 0, sortRule: 7, simulation: 0, pageNo: 1, pageSize: 50, nickName: '' })
    })
    const data = await r.json()
    // Find our trader
    const trader = data?.data?.rows?.find(t => t.traderUserId === traderId)
    return { status: r.status, total: data?.data?.totals, trader, firstItem: data?.data?.rows?.[0]?.itemVoList }
  } catch (e) {
    return { error: e.message }
  }
}, TRADER_ID)

console.log('\n=== TraderListView with Win Rate Sort ===')
console.log(JSON.stringify(listResult, null, 2))

await browser.close()
