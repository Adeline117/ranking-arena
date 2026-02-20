#!/usr/bin/env node
/**
 * Debug: Find the right detail page URL for a BingX trader
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const TEST_UID = '1339191395874545700' // "golden faucet" - known MDD null trader

async function main() {
  console.log(`Testing detail page for UID: ${TEST_UID}\n`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }, locale: 'en-US'
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  // First get CF cookies by loading main page
  const mainPage = await ctx.newPage()
  console.log('Getting CF cookies...')
  await mainPage.goto('https://bingx.com/en/copytrading/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await sleep(6000)

  // Collect the first page recommend data
  let interceptedTraders = []
  mainPage.on('response', async resp => {
    if (!resp.url().includes('recommend')) return
    try {
      const json = await resp.json()
      if (json?.data?.result) {
        interceptedTraders = json.data.result.map(item => ({
          uid: String(item.trader?.uid || ''),
          mdd90d: item.rankStat?.maxDrawDown90d,
          mddTotal: item.rankStat?.maximumDrawDown,
        }))
      }
    } catch {}
  })

  // Now try clicking sort buttons to trigger more API calls
  console.log('\nLooking for sort options...')
  try {
    // Look for sort dropdown/tabs
    const sortButtons = await mainPage.$$('[class*="sort"], [class*="Sort"], [class*="filter"], [class*="Filter"], [class*="tab"], [class*="Tab"]')
    console.log(`  Found ${sortButtons.length} potential sort elements`)
    
    // Try clicking tabs to change sort
    for (const btn of sortButtons.slice(0, 5)) {
      try {
        const text = await btn.innerText().catch(() => '')
        if (text.trim()) console.log(`  Sort element: "${text.trim()}"`)
      } catch {}
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`)
  }

  // Try to find pagination
  try {
    const pageBtns = await mainPage.$$('[class*="page"], [class*="Page"], button[class*="next"], [aria-label*="next"]')
    console.log(`  Pagination elements: ${pageBtns.length}`)
  } catch {}

  await mainPage.close()

  // Now try trader detail pages
  const urlFormats = [
    `https://bingx.com/en/copytrading/tradeDetail/${TEST_UID}`,
    `https://bingx.com/en/CopyTrading/tradeDetail/${TEST_UID}`,
    `https://bingx.com/en/copytrading/${TEST_UID}`,
    `https://bingx.com/en/CopyTrading/${TEST_UID}`,
  ]

  for (const url of urlFormats) {
    const testPage = await ctx.newPage()
    const apis = []
    let found = false

    testPage.on('response', async resp => {
      const rurl = resp.url()
      if (!rurl.includes('trader') && !rurl.includes('copy')) return
      const ct = resp.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      try {
        const json = await resp.json().catch(() => null)
        if (!json) return
        const d = json?.data || {}
        const mddKeys = Object.keys(d).filter(k => k.toLowerCase().includes('drawdown') || k.toLowerCase().includes('mdd'))
        const wrKeys = Object.keys(d).filter(k => k.toLowerCase().includes('winrate') || k.toLowerCase().includes('win_rate'))
        if (mddKeys.length > 0 || wrKeys.length > 0) {
          found = true
          apis.push({ rurl: rurl.split('?')[0].replace('https://', ''), mddKeys, wrKeys, mddVals: Object.fromEntries(mddKeys.map(k => [k, d[k]])) })
        }
      } catch {}
    })

    console.log(`\nTrying: ${url}`)
    try {
      await testPage.goto(url, { waitUntil: 'networkidle', timeout: 20000 })
      await sleep(3000)
      const finalUrl = testPage.url()
      if (finalUrl !== url) console.log(`  Redirected to: ${finalUrl}`)
    } catch (e) {
      console.log(`  Error: ${e.message.slice(0, 60)}`)
    }

    if (found) {
      console.log('  ✅ FOUND trader data!')
      for (const a of apis) {
        console.log(`     API: ${a.rurl}`)
        console.log(`     MDD keys: ${a.mddKeys.join(', ')}`)
        console.log(`     MDD vals: ${JSON.stringify(a.mddVals)}`)
        console.log(`     WR keys: ${a.wrKeys.join(', ')}`)
      }
    } else {
      console.log('  ❌ No trader data found')
    }

    await testPage.close()
  }

  // Also try the recommend API filtering - see if we can filter by specific UIDs
  // or use the "detail" endpoint
  console.log('\n\nTesting API endpoints...')
  const testPage2 = await ctx.newPage()
  
  // Get cookies from context
  const cookies = await ctx.cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  
  const testEndpoints = [
    { url: `https://bingx.com/api/copytrading/v1/trader/detail?uid=${TEST_UID}&timeType=3`, method: 'GET' },
    { url: `https://bingx.com/api/copytrading/v1/trader/detail?uid=${TEST_UID}`, method: 'GET' },
    { url: `https://bingx.com/api/copytrading/v1/trader/portfolio?uid=${TEST_UID}`, method: 'GET' },
    { url: `https://bingx.com/api/copytrading/v1/trader/analysis?uid=${TEST_UID}`, method: 'GET' },
  ]
  
  for (const { url, method } of testEndpoints) {
    try {
      const result = await testPage2.evaluate(async ({ url, method, cookieStr }) => {
        const r = await fetch(url, {
          method,
          credentials: 'include',
          headers: { 'Cookie': cookieStr }
        })
        const status = r.status
        const text = await r.text()
        return { status, text: text.slice(0, 300) }
      }, { url, method, cookieStr })
      console.log(`  ${url.split('bingx.com')[1].split('?')[0]}: ${result.status} ${result.text.slice(0, 150)}`)
    } catch (e) {
      console.log(`  Error: ${e.message.slice(0, 60)}`)
    }
  }

  await testPage2.close()
  await browser.close()
  console.log('\n✅ Debug done')
}

main().catch(e => { console.error(e); process.exit(1) })
