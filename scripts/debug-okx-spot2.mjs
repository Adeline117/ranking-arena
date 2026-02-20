#!/usr/bin/env node
/**
 * Discover OKX spot copy-trading API via Playwright
 * Use non-US locale
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai'
})
const page = await context.newPage()

const apiCalls = []
const client = await context.newCDPSession(page)
await client.send('Network.enable')

const requestMap = {}
client.on('Network.requestWillBeSent', p => {
  const url = p.request.url
  if (url.includes('/api/') || url.includes('copytrading') || url.includes('lead-trader') || url.includes('leaderboard')) {
    requestMap[p.requestId] = { url, method: p.request.method, postData: p.request.postData }
  }
})

client.on('Network.loadingFinished', async p => {
  if (requestMap[p.requestId]) {
    const req = requestMap[p.requestId]
    try {
      const resp = await client.send('Network.getResponseBody', { requestId: p.requestId })
      if (resp.body && !resp.body.includes('<!DOCTYPE')) {
        apiCalls.push({
          url: req.url,
          method: req.method,
          reqBody: req.postData?.slice(0, 200),
          respBody: resp.body.slice(0, 1500)
        })
      }
    } catch {}
  }
})

// Try non-US OKX URL
for (const url of [
  'https://www.okx.com/en/copy-trading',
  'https://www.okx.com/en/copy-trading?tab=spot',
  'https://www.okx.com/copy-trading',
]) {
  try {
    console.log('Loading:', url)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await new Promise(r => setTimeout(r, 5000))
    
    const title = await page.title()
    console.log('Title:', title.slice(0, 80))
    
    // Find and click spot tab
    try {
      for (const sel of ['text="Spot"', '[data-testid="spot"]', 'button:has-text("Spot")']) {
        const el = await page.$(sel)
        if (el) {
          console.log('Found spot element:', sel)
          await el.click()
          await new Promise(r => setTimeout(r, 5000))
          break
        }
      }
    } catch {}
    
    if (apiCalls.length > 0) break
  } catch (e) { console.log('Error:', e.message.slice(0, 100)) }
}

console.log('\n=== API Calls:', apiCalls.length)
for (const call of apiCalls.slice(0, 15)) {
  const url = call.url
  if (url.includes('.js') || url.includes('.css') || url.includes('analytics')) continue
  console.log('\n--- ' + url.slice(0, 150) + ' ---')
  console.log('RESP:', call.respBody.slice(0, 600))
}

await browser.close()
