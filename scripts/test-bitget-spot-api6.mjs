#!/usr/bin/env node
/**
 * Test: capture POST request body for queryProfitRate
 */
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const TRADER_ID = process.argv[2] || 'b0b0497186b63851a195'

async function main() {
  console.log(`Testing trader: ${TRADER_ID}`)
  
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  // Intercept requests to get POST body
  const requestDetails = {}
  await page.route('**/trace/spot/view/**', async (route) => {
    const req = route.request()
    const url = req.url().split('?')[0].split('/').pop()
    const postData = req.postData()
    const headers = req.headers()
    requestDetails[url] = { url: req.url(), postData, method: req.method() }
    console.log(`[Request] ${url}: method=${req.method()} postData=${postData}`)
    await route.continue()
  })

  console.log('Navigating...')
  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${TRADER_ID}/spot`,
      { waitUntil: 'networkidle', timeout: 30000 }
    )
  } catch (e) {}
  
  await sleep(5000)
  
  console.log('\n=== Request Details ===')
  for (const [name, detail] of Object.entries(requestDetails)) {
    console.log(`\n${name}:`)
    console.log('  URL:', detail.url)
    console.log('  Method:', detail.method)
    console.log('  PostData:', detail.postData)
  }
  
  // Now try to directly call the API using page.evaluate with different showDay values
  const queryProfitRateUrl = 'https://www.bitget.com/v1/trace/spot/view/queryProfitRate'
  const traderDetailUrl = 'https://www.bitget.com/v1/trace/spot/trader/traderDetailPage'
  
  const postData7d = requestDetails['queryProfitRate']?.postData
  
  if (postData7d) {
    console.log('\n=== Testing 30d (showDay=3) via page fetch ===')
    const result30d = await page.evaluate(async ({ url, body7d, traderId }) => {
      try {
        // Parse the 7d body and modify for 30d
        const parsed = JSON.parse(body7d)
        console.log('7d body:', JSON.stringify(parsed))
        parsed.showDay = 3
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed)
        })
        return await resp.json()
      } catch(e) {
        return { error: e.toString() }
      }
    }, { url: queryProfitRateUrl, body7d: postData7d, traderId: TRADER_ID })
    
    console.log('30d result:', JSON.stringify(result30d, null, 2).slice(0, 1000))
  }
  
  await browser.close()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
