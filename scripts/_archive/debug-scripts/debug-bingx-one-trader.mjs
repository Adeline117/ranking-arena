#!/usr/bin/env node
/**
 * Debug: Navigate to one BingX trader detail page and capture all APIs
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Test one trader: "golden faucet" UID 1339191395874545700
const TEST_UID = '1339191395874545700'

async function main() {
  console.log(`🔍 BingX single trader debug: ${TEST_UID}\n`)

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
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

  // Log ALL API responses with full data
  page.on('response', async resp => {
    const url = resp.url()
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    if (!url.includes('bingx') && !url.includes('qq-os')) return

    try {
      const json = await resp.json().catch(() => null)
      if (!json) return
      
      const shortUrl = url.replace('https://', '').replace(/\?.*/, '').split('/').slice(-4).join('/')
      const d = json?.data
      
      // Check for MDD fields anywhere in response
      const jsonStr = JSON.stringify(json)
      const hasMDD = jsonStr.toLowerCase().includes('drawdown') || jsonStr.toLowerCase().includes('drawDown')
      const hasWR = jsonStr.toLowerCase().includes('winrate') || jsonStr.toLowerCase().includes('win_rate')
      
      if (hasMDD || hasWR) {
        console.log(`\n✅ URL: ${shortUrl} (code=${json.code})`)
        if (d && typeof d === 'object') {
          // Extract key stats
          const stat = d.rankStat || d.stat || d.traderStat || d.statInfo || d
          const keys = Object.keys(stat)
          const mddKeys = keys.filter(k => k.toLowerCase().includes('draw') || k.toLowerCase().includes('mdd'))
          const wrKeys = keys.filter(k => k.toLowerCase().includes('win') || k.toLowerCase().includes('wr'))
          console.log(`  MDD keys: ${mddKeys.join(', ')}`)
          console.log(`  WR keys: ${wrKeys.join(', ')}`)
          for (const k of [...mddKeys, ...wrKeys]) {
            console.log(`  ${k} = ${stat[k]}`)
          }
        }
      } else if (json.code === 0) {
        console.log(`  (no MDD) ${shortUrl}`)
      } else {
        console.log(`  ERROR ${shortUrl} code=${json.code}`)
      }
    } catch {}
  })

  // Log all requests
  page.on('request', req => {
    const url = req.url()
    if (url.includes('qq-os') || url.includes('bingx.com/api')) {
      console.log(`→ REQ: ${req.method()} ${url.replace('https://', '').replace(/\?.*/, '').split('/').slice(-3).join('/')}`)
    }
  })

  const detailUrl = `https://bingx.com/en/copytrading/tradeDetail/${TEST_UID}`
  console.log(`Navigating to: ${detailUrl}`)
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('nav error:', e.message))
  await sleep(8000)

  // Try scrolling and clicking time period tabs
  console.log('\nScrolling and clicking tabs...')
  for (const tab of ['90D', '30D', '7D']) {
    try {
      const el = page.locator(`text="${tab}"`).first()
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
        await el.click()
        await sleep(2000)
        console.log(`  Clicked ${tab}`)
      }
    } catch {}
  }
  await sleep(2000)

  await browser.close()
  console.log('\nDone')
}

main().catch(e => { console.error(e); process.exit(1) })
