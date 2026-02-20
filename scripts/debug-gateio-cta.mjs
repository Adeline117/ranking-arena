#!/usr/bin/env node
/**
 * Debug Gate.io CTA (spot copy trading) API
 */
import { chromium } from 'playwright'
import { sleep } from './lib/shared.mjs'

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)

  async function apiFetch(url) {
    return page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' })
        if (!r.ok) return { status: r.status, error: 'not ok' }
        return await r.json()
      } catch (e) { return { error: String(e) } }
    }, url)
  }

  // Test 1: query_cta_trader - what does it return?
  console.log('=== query_cta_trader ===')
  const cta1 = await apiFetch('https://www.gate.com/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=100&sort_field=NINETY_PROFIT_RATE_SORT')
  console.log(JSON.stringify(cta1?.data?.list?.[0] || cta1?.data?.[0] || cta1).slice(0, 500))
  console.log('Total count:', cta1?.data?.total_count || cta1?.data?.list?.length)

  // Test 2: spot copy trading profit list
  console.log('\n=== spot-copy-trading/trader/profit ===')
  const spot1 = await apiFetch('https://www.gate.com/api/copytrade/spot-copy-trading/trader/profit?page=1&page_size=100&order_by=profit_rate&sort_by=desc&cycle=month')
  const spotSample = spot1?.data?.[0] || spot1
  console.log('First record:', JSON.stringify(spotSample).slice(0, 500))
  console.log('Total:', spot1?.totalcount, 'Pages:', spot1?.pagecount)

  // Test 3: spot copy trading trader list
  console.log('\n=== spot-copy-trading/leader/list ===')
  const spot2 = await apiFetch('https://www.gate.com/api/copytrade/spot-copy-trading/leader/list?page=1&page_size=100&order_by=profit_rate&sort_by=desc')
  console.log(JSON.stringify(spot2).slice(0, 500))

  // Test 4: Try search by username
  console.log('\n=== Search by trader_name: galaxyquant ===')
  const search1 = await apiFetch('https://www.gate.com/api/copytrade/spot-copy-trading/trader/profit?page=1&page_size=20&trader_name=galaxyquant')
  console.log(JSON.stringify(search1).slice(0, 500))
  
  // Test 5: Try futures CT search by username
  console.log('\n=== Futures CT search by name: galaxyquant ===')
  const search2 = await apiFetch('https://www.gate.com/apiw/v2/copy/leader/list?page=1&page_size=20&trader_name=galaxyquant')
  console.log(JSON.stringify(search2).slice(0, 500))

  // Test 6: look at what the CTA list actually is
  console.log('\n=== query_cta_trader full data ===')
  const cta2 = await apiFetch('https://www.gate.com/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=100&sort_field=NINETY_PROFIT_RATE_SORT')
  if (cta2?.data) {
    const list = cta2.data.list || cta2.data
    if (Array.isArray(list)) {
      for (const t of list.slice(0, 5)) {
        console.log(JSON.stringify(t).slice(0, 300))
      }
      console.log(`Total: ${list.length}`)
    }
  }

  // Test 7: Try the spot copytrading page directly
  console.log('\n=== Navigating to spot copytrading ===')
  const allSpotApis = []
  page.on('response', async (res) => {
    const url = res.url()
    if (!url.includes('copy') && !url.includes('trade')) return
    if (res.status() !== 200) return
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const j = await res.json()
      allSpotApis.push({ url: url.slice(0, 120), preview: JSON.stringify(j).slice(0, 200) })
    } catch {}
  })
  await page.goto('https://www.gate.com/copytrading?type=spot', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
  await sleep(4000)
  for (const a of allSpotApis) console.log(`${a.url}\n  ${a.preview}\n`)

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
