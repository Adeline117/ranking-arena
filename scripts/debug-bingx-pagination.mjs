#!/usr/bin/env node
/**
 * Debug: Paginate BingX copy trading page to find target traders
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Target UIDs we need MDD for
const TARGET_UIDS = new Set([
  '1514568988395085829', '1128507030853664777', '1312342878820540416',
  '1465855550719975424', '1314850918480257026', '1339191395874545700',
  '1378910400354312200', '1469964778594295800', '856009244589367300',
  '1373505428236574700', '879438778013589500', '1393239522299535400',
  '1008921387662278659', '1998800000085953', '1532885692632047623',
])

async function main() {
  console.log('🔍 BingX Pagination Debug\n')

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
  const collectedTraders = new Map()
  const apiCallLog = []

  // Intercept recommend API responses
  page.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('recommend') && !url.includes('trader/ranking') && !url.includes('topRanking') && !url.includes('leaderBoard')) return
    try {
      const json = await resp.json().catch(() => null)
      if (!json?.data) return
      const items = json.data.result || json.data.list || json.data.rows || []
      const total = json.data.total || items.length
      apiCallLog.push({ url: url.split('?')[0], pageId: json.data.pageId, total, count: items.length })
      console.log(`  Response: ${url.split('/').pop()?.split('?')[0] || url.split('/').slice(-2).join('/')} pageId=${json.data.pageId} total=${total} count=${items.length}`)
      
      for (const item of items) {
        const uid = String(item.trader?.uid || item.uid || '')
        if (!uid) continue
        const stat = item.rankStat || {}
        collectedTraders.set(uid, {
          uid,
          mdd90d: stat.maxDrawDown90d,
          mdd7d: stat.maxDrawDown7d,
          mddTotal: stat.maximumDrawDown,
          wr90d: stat.winRate90d,
          isTarget: TARGET_UIDS.has(uid),
        })
        if (TARGET_UIDS.has(uid)) {
          console.log(`  🎯 FOUND TARGET ${uid}: MDD90d=${stat.maxDrawDown90d} MDD7d=${stat.maxDrawDown7d}`)
        }
      }
    } catch {}
  })

  // Also intercept CDP for request data
  let capturedHeaders = null
  let capturedBody = null
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (request.url.includes('recommend') && request.method === 'POST') {
      capturedHeaders = request.headers
      try { capturedBody = JSON.parse(request.postData || '{}') } catch {}
      console.log(`  CDP captured headers for recommend API`)
    }
  })

  // Load the page
  console.log('Loading BingX copy trading...')
  await page.goto('https://bingx.com/en/copytrading/', { waitUntil: 'networkidle', timeout: 60000 })
    .catch(() => console.log('  timeout'))
  await sleep(3000)
  console.log(`  Collected: ${collectedTraders.size} traders`)
  
  const total_in_api = apiCallLog[0]?.total || 0
  console.log(`  API total: ${total_in_api}`)

  // Try to use captured headers to paginate (fast approach)
  if (capturedHeaders && total_in_api > 12) {
    console.log('\nTrying to paginate via page.evaluate with captured headers...')
    const pageSize = capturedBody?.pageSize || 12
    const totalPages = Math.ceil(total_in_api / pageSize)
    console.log(`  ${totalPages} pages of ${pageSize} traders`)
    
    for (let p = 1; p < Math.min(totalPages + 1, 30); p++) {
      try {
        const body = { ...(capturedBody || {}), pageId: p, pageSize }
        await page.evaluate(async ({ url, headers, body }) => {
          await fetch(`${url}?pageId=${body.pageId}&pageSize=${body.pageSize}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
          })
        }, { 
          url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend',
          headers: capturedHeaders,
          body
        })
        await sleep(600)
        console.log(`  Page ${p}: total collected = ${collectedTraders.size}`)
      } catch (e) {
        console.log(`  Page ${p} error: ${e.message.slice(0, 60)}`)
        break
      }
    }
  }

  // Try clicking sort/filter options
  console.log('\nLooking for clickable elements...')
  
  // Try to find the leaderboard tab or different sort options
  const selectors = [
    'text=7D', 'text=30D', 'text=90D',
    '[data-tab="7D"]', '[data-tab="30D"]',
    'button:has-text("7")', 'button:has-text("30")',
  ]
  
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log(`  Clicking: ${sel}`)
        await el.click()
        await sleep(3000)
        console.log(`  After click: ${collectedTraders.size} traders`)
      }
    } catch {}
  }

  // Try navigating to leaderboard URL
  console.log('\nLoading leaderboard...')
  await page.goto('https://bingx.com/en/CopyTrading/leaderBoard', { waitUntil: 'networkidle', timeout: 30000 })
    .catch(() => console.log('  timeout'))
  await sleep(5000)
  console.log(`  After leaderboard: ${collectedTraders.size} traders`)

  // Try trader ranking endpoint
  console.log('\nTrying trader ranking page...')
  await page.goto('https://bingx.com/en/CopyTrading/ranking', { waitUntil: 'networkidle', timeout: 30000 })
    .catch(() => console.log('  timeout'))
  await sleep(5000)
  console.log(`  After ranking: ${collectedTraders.size} traders`)

  // List all API calls
  console.log('\n\n=== API CALLS ===')
  for (const c of apiCallLog) {
    console.log(`  ${c.url.replace('https://api-app.qq-os.com/', '')}: pageId=${c.pageId} total=${c.total} count=${c.count}`)
  }

  // List found targets
  const targetsFound = [...collectedTraders.values()].filter(t => t.isTarget)
  console.log(`\n=== TARGETS FOUND: ${targetsFound.length} ===`)
  for (const t of targetsFound) {
    console.log(`  ${t.uid}: MDD90d=${t.mdd90d} MDD7d=${t.mdd7d} mddTotal=${t.mddTotal}`)
  }
  
  console.log(`\nTotal traders collected: ${collectedTraders.size}`)

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
