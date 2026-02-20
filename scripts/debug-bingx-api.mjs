#!/usr/bin/env node
/**
 * Debug: Intercept BingX API responses to understand data structure
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const targetUIDs = new Set([
  '1514568988395085829', '1128507030853664777', '1312342878820540416',
  '1465855550719975424', '1314850918480257026', '1339191395874545700',
  '1378910400354312200', '1469964778594295800', '856009244589367300'
])

async function main() {
  console.log('🔍 BingX API Debug\n')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US'
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await ctx.newPage()
  const apiCalls = []
  const foundTraders = new Map()

  // Intercept ALL responses
  page.on('response', async resp => {
    const url = resp.url()
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    if (!url.includes('bingx.com') && !url.includes('qq-os.com')) return
    
    try {
      const json = await resp.json().catch(() => null)
      if (!json) return
      
      // Log interesting API calls
      apiCalls.push({ url: url.split('?')[0], code: json.code, dataKeys: Object.keys(json.data || {}).join(',') })
      
      // Extract traders
      const items = json?.data?.result || json?.data?.list || json?.data?.records || 
                    json?.data?.traders || json?.data?.rows || 
                    (Array.isArray(json?.data) ? json.data : [])
      
      for (const item of items) {
        const uid = String(item.trader?.uid || item.uid || item.traderId || item.uniqueId || '')
        if (!uid) continue
        const stat = item.rankStat || item.stat || item
        
        // Check for MDD fields
        const mddFields = {
          maxDrawdown: stat.maxDrawdown,
          maxDrawDown90d: stat.maxDrawDown90d,
          maxDrawdown90d: stat.maxDrawdown90d,
          maximumDrawDown: stat.maximumDrawDown,
          maximumDrawDown90d: stat.maximumDrawDown90d,
        }
        const hasMDD = Object.values(mddFields).some(v => v != null)
        
        if (!foundTraders.has(uid)) {
          foundTraders.set(uid, { uid, mddFields, hasMDD, statKeys: Object.keys(stat) })
        }
        
        if (targetUIDs.has(uid)) {
          console.log(`  ✅ FOUND TARGET ${uid}:`)
          console.log(`     MDD fields: ${JSON.stringify(mddFields)}`)
          console.log(`     stat keys: ${Object.keys(stat).join(', ')}`)
        }
      }
      
      // Also check for single trader response
      const d = json?.data
      if (d?.winRate != null || d?.maxDrawdown != null || d?.maxDrawDown90d != null) {
        console.log(`  Single trader response from ${url.split('?')[0]}:`)
        console.log(`    winRate=${d.winRate} maxDrawdown=${d.maxDrawdown} maxDrawDown90d=${d.maxDrawDown90d}`)
        console.log(`    all keys: ${Object.keys(d).join(', ')}`)
      }
    } catch (e) {
      // ignore
    }
  })

  // Also capture request info
  let capturedHeaders = null
  page.on('request', req => {
    if (req.method() === 'POST' && (req.url().includes('recommend') || req.url().includes('trader'))) {
      if (!capturedHeaders) capturedHeaders = req.headers()
      console.log(`  REQ: ${req.url().split('?')[0]} [POST]`)
    }
  })

  // 1. Load main futures copy trading page
  console.log('1. Loading futures copy trading page...')
  await page.goto('https://bingx.com/en/copytrading/', { waitUntil: 'networkidle', timeout: 60000 })
    .catch(() => console.log('   timeout'))
  await sleep(5000)
  console.log(`   Traders found so far: ${foundTraders.size}`)

  // 2. Scroll to trigger more loads
  console.log('2. Scrolling...')
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollBy(0, 600))
    await sleep(1500)
  }
  console.log(`   Traders: ${foundTraders.size}`)

  // 3. Try loading a specific trader detail page
  console.log('\n3. Loading a target trader detail page...')
  const uid = '1339191395874545700' // "golden faucet"
  await page.goto(`https://bingx.com/en/copytrading/tradeDetail/${uid}`, { waitUntil: 'networkidle', timeout: 30000 })
    .catch(() => console.log('   timeout'))
  await sleep(5000)
  
  // Also try alternative URL formats
  console.log('3b. Trying alternative URL format...')
  await page.goto(`https://bingx.com/en/CopyTrading/tradeDetail/${uid}`, { waitUntil: 'networkidle', timeout: 30000 })
    .catch(() => console.log('   timeout'))
  await sleep(5000)

  // 4. Try the leaderboard page
  console.log('\n4. Loading leaderboard...')
  await page.goto('https://bingx.com/en/CopyTrading/leaderBoard', { waitUntil: 'networkidle', timeout: 30000 })
    .catch(() => console.log('   timeout'))
  await sleep(5000)

  await browser.close()

  // Summary
  console.log('\n\n=== API CALLS ===')
  const uniqueUrls = [...new Map(apiCalls.map(c => [c.url, c])).values()]
  for (const c of uniqueUrls) {
    console.log(`  ${c.url.replace('https://', '')}: code=${c.code} dataKeys=${c.dataKeys}`)
  }

  console.log(`\n=== TRADERS FOUND: ${foundTraders.size} ===`)
  const withMDD = [...foundTraders.values()].filter(t => t.hasMDD)
  const withoutMDD = [...foundTraders.values()].filter(t => !t.hasMDD)
  console.log(`  With MDD: ${withMDD.length}`)
  console.log(`  Without MDD: ${withoutMDD.length}`)
  
  if (withMDD.length > 0) {
    const sample = withMDD[0]
    console.log(`  Sample with MDD: ${sample.uid}`)
    console.log(`  MDD fields: ${JSON.stringify(sample.mddFields)}`)
    console.log(`  Stat keys: ${sample.statKeys.join(', ')}`)
  }
  if (withoutMDD.length > 0) {
    console.log(`  Sample without MDD stat keys: ${withoutMDD[0].statKeys.slice(0, 20).join(', ')}`)
  }

  const targetsFound = [...targetUIDs].filter(uid => foundTraders.has(uid))
  console.log(`\nTarget traders found: ${targetsFound.length}/${targetUIDs.size}`)
}

main().catch(e => { console.error(e); process.exit(1) })
