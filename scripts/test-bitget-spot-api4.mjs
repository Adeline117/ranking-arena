#!/usr/bin/env node
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const TRADER_ID = process.argv[2] || 'b0b0497186b63851a195'

async function main() {
  console.log(`Testing trader: ${TRADER_ID}`)
  
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  // Don't block CSS - keep everything to preserve API calls  
  const page = await ctx.newPage()

  const allResponses = []
  page.on('response', async (resp) => {
    const url = resp.url()
    const ct = resp.headers()['content-type'] || ''
    if ((ct.includes('application/json') || ct.includes('text/json')) && url.includes('bitget')) {
      try {
        const json = await resp.json()
        allResponses.push({ url, status: resp.status(), data: json })
      } catch {}
    }
  })

  console.log('Navigating...')
  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${TRADER_ID}/spot`,
      { waitUntil: 'networkidle', timeout: 30000 }
    )
  } catch (e) {
    console.log('Nav note:', e.message.substring(0, 80))
  }
  
  await sleep(5000)
  
  // Print full details for specific endpoints
  const targets = ['queryProfitRate', 'queryProfit', 'traderDetailPage', 'queryTradeVolume']
  for (const target of targets) {
    const r = allResponses.find(r => r.url.includes(target))
    if (r) {
      console.log(`\n===== ${target} =====`)
      console.log('FULL URL:', r.url)
      console.log('FULL DATA:', JSON.stringify(r.data, null, 2).slice(0, 3000))
    }
  }
  
  await browser.close()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
