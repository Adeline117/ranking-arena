#!/usr/bin/env node
/**
 * Test: Trigger more API calls by scrolling and clicking UI elements
 * Goal: Get as many traders with MDD data as possible via browser interactions
 */
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
})
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
const allTraders = new Map()  // shortUid → {mdd, winRate, nickName}

page.on('response', async (resp) => {
  const url = resp.url()
  if (!url.includes('qq-os.com')) return
  try {
    const json = await resp.json()
    const str = JSON.stringify(json)
    if (!str.includes('maxDrawDown') && !str.includes('rankStat')) return
    
    console.log(`\n📥 API with stats: ${url}`)
    const items = json?.data?.result || json?.data?.list || []
    for (const item of items) {
      const trader = item?.trader || {}
      const rankStat = item?.rankStat || {}
      const shortUid = String(trader.shortUid || '')
      const uid = String(trader.uid || '')
      const mdd = rankStat.maxDrawDown ?? rankStat.maximumDrawDown ?? null
      const wr = rankStat.winRate ?? null
      const nick = trader.nickName || ''
      if (shortUid) {
        allTraders.set(shortUid, { mdd, wr, nick, uid })
        allTraders.set(uid, { mdd, wr, nick, uid })
      }
    }
    console.log(`  → ${items.length} traders, total captured: ${new Set([...allTraders.keys()].filter(k => k.length < 12)).size}`)
  } catch {}
})

console.log('Loading main CopyTrading page...')
await page.goto('https://bingx.com/en/CopyTrading/', {
  waitUntil: 'networkidle', timeout: 30000
}).catch(e => console.log('Nav:', e.message))
await sleep(3000)

console.log(`After initial load: ${allTraders.size/2} unique traders`)

// Try scrolling to load more
console.log('\nScrolling to load more traders...')
for (let i = 0; i < 10; i++) {
  await page.evaluate((i) => window.scrollTo(0, window.scrollY + 500 * i), i)
  await sleep(1500)
}
console.log(`After scrolling: ${allTraders.size/2} unique traders`)

// Try clicking sort buttons
console.log('\nLooking for sort/filter buttons...')
const buttons = await page.evaluate(() => {
  const allBtns = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], a'))
    .filter(b => {
      const text = b.textContent?.trim() || ''
      return text.length > 0 && text.length < 30
    })
    .map(b => ({ text: b.textContent?.trim(), tag: b.tagName, classes: b.className?.slice(0, 50) }))
  return allBtns.slice(0, 30)
})
console.log('UI elements found:')
buttons.forEach(b => console.log(`  ${b.tag}[${b.classes}]: "${b.text}"`))

// Look for sort options and click them
const sortTexts = ['Return Rate', 'Win Rate', 'Copy Traders', 'Profit', 'ROI', '30D Return', '7D', '30D', '90D']
for (const text of sortTexts) {
  try {
    const btn = page.locator(`[role="tab"]:has-text("${text}"), button:has-text("${text}"), [class*="tab"]:has-text("${text}")`).first()
    if (await btn.isVisible({ timeout: 1000 })) {
      console.log(`\nClicking "${text}" sort...`)
      await btn.click()
      await sleep(3000)
      console.log(`  After clicking ${text}: ${allTraders.size/2} unique traders`)
    }
  } catch {}
}

// Try "Load more" or pagination buttons
const loadMoreTexts = ['Load More', 'Show More', 'View More', 'Next', 'See More']
for (const text of loadMoreTexts) {
  try {
    const btn = page.locator(`button:has-text("${text}"), [role="button"]:has-text("${text}")`).first()
    if (await btn.isVisible({ timeout: 1000 })) {
      console.log(`\nClicking "${text}"...`)
      await btn.click()
      await sleep(3000)
      console.log(`  After "${text}": ${allTraders.size/2} unique traders`)
    }
  } catch {}
}

// Try clicking on all filter/tab options
const allTabEls = await page.$$('[role="tab"], [class*="sortItem"], [class*="sort-item"], [class*="SortItem"]')
console.log(`\nFound ${allTabEls.length} tab/sort elements`)
for (const el of allTabEls.slice(0, 10)) {
  try {
    const text = await el.innerText()
    if (!text.trim()) continue
    console.log(`  Clicking tab: "${text.trim()}"`)
    await el.click()
    await sleep(2000)
    console.log(`    → ${allTraders.size/2} unique traders`)
  } catch {}
}

console.log(`\n=== FINAL: ${allTraders.size/2} unique traders captured ===`)
console.log('Sample traders:')
let count = 0
for (const [key, val] of allTraders) {
  if (key.length > 10) continue  // skip large UIDs, show shortUIDs
  if (count++ >= 5) break
  console.log(`  shortUid=${key}: nick="${val.nick}" mdd=${val.mdd} wr=${val.wr}`)
}

await browser.close()
