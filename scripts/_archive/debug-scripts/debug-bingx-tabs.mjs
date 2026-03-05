#!/usr/bin/env node
/**
 * Debug: Try all page tabs + leaderboard/ranking endpoints to find missing traders
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

const TARGET_UIDS = new Set([
  '1514568988395085829', '1128507030853664777', '1312342878820540416',
  '1465855550719975424', '1314850918480257026', '1339191395874545700',
  '1378910400354312200', '1469964778594295800', '856009244589367300',
  '1532885692632047623', '1373505428236574700', '879438778013589500',
  '1393239522299535400', '1008921387662278659', '1998800000085953',
  '1518262070860882000', '1533572897230856200', '945576862554107900',
])

async function main() {
  console.log('🔍 BingX Tabs Debug\n')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }, locale: 'en-US'
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await ctx.newPage()
  const allFound = new Map() // uid → stat
  const apiCallsSeen = new Set()

  page.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('qq-os.com') && !url.includes('bingx.com')) return
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    try {
      const json = await resp.json().catch(() => null)
      if (!json?.data) return
      const d = json.data
      const items = d.result || d.list || d.records || (Array.isArray(d) ? d : [])
      if (items.length > 0) {
        const ep = url.split('?')[0].split('/').slice(-3).join('/')
        if (!apiCallsSeen.has(ep)) {
          apiCallsSeen.add(ep)
          console.log(`  New API: ${ep} → ${items.length} items (total=${d.total || '?'})`)
        }
        for (const item of items) {
          const uid = String(item.trader?.uid || item.uid || item.uniqueId || '')
          if (!uid) continue
          const stat = item.rankStat || item.stat || {}
          if (TARGET_UIDS.has(uid)) {
            allFound.set(uid, stat)
            console.log(`  🎯 TARGET: ${uid} mdd90d=${stat.maxDrawDown90d} mddTotal=${stat.maximumDrawDown} wr=${stat.winRate90d}`)
          }
        }
      }
    } catch {}
  })

  console.log('Loading main page...')
  await page.goto('https://bingx.com/en/copytrading/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await sleep(3000)
  console.log(`Found ${allFound.size} targets so far\n`)

  // Try to find and click the "Leaderboard" tab
  console.log('Looking for Leaderboard tab...')
  const leaderboardEl = page.locator('text=Leaderboard').first()
  if (await leaderboardEl.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('  Clicking Leaderboard')
    await leaderboardEl.click()
    await sleep(5000)
    
    // Scroll on leaderboard
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 500))
      await sleep(1000)
    }
    console.log(`  After leaderboard scroll: ${allFound.size} targets`)
  }

  // Try Smart Ranking tab
  console.log('\nLooking for Smart Ranking tab...')
  const smartEl = page.locator('text=Smart Ranking').first()
  if (await smartEl.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('  Clicking Smart Ranking')
    await smartEl.click()
    await sleep(5000)
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 500))
      await sleep(1000)
    }
    console.log(`  After smart ranking scroll: ${allFound.size} targets`)
  }

  // Now test the public API endpoints from browser context (with CF cookies)
  console.log('\nTesting public API endpoints from browser context...')
  const testResults = await page.evaluate(async (uids) => {
    const results = {}
    
    // Test 1: queryLeaderBoard
    for (const sortType of [1, 2, 3]) {
      try {
        const r = await fetch('https://bingx.com/api/swap/v1/lead/traders/queryLeaderBoard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ sortType, pageNum: 1, pageSize: 50, timeType: 3 })
        })
        const j = await r.json()
        results[`queryLeaderBoard_sort${sortType}`] = {
          code: j.code,
          total: j.data?.total || j.data?.list?.length || 0,
          items: (j.data?.list || j.data?.result || []).length,
          firstUid: String((j.data?.list || j.data?.result || [])[0]?.uid || ''),
          hasMDD: !!(j.data?.list || j.data?.result || [])[0]?.maxDrawDown
        }
      } catch(e) {
        results[`queryLeaderBoard_sort${sortType}`] = { error: e.message.slice(0, 60) }
      }
    }
    
    // Test 2: lead trader detail
    for (const uid of uids.slice(0, 3)) {
      try {
        const r = await fetch('https://bingx.com/api/swap/v1/lead/traders/detail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ uid, timeType: 3 })
        })
        const j = await r.json()
        results[`leadDetail_${uid.slice(-6)}`] = {
          code: j.code,
          dataKeys: Object.keys(j.data || {}).join(',').slice(0, 100)
        }
      } catch(e) {
        results[`leadDetail_${uid.slice(-6)}`] = { error: e.message.slice(0, 60) }
      }
    }
    
    // Test 3: CopyTrading leaderboard endpoint
    for (const period of ['7D', '30D', '90D']) {
      try {
        const r = await fetch(`https://bingx.com/api/copytrading/v1/leaderboard?period=${period}&page=1&size=50`, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        })
        const j = await r.json()
        results[`leaderboard_${period}`] = {
          code: j.code,
          items: (j.data?.list || j.data?.result || []).length
        }
      } catch(e) {
        results[`leaderboard_${period}`] = { error: e.message.slice(0, 60) }
      }
    }

    return results
  }, [...TARGET_UIDS].slice(0, 10))
  
  console.log('\nAPI test results:')
  for (const [key, val] of Object.entries(testResults)) {
    if (val.code === 0 || val.items > 0) {
      console.log(`  ✅ ${key}: code=${val.code} items=${val.items} total=${val.total} firstUid=${val.firstUid} hasMDD=${val.hasMDD}`)
      console.log(`     dataKeys: ${val.dataKeys || ''}`)
    } else {
      console.log(`  ✗ ${key}: code=${val.code || 'err'} error=${val.error || ''}`)
    }
  }

  // Summary
  console.log(`\n\n=== SUMMARY ===`)
  console.log(`Targets found: ${allFound.size}/${TARGET_UIDS.size}`)
  console.log(`APIs seen: ${[...apiCallsSeen].join(' | ')}`)

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
