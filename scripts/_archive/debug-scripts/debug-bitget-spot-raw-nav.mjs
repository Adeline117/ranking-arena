#!/usr/bin/env node
/**
 * Debug: Try navigating to trader page with different ID formats
 */
import { chromium } from 'playwright'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function testTrader(page, traderId) {
  console.log(`\n=== Testing: ${traderId} ===`)
  
  const responses = {}
  const handler = async resp => {
    const url = resp.url()
    if (url.includes('queryProfitRate') || url.includes('traderDetailPage') || url.includes('userIndex')) {
      try {
        const body = await resp.text()
        const key = url.split('/').pop().split('?')[0]
        responses[key] = { status: resp.status(), body: body.slice(0, 500) }
      } catch {}
    }
  }
  page.on('response', handler)

  try {
    await page.goto(`https://www.bitget.com/copy-trading/trader/${traderId}/spot`, {
      waitUntil: 'domcontentloaded', timeout: 20000
    })
    for (let i = 0; i < 8; i++) {
      if (Object.keys(responses).length >= 2) break
      await sleep(500)
    }
  } catch(e) {
    console.log('Nav error:', e.message.slice(0, 80))
  }
  page.removeListener('response', handler)

  for (const [name, r] of Object.entries(responses)) {
    console.log(`  ${name} (${r.status}): ${r.body.slice(0, 300)}`)
  }
  return responses
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  await ctx.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2}', r => r.abort())
  const page = await ctx.newPage()

  // Navigate to establish session
  await page.goto('https://www.bitget.com/copy-trading/spot', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('Session ready.\n')

  // Test 1: with spot_ prefix
  await testTrader(page, 'spot_10comjak')
  await sleep(1000)

  // Test 2: without spot_ prefix
  await testTrader(page, '10comjak')
  await sleep(1000)

  // Test 3: another trader without prefix
  await testTrader(page, 'al1as')
  await sleep(1000)

  // Test 4: a bguser trader (likely BGUSER-format username)
  // spot_bguser1psvkjrp -> BGUSER-1PSVKJRP or bguser1psvkjrp
  await testTrader(page, 'BGUSER-1PSVKJRP')
  await sleep(1000)
  await testTrader(page, 'bguser1psvkjrp')

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
