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
  const page = await ctx.newPage()

  const jsonResponses = []
  page.on('response', async (resp) => {
    const url = resp.url()
    const ct = resp.headers()['content-type'] || ''
    if (ct.includes('application/json') || ct.includes('text/json')) {
      try {
        const json = await resp.json()
        jsonResponses.push({ url, status: resp.status(), data: json })
        console.log(`[JSON ${resp.status()}] ${url.substring(0, 100)}`)
      } catch {}
    }
  })

  console.log('Navigating...')
  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${TRADER_ID}/spot`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    )
  } catch (e) {
    console.log('Navigation note:', e.message.substring(0, 100))
  }
  
  await sleep(8000)
  
  console.log(`\n=== Total JSON responses: ${jsonResponses.length} ===`)
  
  // Print all data, look for ROI fields
  for (const r of jsonResponses) {
    const url = r.url.split('?')[0]
    const str = JSON.stringify(r.data)
    
    // Check if contains ROI or profit data
    const hasROI = str.toLowerCase().includes('roi') || str.toLowerCase().includes('profit') || str.toLowerCase().includes('week') || str.toLowerCase().includes('month')
    if (hasROI) {
      console.log(`\n=== [HAS ROI DATA] ${url} ===`)
      // Find the relevant part
      const d = r.data?.data?.traderDataVo?.allData || r.data?.data?.allData || r.data?.data || r.data
      if (d && typeof d === 'object') {
        const keys = Object.keys(d)
        const roiKeys = keys.filter(k => 
          k.toLowerCase().includes('roi') || 
          k.toLowerCase().includes('profit') ||
          k.toLowerCase().includes('week') ||
          k.toLowerCase().includes('month') ||
          k.toLowerCase().includes('7') ||
          k.toLowerCase().includes('30') ||
          k.toLowerCase().includes('pnl')
        )
        roiKeys.forEach(k => console.log(`  ${k}: ${JSON.stringify(d[k])}`))
        if (roiKeys.length === 0) {
          console.log('  All keys:', keys.slice(0, 30).join(', '))
          console.log('  Data:', JSON.stringify(d).slice(0, 500))
        }
      }
    }
  }
  
  // Also print all JSON URLs for overview
  console.log('\n=== All JSON API URLs ===')
  jsonResponses.forEach(r => console.log(`  ${r.url.split('?')[0]}`))
  
  await browser.close()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
