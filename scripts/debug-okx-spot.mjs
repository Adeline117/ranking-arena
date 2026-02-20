#!/usr/bin/env node
/**
 * Discover OKX spot copy-trading leaderboard API
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'en-US'
})
const page = await context.newPage()

const apiCalls = []
const client = await context.newCDPSession(page)
await client.send('Network.enable')

const requestMap = {}
client.on('Network.requestWillBeSent', p => {
  const url = p.request.url
  if (url.includes('/api/') || url.includes('/v5/') || url.includes('/copy') || url.includes('leaderboard') || url.includes('trader')) {
    requestMap[p.requestId] = { url, method: p.request.method, postData: p.request.postData }
  }
})

client.on('Network.loadingFinished', async p => {
  if (requestMap[p.requestId]) {
    const req = requestMap[p.requestId]
    try {
      const resp = await client.send('Network.getResponseBody', { requestId: p.requestId })
      apiCalls.push({
        url: req.url,
        method: req.method,
        reqBody: req.postData?.slice(0, 200),
        respBody: resp.body.slice(0, 2000)
      })
    } catch {}
  }
})

// Load OKX copy-trading main page first
try {
  await page.goto('https://www.okx.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 35000 })
  await new Promise(r => setTimeout(r, 5000))
  console.log('Loaded copy-trading page, title:', await page.title())
} catch (e) { console.log('Nav error:', e.message.slice(0, 100)) }

// Try to click on "Spot" tab
try {
  const spotTab = await page.$([
    'text="Spot"',
    '[class*="spot"]',
    'a[href*="spot"]',
    '[data-type="spot"]',
    'button:has-text("Spot")',
  ].join(', '))
  
  if (spotTab) {
    console.log('Found spot tab, clicking...')
    await spotTab.click()
    await new Promise(r => setTimeout(r, 5000))
  } else {
    console.log('No spot tab found directly')
    // Try to find tabs on the page
    const tabs = await page.$$('[class*="tab"], [role="tab"]')
    console.log(`Found ${tabs.length} tab elements`)
    for (const tab of tabs) {
      const text = await tab.textContent().catch(() => '')
      console.log('  Tab text:', text.trim().slice(0, 50))
    }
    // Navigate directly to spot URL
    await page.goto('https://www.okx.com/copy-trading?type=spot', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 5000))
    
    // Also try
    await page.goto('https://www.okx.com/copy-trading/spot', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 5000))
  }
} catch (e) { console.log('Spot tab error:', e.message.slice(0, 100)) }

// Show what APIs were called
console.log('\n=== API Calls Intercepted:', apiCalls.length, '===')
for (const call of apiCalls.slice(0, 20)) {
  console.log('\n--- ' + call.url.slice(0, 150) + ' ---')
  if (call.reqBody) console.log('REQ:', call.reqBody)
  console.log('RESP:', call.respBody.slice(0, 800))
}

await browser.close()
