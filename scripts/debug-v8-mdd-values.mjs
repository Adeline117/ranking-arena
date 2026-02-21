#!/usr/bin/env node
/**
 * Debug: Check actual MDD field values in the recommend API
 * Show all MDD/WR fields for all traders on page 1
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const browser = await chromium.launch({
    headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }, locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await ctx.newPage()
  let capturedItems = []

  page.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('recommend') && !url.includes('trader/search')) return
    try {
      const text = await resp.text()
      const json = JSON.parse(text)
      if (json.code !== 0) return
      const items = json?.data?.result || []
      if (capturedItems.length === 0) {
        capturedItems = items
      }
    } catch {}
  })

  await page.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 60000
  }).catch(() => {})
  await sleep(3000)

  console.log(`Captured ${capturedItems.length} traders from page 1\n`)
  
  for (let i = 0; i < Math.min(5, capturedItems.length); i++) {
    const item = capturedItems[i]
    const trader = item.trader || {}
    const stat = item.rankStat || {}
    
    console.log(`\nTrader ${i+1}: uid=${trader.uid} nick="${trader.nickName}"`)
    
    // Show all MDD fields
    const mddFields = Object.entries(stat).filter(([k]) => /draw/i.test(k))
    console.log('  MDD fields:')
    for (const [k, v] of mddFields) {
      console.log(`    ${k} = "${v}" (type: ${typeof v})`)
    }
    
    // Show all WR fields
    const wrFields = Object.entries(stat).filter(([k]) => /win/i.test(k))
    console.log('  WR fields:')
    for (const [k, v] of wrFields) {
      if (typeof v !== 'object') console.log(`    ${k} = "${v}"`)
    }
    
    // Show a few more stats
    const otherFields = Object.entries(stat)
      .filter(([k, v]) => typeof v !== 'object' && v != null)
      .slice(0, 5)
    console.log('  Other stats:')
    for (const [k, v] of otherFields) {
      if (!/draw|win/i.test(k)) console.log(`    ${k} = "${v}"`)
    }
  }

  // Also check if any traders on later pages have non-zero MDD
  console.log('\n\n=== Checking later pages for non-zero MDD ===')
  
  let nonZeroMDDs = 0
  let totalChecked = 0
  
  page.removeAllListeners('response')
  
  const allItems = []
  page.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('recommend') && !url.includes('trader/search')) return
    try {
      const text = await resp.text()
      const json = JSON.parse(text)
      if (json.code !== 0) return
      const items = json?.data?.result || []
      for (const item of items) {
        allItems.push(item)
        const stat = item.rankStat || {}
        const mdd = stat.maxDrawDown || stat.maxDrawdown || stat.maxDrawDown90d
        if (mdd && mdd !== '0.00%' && mdd !== '0' && mdd !== 0) {
          nonZeroMDDs++
          const uid = item.trader?.uid
          const nick = item.trader?.nickName
          if (nonZeroMDDs <= 5) {
            console.log(`  Non-zero MDD: uid=${uid} nick="${nick}" maxDrawDown=${stat.maxDrawDown} maxDrawDown90d=${stat.maxDrawDown90d}`)
          }
        }
        totalChecked++
      }
    } catch {}
  })

  // Click through a few pages
  for (let p = 0; p < 5; p++) {
    let clicked = false
    try {
      const cells = await page.locator('.page-cell').all()
      if (cells.length > 0) {
        let activeIdx = -1
        for (let i = 0; i < cells.length; i++) {
          const isActive = await cells[i].evaluate(el => el.classList.contains('active')).catch(() => false)
          if (isActive) { activeIdx = i; break }
        }
        if (activeIdx >= 0 && activeIdx + 1 < cells.length) {
          await cells[activeIdx + 1].click()
          clicked = true
        } else if (cells.length > 0) {
          await cells[cells.length - 1].click()
          clicked = true
        }
      }
    } catch {}
    if (!clicked) break
    await sleep(1500)
  }
  
  await sleep(1000)
  console.log(`\nChecked ${totalChecked} items, found ${nonZeroMDDs} with non-zero MDD`)
  console.log(`All-items total: ${allItems.length}`)
  
  // Show distribution of maxDrawDown values
  const mddValues = new Map()
  for (const item of allItems) {
    const v = String(item.rankStat?.maxDrawDown || 'null')
    mddValues.set(v, (mddValues.get(v) || 0) + 1)
  }
  console.log('\nmaxDrawDown value distribution (top 10):')
  const sorted = [...mddValues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  for (const [v, count] of sorted) {
    console.log(`  "${v}": ${count} traders`)
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
