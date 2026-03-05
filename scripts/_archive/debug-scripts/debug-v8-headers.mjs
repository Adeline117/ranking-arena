#!/usr/bin/env node
/**
 * Debug: Capture recommend request headers, then reuse them to call more pages
 * Also test if the recommend endpoint accepts timeType filter
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('Debug: Capture and reuse recommend headers\n')

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await ctx.newPage()
  
  let capturedHeaders = null
  let capturedBody = null
  let recommendBaseUrl = null
  let capturedCookies = null

  // Intercept request to capture headers
  page.on('request', req => {
    const url = req.url()
    if (url.includes('trader/new/recommend') && req.method() === 'POST') {
      capturedHeaders = req.headers()
      capturedBody = req.postData()
      recommendBaseUrl = url.replace(/\?.*$/, '')
      console.log(`Captured request: ${recommendBaseUrl.split('/').slice(-3).join('/')}`)
      console.log(`  Headers: ${Object.keys(capturedHeaders).filter(k => !['content-length', 'host'].includes(k)).join(', ')}`)
      console.log(`  Body: ${capturedBody?.slice(0, 200)}`)
    }
  })

  // Also intercept first response to see data structure
  let firstResponse = null
  page.on('response', async resp => {
    const url = resp.url()
    if (url.includes('trader/new/recommend') && !firstResponse) {
      try {
        const json = await resp.json()
        firstResponse = json
        const items = json?.data?.result || []
        console.log(`\nFirst response: code=${json.code} items=${items.length} total=${json?.data?.total}`)
        if (items.length > 0) {
          const item = items[0]
          const stat = item.rankStat || {}
          const mddKeys = Object.keys(stat).filter(k => /draw/i.test(k))
          const wrKeys = Object.keys(stat).filter(k => /win/i.test(k))
          console.log(`  MDD keys: ${mddKeys.join(', ')}`)
          console.log(`  WR keys: ${wrKeys.join(', ')}`)
          console.log(`  First trader: uid=${item.trader?.uid} nick=${item.trader?.nickName}`)
          if (mddKeys.length > 0) console.log(`  First MDD: ${stat[mddKeys[0]]}`)
        }
      } catch {}
    }
  })

  await page.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 60000
  }).catch(() => {})
  await sleep(4000)

  if (!capturedHeaders) {
    console.log('ERROR: No recommend request captured')
    await browser.close()
    return
  }

  // Now use captured headers to fetch more pages via evaluate
  console.log('\n--- Testing manual API calls with captured headers ---')
  
  const testPages = async (pageIds, sortType = null) => {
    const results = []
    for (const pageId of pageIds) {
      const bodyObj = JSON.parse(capturedBody || '{}')
      if (sortType) bodyObj.sortType = sortType
      bodyObj.pageId = pageId

      const result = await page.evaluate(async ({ url, headers, body }) => {
        try {
          const r = await fetch(`${url}?pageId=${body.pageId}&pageSize=12`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'include',
          })
          const json = await r.json()
          const items = json?.data?.result || []
          const hasMDD = items.some(i => {
            const stat = i.rankStat || {}
            return Object.keys(stat).some(k => /draw/i.test(k) && stat[k] != null)
          })
          return {
            code: json.code,
            count: items.length,
            total: json?.data?.total,
            hasMDD,
            sample: items.slice(0, 2).map(i => ({
              uid: i.trader?.uid,
              nick: i.trader?.nickName,
              mdd: (i.rankStat?.maxDrawDown ?? i.rankStat?.maxDrawdown ?? i.rankStat?.maxDrawDown90d)
            }))
          }
        } catch (e) {
          return { error: e.message }
        }
      }, { url: recommendBaseUrl, headers: capturedHeaders, body: bodyObj })
      
      results.push({ pageId, ...result })
      if (result.error) {
        console.log(`  Page ${pageId}: ERROR ${result.error}`)
        break
      }
      console.log(`  Page ${pageId}: code=${result.code} items=${result.count} total=${result.total} hasMDD=${result.hasMDD}`)
      if (result.count > 0 && result.sample) {
        for (const s of result.sample) {
          console.log(`    uid=${s.uid} nick=${s.nick} mdd=${s.mdd}`)
        }
      }
      if (result.code !== 0 || result.count === 0) break
      await sleep(300)
    }
    return results
  }

  console.log('\nPages 0-5 (default sort):')
  await testPages([0, 1, 2, 3, 4, 5])

  // Also test with body timeType parameter
  console.log('\nTest with timeType=3 in body (90-day?):')
  try {
    const bodyObj = JSON.parse(capturedBody || '{}')
    const result = await page.evaluate(async ({ url, headers, body }) => {
      try {
        const r = await fetch(`${url}?pageId=0&pageSize=12`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, timeType: 3 }),
          credentials: 'include',
        })
        const json = await r.json()
        const items = json?.data?.result || []
        return {
          code: json.code,
          count: items.length,
          total: json?.data?.total,
          sample: items.slice(0,3).map(i => ({ uid: i.trader?.uid, mdd: i.rankStat?.maxDrawDown ?? i.rankStat?.maxDrawdown }))
        }
      } catch (e) { return { error: e.message } }
    }, { url: recommendBaseUrl, headers: capturedHeaders, body: bodyObj })
    console.log(`  timeType=3: code=${result.code} count=${result.count} total=${result.total}`)
    if (result.sample) for (const s of result.sample) console.log(`    uid=${s.uid} mdd=${s.mdd}`)
  } catch (e) {
    console.log(`  Error: ${e.message}`)
  }

  // Test how many total pages there are
  console.log('\nTest high page numbers:')
  await testPages([20, 40, 60, 80, 100])

  // Test with different sort types  
  console.log('\nTest different sort types (ROI, WR, copiers):')
  try {
    const bodyObj = JSON.parse(capturedBody || '{}')
    const sortTypes = ['ROI', 'WIN_RATE', 'COPIER', 'PROFIT']
    for (const st of sortTypes) {
      const bodyWithSort = { ...bodyObj, sortType: st, pageId: 0, pageSize: 12 }
      const result = await page.evaluate(async ({ url, headers, body }) => {
        try {
          const r = await fetch(`${url}?pageId=0&pageSize=12`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'include',
          })
          const json = await r.json()
          const items = json?.data?.result || []
          return { code: json.code, count: items.length, total: json?.data?.total, firstUid: items[0]?.trader?.uid }
        } catch (e) { return { error: e.message } }
      }, { url: recommendBaseUrl, headers: capturedHeaders, body: bodyWithSort })
      console.log(`  sortType=${st}: code=${result.code} count=${result.count} total=${result.total} firstUid=${result.firstUid}`)
      await sleep(300)
    }
  } catch (e) { console.log(`  Error: ${e.message}`) }

  // Check what the full recommend body looks like
  console.log('\nOriginal request body:')
  try { console.log(JSON.stringify(JSON.parse(capturedBody || '{}'), null, 2)) } catch { console.log(capturedBody) }
  
  await browser.close()
  console.log('\nDone')
}

main().catch(e => { console.error(e); process.exit(1) })
