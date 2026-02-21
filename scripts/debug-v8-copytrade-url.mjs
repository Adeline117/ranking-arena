#!/usr/bin/env node
/**
 * Debug: Try bingx.com/en/copy-trading/ (WITH dash) 
 * and intercept ALL APIs, look for missing UIDs
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

const TARGET_UIDS = new Set([
  '1339191395874545700', '1378910400354312200', '1469964778594295800',
  '856009244589367300', '1532885692632047623', '1373505428236574700',
  '1998800000085953', '1518262070860882000', '1008921387662278659',
  '1533572897230856200', '945576862554107900', '879438778013589500',
])

function extractUidsFromText(text) {
  const matches = text.match(/"uid"\s*:\s*(\d{8,20})/g) || []
  return matches.map(m => m.match(/(\d{8,20})/)[1])
}

async function main() {
  console.log('Testing BingX copy-trading URLs\n')

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

  // Test both URLs
  const urls = [
    'https://bingx.com/en/copy-trading/',
    'https://bingx.com/en/copy-trading/leaderBoard',
    'https://bingx.com/en/copy-trading/leaderBoard?type=7d',
    'https://bingx.com/en/copy-trading/leaderBoard?type=90d',
  ]

  for (const testUrl of urls) {
    console.log(`\n=== Testing: ${testUrl} ===`)
    const page = await ctx.newPage()
    
    const foundApis = new Map()
    const foundUids = new Set()
    
    page.on('response', async resp => {
      const url = resp.url()
      const ct = resp.headers()['content-type'] || ''
      if (!ct.includes('json') && !ct.includes('text')) return
      
      try {
        const text = await resp.text()
        if (!text.startsWith('{') && !text.startsWith('[')) return
        
        const uids = extractUidsFromText(text)
        for (const u of uids) foundUids.add(u)
        
        let json = null
        try { json = JSON.parse(text) } catch {}
        if (!json) return
        
        const items = json?.data?.result || json?.data?.list || json?.data?.rows || 
                      json?.data?.records || (Array.isArray(json?.data) ? json.data : [])
        
        if (items.length > 0) {
          const shortUrl = url.replace(/\?.*$/, '').split('/').slice(-3).join('/')
          const hasDraw = /draw/i.test(text)
          const sample = items[0]
          const stat = sample.rankStat || sample.stat || {}
          const mddKeys = Object.keys(stat).filter(k => /draw/i.test(k))
          
          if (!foundApis.has(shortUrl)) {
            console.log(`  API: ${shortUrl} (${items.length} items, total=${json?.data?.total || '?'})`)
            console.log(`    hasDraw=${hasDraw} mddKeys=[${mddKeys.join(', ')}]`)
            if (mddKeys.length > 0) {
              console.log(`    first item mdd: ${stat[mddKeys[0]]}`)
            }
            foundApis.set(shortUrl, items.length)
          }
          
          // Check if targets found
          for (const item of items) {
            const uid = String(item.trader?.uid || item.uid || item.traderId || '')
            if (TARGET_UIDS.has(uid)) {
              console.log(`  🎯 TARGET: ${uid} (${item.trader?.nickName || ''}) mdd=${stat[mddKeys[0]]}`)
            }
          }
        }
      } catch {}
    })

    page.on('request', req => {
      const url = req.url()
      if ((url.includes('qq-os.com') || url.includes('bingx.com/api')) && req.method() !== 'GET') {
        // Track non-GET (POST) requests
        const shortUrl = url.replace(/\?.*$/, '').split('/').slice(-2).join('/')
        // Only show first occurrence
      }
    })

    await page.goto(testUrl, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(e => console.log(`  Nav error: ${e.message.slice(0, 60)}`))
    await sleep(6000)
    
    // Scroll to trigger lazy loading
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(500)
    }
    await sleep(2000)
    
    console.log(`  Total UIDs found: ${foundUids.size}`)
    const targetsFound = [...TARGET_UIDS].filter(u => foundUids.has(u))
    console.log(`  Target UIDs found: ${targetsFound.length}/${TARGET_UIDS.size}`)
    if (targetsFound.length > 0) {
      console.log(`  Found: ${targetsFound.join(', ')}`)
    }
    
    await page.close()
  }

  // Also try the topRanking endpoint directly (it might not need auth)
  console.log('\n=== Testing topRanking API directly ===')
  const apiPage = await ctx.newPage()
  await apiPage.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 60000
  }).catch(() => {})
  await sleep(3000)
  
  for (const [periodType, label] of [[1, '7D'], [2, '30D'], [3, '90D']]) {
    try {
      const result = await apiPage.evaluate(async ({ periodType }) => {
        try {
          const r = await fetch(`https://bingx.com/api/strategy/api/v1/copy/trader/topRanking?type=${periodType}&pageIndex=1&pageSize=50`, {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'Referer': 'https://bingx.com/en/CopyTrading/leaderBoard' }
          })
          const json = await r.json()
          return { code: json.code, count: json?.data?.list?.length || 0, raw: JSON.stringify(json).slice(0, 300) }
        } catch (e) { return { error: e.message } }
      }, { periodType })
      console.log(`  topRanking type=${periodType} (${label}): ${JSON.stringify(result)}`)
    } catch (e) {
      console.log(`  Error: ${e.message}`)
    }
    await sleep(500)
  }

  // Also try the multi-rank endpoint
  console.log('\n=== Testing multi-rank endpoint ===')
  try {
    const result = await apiPage.evaluate(async () => {
      try {
        const r = await fetch('https://api-app.qq-os.com/api/copy-trade-facade/v1/rank/multi-rank?pageSize=10&pageNum=1', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        })
        const json = await r.json()
        const items = json?.data?.result || json?.data?.list || json?.data?.data || []
        return { code: json.code, count: items.length, total: json?.data?.total, raw: JSON.stringify(json).slice(0, 400) }
      } catch (e) { return { error: e.message } }
    })
    console.log(`  multi-rank result: ${JSON.stringify(result)}`)
  } catch (e) {
    console.log(`  Error: ${e.message}`)
  }

  await browser.close()
  console.log('\nDone')
}

main().catch(e => { console.error(e); process.exit(1) })
