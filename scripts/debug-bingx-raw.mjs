#!/usr/bin/env node
/**
 * Debug: Raw recommend API response - find missing UIDs and their MDD
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
])

async function main() {
  console.log('🔍 BingX Raw API Debug\n')

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
  const allItems = []
  const apiCalls = []

  // Intercept ALL JSON responses
  page.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('qq-os.com') && !url.includes('bingx.com/api')) return
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    try {
      const json = await resp.json().catch(() => null)
      if (!json?.data) return
      const d = json.data
      const items = d.result || d.list || d.records || (Array.isArray(d) ? d : [])
      if (items.length > 0) {
        const ep = url.split('?')[0].replace('https://', '')
        apiCalls.push({ ep, total: d.total, count: items.length })
        for (const item of items) {
          const uid = String(item.trader?.uid || item.uid || item.uniqueId || '')
          const nick = item.trader?.nickName || item.nickName || ''
          const stat = item.rankStat || {}
          allItems.push({ uid, nick, stat, ep })
          
          if (TARGET_UIDS.has(uid)) {
            console.log(`\n  🎯 TARGET FOUND: ${uid} (${nick})`)
            console.log(`     rankStat keys: ${Object.keys(stat).join(', ')}`)
            console.log(`     mdd90d: ${stat.maxDrawDown90d}`)
            console.log(`     mddTotal: ${stat.maximumDrawDown}`)
            console.log(`     winRate90d: ${stat.winRate90d}`)
            console.log(`     Full stat: ${JSON.stringify(stat).slice(0, 500)}`)
          }
        }
      }
    } catch {}
  })

  console.log('Loading BingX copy trading...')
  await page.goto('https://bingx.com/en/copytrading/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await sleep(4000)
  
  console.log(`\nAPI calls: ${apiCalls.map(c => `${c.ep.split('/').pop()}(${c.count})`).join(', ')}`)
  console.log(`All items collected: ${allItems.length}`)
  
  const foundTargets = allItems.filter(i => TARGET_UIDS.has(i.uid))
  console.log(`\nTargets found in initial load: ${foundTargets.length}`)
  
  // Scroll to bottom
  console.log('\nScrolling...')
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(2000)
  }
  console.log(`After scroll: ${allItems.length} items, ${apiCalls.length} API calls`)
  console.log(`API calls: ${apiCalls.slice(-5).map(c => `${c.ep.split('/').pop()}(${c.count})`).join(', ')}`)

  // Try clicking different tabs to see if we get different data
  console.log('\nLooking for filter tabs...')
  
  // Print page text to understand structure
  const pageText = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, [role="tab"], [class*="tab"]')]
    return buttons.slice(0, 20).map(b => b.textContent?.trim()).filter(Boolean)
  })
  console.log('Page buttons/tabs:', pageText.join(' | '))

  // Check if any targets were found anywhere
  const totalTargetsFound = allItems.filter(i => TARGET_UIDS.has(i.uid)).length
  console.log(`\n\nTotal targets found: ${totalTargetsFound}/${TARGET_UIDS.size}`)

  // Show the first few items from recommend API (with their actual MDD values)
  const recommendItems = allItems.filter(i => i.ep.includes('recommend'))
  console.log(`\nRecommend API items (${recommendItems.length}):`);
  for (const item of recommendItems.slice(0, 5)) {
    console.log(`  ${item.uid} (${item.nick}): mdd90d=${item.stat.maxDrawDown90d} mdd=${item.stat.maximumDrawDown} wr=${item.stat.winRate90d}`)
  }
  
  // Check if any recommend items have null MDD
  const nullMddInRecommend = recommendItems.filter(i => i.stat.maxDrawDown90d == null && i.stat.maximumDrawDown == null)
  console.log(`\nRecommend items with null MDD: ${nullMddInRecommend.length}`)

  await browser.close()
  console.log('\n✅ Done')
}

main().catch(e => { console.error(e); process.exit(1) })
