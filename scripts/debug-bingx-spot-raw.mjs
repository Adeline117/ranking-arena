#!/usr/bin/env node
/**
 * Debug: Get raw spot trader search response to see full data structure
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('🔍 BingX Spot Raw Response\n')

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await ctx.newPage()
  let rawResponse = null
  let capturedHeaders = null
  let capturedBody = null

  // Use CDP for precise capture
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  
  cdp.on('Network.requestWillBeSent', ({ request, requestId }) => {
    if (request.url.includes('spot/trader/search') && request.method === 'POST') {
      capturedHeaders = request.headers
      capturedBody = request.postData
      console.log(`Captured request: ${request.url.split('/').slice(-3).join('/')}`)
      console.log(`  Body: ${request.postData}`)
    }
  })

  page.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('spot/trader/search')) return
    try {
      const json = await resp.json()
      if (!rawResponse) {
        rawResponse = json
        const items = json?.data?.result || []
        console.log(`\nSpot search response (${items.length} items, total=${json?.data?.total}):`)
        if (items.length > 0) {
          const item = items[0]
          console.log(`\nFirst item keys: ${Object.keys(item).join(', ')}`)
          if (item.trader) console.log(`trader keys: ${Object.keys(item.trader).join(', ')}`)
          if (item.rankStat) {
            console.log(`rankStat keys: ${Object.keys(item.rankStat).join(', ')}`)
            // Check for chart
            if (item.rankStat.chart) {
              console.log(`chart type: ${typeof item.rankStat.chart}`)
              if (Array.isArray(item.rankStat.chart)) {
                console.log(`chart length: ${item.rankStat.chart.length}`)
                if (item.rankStat.chart.length > 0) {
                  console.log(`chart[0]: ${JSON.stringify(item.rankStat.chart[0])}`)
                }
              }
            } else {
              console.log('NO chart data in rankStat')
            }
            // Show all non-null values in rankStat
            console.log('\nrankStat values:')
            for (const [k, v] of Object.entries(item.rankStat)) {
              if (v != null && v !== '' && v !== 0) {
                if (typeof v === 'object') {
                  console.log(`  ${k}: [${Array.isArray(v) ? 'array ' + v.length : 'object'}]`)
                } else {
                  console.log(`  ${k}: ${v}`)
                }
              }
            }
          }
        }
      }
    } catch {}
  })

  await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle', timeout: 60000
  }).catch(() => {})
  await sleep(5000)

  if (capturedHeaders && rawResponse) {
    // Now paginate all 3 pages using captured headers
    console.log('\n\nPaginating all pages using captured headers...')
    const SPOT_API = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search'
    
    for (let pageId = 1; pageId < 5; pageId++) {
      try {
        const result = await page.evaluate(async ({ url, headers, pageId }) => {
          const r = await fetch(`${url}?pageId=${pageId}&pageSize=20`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: '{}',
            credentials: 'include',
          })
          const json = await r.json()
          return { code: json.code, count: json?.data?.result?.length || 0, total: json?.data?.total, items: json?.data?.result }
        }, { url: SPOT_API, headers: capturedHeaders, pageId })
        
        console.log(`  Page ${pageId}: code=${result.code} items=${result.count} total=${result.total}`)
        if (result.code !== 0 || result.count === 0) break
        
        // Check for chart data in this batch
        if (result.items && result.items.length > 0) {
          const hasChart = result.items.some(i => i.rankStat?.chart)
          const hasMDD = result.items.some(i => i.rankStat?.maxDrawdown || i.rankStat?.maxDrawDown)
          console.log(`    hasChart=${hasChart} hasMDD=${hasMDD}`)
          if (result.items[0].rankStat) {
            const nonNull = Object.entries(result.items[0].rankStat).filter(([k,v]) => v != null && v !== 0 && v !== '')
            console.log(`    first rankStat non-null: ${nonNull.map(([k,v]) => k+'='+String(v).slice(0,20)).join(', ')}`)
          }
          // Print trader names
          const names = result.items.map(i => i.trader?.nickName || i.trader?.nickname || '').filter(n => n)
          console.log(`    Traders: ${names.join(', ')}`)
        }
      } catch (e) {
        console.log(`  Page ${pageId} error: ${e.message}`)
        break
      }
      await sleep(500)
    }
  }

  await browser.close()
  console.log('\nDone')
}

main().catch(e => { console.error(e); process.exit(1) })
