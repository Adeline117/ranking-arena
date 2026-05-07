import { chromium } from 'playwright'

const BASE = 'https://www.arenafi.org'
const VIEWPORT = { width: 430, height: 932 }
const TRADER_URL = '/trader/0xedc3bcac96833616b45be1c5e7bbc3ca8b2fe60c?platform=hyperliquid'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()

  console.log('=== Trader Detail Test ===')
  console.log(`  URL: ${BASE}${TRADER_URL}`)
  await page.goto(`${BASE}${TRADER_URL}`, { waitUntil: 'networkidle', timeout: 30000 })
  await new Promise(r => setTimeout(r, 4000))

  await page.screenshot({ path: '/tmp/arena-qa-07-trader-detail.png', fullPage: false })
  await page.screenshot({ path: '/tmp/arena-qa-07-trader-detail-full.png', fullPage: true })
  console.log('  Screenshots saved')

  const bodyText = await page.textContent('body')
  const sections = {
    'ROI': bodyText.includes('ROI'),
    'PnL': bodyText.includes('PnL') || bodyText.includes('P&L') || bodyText.includes('Profit'),
    'Arena Score': bodyText.includes('Arena Score') || bodyText.includes('Score'),
    'Win Rate': bodyText.includes('Win Rate') || bodyText.includes('Win%') || bodyText.includes('Win'),
    'Drawdown': bodyText.includes('Drawdown') || bodyText.includes('MDD'),
    'Chart': await page.$('canvas, [class*="chart"], [class*="Chart"], svg') !== null,
    'Period tabs': bodyText.includes('7D') || bodyText.includes('30D') || bodyText.includes('90D'),
    'Exchange badge': bodyText.includes('Hyperliquid') || bodyText.includes('hyperliquid') || bodyText.includes('On-chain'),
  }
  for (const [name, present] of Object.entries(sections)) {
    console.log(`  ${present ? 'OK' : 'MISSING'}: ${name}`)
  }

  // Horizontal overflow
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }))
  console.log(`  Horizontal overflow: ${overflow.hasOverflow}`)

  // Period switch on trader detail
  console.log('\n=== Period Switch on Trader Detail ===')
  for (const period of ['90D', '30D', '7D']) {
    const buttons = await page.$$('button, [role="tab"], a')
    for (const btn of buttons) {
      const text = await btn.textContent()
      const isVisible = await btn.isVisible()
      if (isVisible && text && text.trim() === period) {
        await btn.click()
        console.log(`  Clicked: ${period}`)
        await new Promise(r => setTimeout(r, 2500))
        await page.screenshot({ path: `/tmp/arena-qa-08-trader-${period.toLowerCase()}.png`, fullPage: false })

        const newBodyText = await page.textContent('body')
        const hasROI = newBodyText.match(/[+-]?\d+\.?\d*%/)
        console.log(`  ROI visible: ${!!hasROI} ${hasROI ? hasROI[0] : ''}`)
        break
      }
    }
  }

  await browser.close()
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
