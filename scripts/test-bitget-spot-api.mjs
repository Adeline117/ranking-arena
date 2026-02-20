#!/usr/bin/env node
/**
 * Test script: intercept ALL Bitget Spot copy-trading trader API calls
 * to find the right endpoint and field names for 7d/30d ROI
 */
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const TRADER_ID = process.argv[2] || 'b0b0497186b63851a195'

async function main() {
  console.log(`Testing trader: ${TRADER_ID}`)
  console.log(`URL: https://www.bitget.com/copy-trading/trader/${TRADER_ID}/spot\n`)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  await ctx.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css}', route => route.abort())
  const page = await ctx.newPage()

  const allResponses = []
  page.on('response', async (resp) => {
    const url = resp.url()
    if (!url.includes('bitget') || !url.includes('/api/')) return
    try {
      const json = await resp.json()
      if (json?.data) {
        allResponses.push({ url, data: json })
        console.log(`\n=== API: ${url.split('?')[0]} ===`)
        if (json.data && typeof json.data === 'object') {
          // Print all keys
          const keys = Object.keys(json.data)
          console.log('Top-level keys:', keys.slice(0, 20).join(', '))
          
          // Check for nested traderDataVo or allData
          const d = json.data.traderDataVo?.allData || json.data.allData || json.data
          if (d && typeof d === 'object') {
            const dkeys = Object.keys(d)
            console.log('Data keys:', dkeys.join(', '))
            // Print values for ROI-related keys
            const roiKeys = dkeys.filter(k => 
              k.toLowerCase().includes('roi') || 
              k.toLowerCase().includes('profit') ||
              k.toLowerCase().includes('week') ||
              k.toLowerCase().includes('month') ||
              k.toLowerCase().includes('7') ||
              k.toLowerCase().includes('30') ||
              k.toLowerCase().includes('day')
            )
            if (roiKeys.length) {
              console.log('ROI-related fields:')
              roiKeys.forEach(k => console.log(`  ${k}: ${JSON.stringify(d[k])}`))
            }
          }
        }
      }
    } catch {}
  })

  console.log('Navigating...')
  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${TRADER_ID}/spot`,
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    )
  } catch (e) {
    console.log('Navigation error (may be OK):', e.message)
  }
  
  // Wait for API calls
  await sleep(8000)
  
  console.log(`\n=== Total API responses captured: ${allResponses.length} ===`)
  
  // Print complete data for traderDetailPage response
  const detail = allResponses.find(r => r.url.includes('traderDetailPage') || r.url.includes('trader-detail'))
  if (detail) {
    console.log('\n=== FULL traderDetailPage response ===')
    console.log(JSON.stringify(detail.data, null, 2).slice(0, 5000))
  }

  // Check /v2/copy/spot-trader URLs
  const v2Responses = allResponses.filter(r => r.url.includes('/v2/copy'))
  if (v2Responses.length) {
    console.log('\n=== V2 Copy API responses ===')
    v2Responses.forEach(r => {
      console.log(`URL: ${r.url}`)
      console.log(`Data: ${JSON.stringify(r.data).slice(0, 500)}`)
    })
  }
  
  await browser.close()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
