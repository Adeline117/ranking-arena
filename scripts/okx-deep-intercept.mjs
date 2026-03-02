import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 }
})
const page = await ctx.newPage()

const found = []
page.on('response', async res => {
  const url = res.url()
  if (!url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.woff') && url.includes('priapi')) {
    try {
      const ct = res.headers()['content-type'] || ''
      if (ct.includes('json')) {
        const body = await res.json()
        const str = JSON.stringify(body)
        if (str.includes('winRate') || str.includes('WinRate') || str.includes('win_rate') || str.length > 500) {
          console.log(`\n✅ ${url.slice(0, 200)}`)
          console.log(str.slice(0, 600))
          found.push(url)
        }
      }
    } catch {}
  }
})

console.log('Loading page...')
await page.goto('https://web3.okx.com/zh-hans/strategy-center/copy-trading-signals', { timeout: 60000 })
await page.waitForTimeout(5000)

// Try clicking tabs and time selectors
try {
  // Click "全部" tab if exists
  const allBtn = page.locator('text=全部').first()
  if (await allBtn.count() > 0) { await allBtn.click(); await page.waitForTimeout(2000) }
  // Try clicking the time period button "7日"
  const dayBtn = page.locator('text=7日').first()
  if (await dayBtn.count() > 0) { console.log('Found 7日 button, clicking...'); await dayBtn.click(); await page.waitForTimeout(2000) }
} catch(e) { console.log('Click error:', e.message) }

await page.waitForTimeout(3000)
console.log(`\nTotal API calls with data: ${found.length}`)
await browser.close()
