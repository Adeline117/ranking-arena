import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const pages = [
  { name: 'Homepage', url: '/', file: '/tmp/arena-home-h.png' },
  { name: 'Rankings', url: '/rankings', file: '/tmp/arena-rankings-h.png' },
  { name: 'Hyperliquid', url: '/rankings/hyperliquid', file: '/tmp/arena-hl-h.png' },
  { name: 'Gains', url: '/rankings/gains', file: '/tmp/arena-gains-h.png' },
  { name: 'Bybit', url: '/rankings/bybit', file: '/tmp/arena-bybit-h.png' },
  { name: 'Trader Detail', url: '/trader/binance_futures/3AF49855F339B098', file: '/tmp/arena-detail-h.png' },
]

for (const p of pages) {
  try {
    console.log(`\n=== ${p.name} ===`)
    await page.goto('https://www.arenafi.org' + p.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(8000)
    await page.screenshot({ path: p.file, fullPage: false })
    const text = await page.$eval('body', el => el.textContent.slice(0, 2000))
    const has404 = text.includes('404')
    const hasData = text.includes('ROI') || text.includes('+') || text.includes('Score')
    const hasSkeleton = !hasData && !has404
    console.log(`  404: ${has404}, data: ${hasData}, skeleton: ${hasSkeleton}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message.slice(0, 80)}`)
  }
}

await browser.close()
