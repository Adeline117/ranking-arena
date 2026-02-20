#!/usr/bin/env node
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
})
const page = await context.newPage()

const apiData = {}
const client = await context.newCDPSession(page)
await client.send('Network.enable')

const requestMap = {}
client.on('Network.requestWillBeSent', (p) => {
  const url = p.request.url
  if (url.includes('weex.com/api') || url.includes('http-gateway')) {
    requestMap[p.requestId] = { url, body: p.request.postData }
  }
})

client.on('Network.loadingFinished', async (p) => {
  if (requestMap[p.requestId]) {
    try {
      const resp = await client.send('Network.getResponseBody', { requestId: p.requestId })
      const key = requestMap[p.requestId].url.replace('https://', '').slice(0, 100)
      apiData[key] = {
        reqBody: requestMap[p.requestId].body?.slice(0, 500),
        respBody: resp.body.slice(0, 3000)
      }
    } catch {}
  }
})

try {
  await page.goto('https://www.weex.com/copy-trading', { waitUntil: 'networkidle', timeout: 35000 })
  await new Promise(r => setTimeout(r, 6000))
  
  // Also try clicking on a trader to see detail API
  try {
    const traderCards = await page.$$('[class*="copyTrader"], [class*="trader-item"], [class*="traderItem"]')
    console.log('Trader cards found:', traderCards.length)
    if (traderCards.length > 0) {
      await traderCards[0].click()
      await new Promise(r => setTimeout(r, 3000))
    }
  } catch (e) { console.log('Trader click error:', e.message.slice(0, 100)) }
} catch (e) { console.log('Nav error:', e.message.slice(0, 100)) }

for (const [url, data] of Object.entries(apiData)) {
  console.log('=== ' + url + ' ===')
  if (data.reqBody) console.log('REQ:', data.reqBody)
  console.log('RESP:', data.respBody.slice(0, 1500))
  console.log()
}

await browser.close()
