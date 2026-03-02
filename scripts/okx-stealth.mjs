import { chromium } from 'playwright'
import { addExtra } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

let browser, api_url = null

try {
  const chromiumExtra = addExtra(chromium)
  chromiumExtra.use(StealthPlugin())
  browser = await chromiumExtra.launch({ headless: true })
} catch {
  browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] })
}

const ctx = await browser.newContext({ 
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 }
})
const page = await ctx.newPage()

page.on('response', async res => {
  const url = res.url()
  if (url.includes('smartmoney') || url.includes('ranking') || url.includes('signal') || url.includes('copy')) {
    try {
      const body = await res.json()
      const str = JSON.stringify(body)
      if (str.includes('winRate') || str.includes('roi')) {
        console.log(`\n✅ FOUND: ${url}`)
        console.log(str.slice(0, 1000))
        api_url = url
      }
    } catch {}
  }
})

console.log('Loading with stealth...')
await page.goto('https://web3.okx.com/zh-hans/strategy-center/copy-trading-signals', { timeout: 60000 })
await page.waitForTimeout(8000)

// Simulate human interaction
await page.mouse.move(500, 400)
await page.waitForTimeout(1000)
await page.mouse.click(500, 400)
await page.waitForTimeout(3000)
await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'smooth' }))
await page.waitForTimeout(3000)

if (!api_url) console.log('No data API found')
await browser.close()
