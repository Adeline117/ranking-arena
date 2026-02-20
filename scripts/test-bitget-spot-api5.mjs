#!/usr/bin/env node
/**
 * Test: capture queryProfitRate FULL URL with query params,
 * then test calling it directly for 7d and 30d periods
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

  let profitRateUrl = null
  let allCookies = null
  
  page.on('response', async (resp) => {
    const url = resp.url()
    if (url.includes('queryProfitRate') && !profitRateUrl) {
      profitRateUrl = url
      console.log('Captured queryProfitRate URL:', url)
    }
  })

  console.log('Navigating...')
  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${TRADER_ID}/spot`,
      { waitUntil: 'networkidle', timeout: 30000 }
    )
  } catch (e) {}
  
  await sleep(3000)
  
  // Get cookies from the browser session
  allCookies = await ctx.cookies()
  const cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join('; ')
  
  console.log(`\nCookies count: ${allCookies.length}`)
  console.log(`profitRateUrl: ${profitRateUrl}`)
  
  if (!profitRateUrl) {
    console.log('No queryProfitRate URL found!')
    await browser.close()
    process.exit(1)
  }
  
  // Parse the URL to understand parameters
  const parsed = new URL(profitRateUrl)
  console.log('\nQuery params:')
  for (const [k, v] of parsed.searchParams) {
    console.log(`  ${k}: ${v}`)
  }
  
  // Now try to call the API directly for different periods
  // showDay: 0=24h, 1=7d, 2=3w, 3=1M, 4=6M
  const periods = [
    { showDay: 1, label: '7D' },
    { showDay: 3, label: '1M' },
    { showDay: 4, label: '6M' },
  ]
  
  // Get browser headers by making a fetch call from the page
  const headers = await page.evaluate(async (url, periods) => {
    const results = {}
    for (const p of periods) {
      try {
        const testUrl = new URL(url)
        testUrl.searchParams.set('showDay', p.showDay.toString())
        const resp = await fetch(testUrl.href)
        const json = await resp.json()
        results[p.label] = json
      } catch(e) {
        results[p.label] = { error: e.message }
      }
    }
    return results
  }, profitRateUrl, periods)
  
  console.log('\n=== Direct API calls (from browser context) ===')
  for (const [label, data] of Object.entries(headers)) {
    console.log(`\n--- ${label} ---`)
    if (data.error) {
      console.log('Error:', data.error)
    } else if (data.data) {
      const d = data.data
      console.log('futureProfitrate:', d.futureProfitrate)
      console.log('showDay:', d.showDay)
      if (d.rows && d.rows.length > 0) {
        console.log('First row:', JSON.stringify(d.rows[0]))
        console.log('Last row:', JSON.stringify(d.rows[d.rows.length - 1]))
        // Calculate ROI change for the period
        const firstAmount = parseFloat(d.rows[0].amount)
        const lastAmount = parseFloat(d.rows[d.rows.length - 1].amount)
        const roiChange = lastAmount - firstAmount
        console.log(`ROI change in period: ${roiChange.toFixed(4)}%`)
        console.log(`Current ROI (last): ${lastAmount}%`)
      }
    }
  }
  
  await browser.close()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
