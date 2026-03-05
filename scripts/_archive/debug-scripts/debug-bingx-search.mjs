#!/usr/bin/env node
/**
 * Debug: Test BingX trader search endpoints from browser context
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const TEST_UIDS = ['1339191395874545700', '856009244589367300', '1998800000085953']

async function main() {
  console.log('🔍 BingX Search API Debug\n')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }, locale: 'en-US'
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  // Load main page + capture headers & cookies
  const page = await ctx.newPage()
  let capturedFuturesHeaders = null
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (request.method === 'POST' && request.url.includes('recommend') && !capturedFuturesHeaders) {
      capturedFuturesHeaders = request.headers
      console.log('✅ Headers captured')
    }
  })

  console.log('Loading main page...')
  await page.goto('https://bingx.com/en/copytrading/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await sleep(5000)

  // Try various search/detail endpoints for each test UID
  for (const uid of TEST_UIDS) {
    console.log(`\n--- UID: ${uid} ---`)
    
    const result = await page.evaluate(async ({ uid, headers }) => {
      const endpoints = [
        // Search endpoints
        { url: `https://bingx.com/api/copytrading/v1/trader/search?keyword=${uid}`, method: 'GET' },
        { url: `https://bingx.com/api/copytrading/v1/trader/search?uid=${uid}`, method: 'GET' },
        // Detail endpoints  
        { url: `https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}&timeType=3`, method: 'GET' },
        { url: `https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}`, method: 'GET' },
        { url: `https://bingx.com/api/copytrading/v1/trader/portfolio?uid=${uid}`, method: 'GET' },
        { url: `https://bingx.com/api/copytrading/v1/trader/analysis?uid=${uid}&timeType=3`, method: 'GET' },
        // Strategy endpoints
        { url: `https://bingx.com/api/strategy/api/v1/copy/trader/detail?uid=${uid}`, method: 'GET' },
        // New API format
        { url: `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/detail?uid=${uid}`, method: 'GET', useHeaders: true },
        { url: `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/info?uid=${uid}`, method: 'GET', useHeaders: true },
        { url: `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/stat?uid=${uid}&timeType=3`, method: 'GET', useHeaders: true },
        // POST endpoints
        { url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/detail', method: 'POST', body: { uid, timeType: 3 }, useHeaders: true },
        { url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/search', method: 'POST', body: { keyword: uid, pageId: 0, pageSize: 10 }, useHeaders: true },
        { url: 'https://bingx.com/api/copytrading/v1/trader/query', method: 'POST', body: { uid } },
      ]
      
      const results = {}
      for (const ep of endpoints) {
        try {
          const opts = {
            method: ep.method,
            credentials: 'include',
          }
          if (ep.useHeaders && headers) {
            opts.headers = { ...headers }
          }
          if (ep.body) {
            opts.headers = { ...(opts.headers || {}), 'Content-Type': 'application/json' }
            opts.body = JSON.stringify(ep.body)
          }
          const r = await fetch(ep.url, opts)
          const text = await r.text()
          let parsed = null
          try { parsed = JSON.parse(text) } catch {}
          
          const key = ep.url.replace('https://', '').split('?')[0].split('/').slice(-2).join('/')
          if (parsed) {
            const d = parsed?.data
            const keys = d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d) : []
            const mddKeys = keys.filter(k => k.toLowerCase().includes('draw') || k.toLowerCase().includes('mdd'))
            const hasItems = d?.result?.length || d?.list?.length || 0
            results[key] = { 
              code: parsed.code, 
              status: r.status,
              dataKeys: keys.slice(0, 8).join(','),
              mddKeys,
              hasItems,
              raw: JSON.stringify(d || parsed).slice(0, 300)
            }
          } else {
            results[key] = { status: r.status, html: text.slice(0, 50) }
          }
        } catch(e) {
          const key = ep.url.split('/').slice(-1)[0].split('?')[0]
          results[key] = { error: e.message.slice(0, 80) }
        }
      }
      return results
    }, { uid, headers: capturedFuturesHeaders })

    for (const [key, val] of Object.entries(result)) {
      if (val.code === 0) {
        console.log(`  ✅ ${key}: code=${val.code} items=${val.hasItems || 0}`)
        console.log(`     data keys: ${val.dataKeys}`)
        if (val.mddKeys?.length) console.log(`     🎯 MDD keys: ${val.mddKeys.join(', ')}`)
        if (val.hasItems) console.log(`     items: ${val.hasItems}`)
        console.log(`     raw: ${val.raw.slice(0, 200)}`)
      } else if (val.error) {
        console.log(`  ✗ ${key}: error=${val.error}`)
      } else {
        console.log(`  ✗ ${key}: code=${val.code} status=${val.status}`)
      }
    }
    await sleep(200)
  }

  // Also test the actual recommend API with pagination via evaluate
  console.log('\n--- Testing recommend API with sort types ---')
  if (capturedFuturesHeaders) {
    const result2 = await page.evaluate(async (headers) => {
      const sortTypes = [1, 2, 3, 4, 5, 6]
      const results = {}
      for (const st of sortTypes) {
        try {
          const r = await fetch('https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=0&pageSize=50', {
            method: 'POST',
            headers,
            body: JSON.stringify({ sortType: st, pageId: 0, pageSize: 50 })
          })
          const j = await r.json()
          results[`sortType_${st}`] = { code: j.code, total: j.data?.total, items: j.data?.result?.length }
        } catch(e) {
          results[`sortType_${st}`] = { error: e.message.slice(0, 60) }
        }
      }
      
      // Also try ranking endpoint
      try {
        const r = await fetch('https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/ranking?pageId=0&pageSize=50', {
          method: 'POST',
          headers,
          body: JSON.stringify({ pageId: 0, pageSize: 50 })
        })
        const j = await r.json()
        results['ranking'] = { code: j.code, total: j.data?.total, items: j.data?.result?.length }
      } catch(e) { results['ranking'] = { error: e.message } }
      
      return results
    }, capturedFuturesHeaders)
    console.log(JSON.stringify(result2, null, 2))
  } else {
    console.log('  No headers captured!')
  }

  await browser.close()
  console.log('\n✅ Debug done')
}

main().catch(e => { console.error(e); process.exit(1) })
