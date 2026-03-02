import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' })
const page = await ctx.newPage()

const apiCalls = []
page.on('request', req => {
  const url = req.url()
  if (url.includes('priapi') && !url.includes('.css') && !url.includes('.js') && !url.includes('.png')) {
    apiCalls.push({ method: req.method(), url, body: req.postData()?.slice(0, 200) })
  }
})

page.on('response', async res => {
  const url = res.url()
  if (url.includes('smartmoney') || url.includes('signal') || url.includes('copy-trade') || url.includes('lead-portfolio')) {
    try {
      const body = await res.json()
      console.log(`\n=== RESPONSE: ${url.slice(0, 150)} ===`)
      console.log(JSON.stringify(body).slice(0, 500))
    } catch {}
  }
})

console.log('Opening OKX Web3 leaderboard...')
await page.goto('https://web3.okx.com/zh-hans/strategy-center/copy-trading-signals', { timeout: 60000 })
await page.waitForTimeout(8000)
await page.evaluate(() => window.scrollTo(0, 500))
await page.waitForTimeout(3000)

console.log('\n=== ALL priapi calls ===')
apiCalls.forEach(a => console.log(`${a.method} | ${a.url}`))
await browser.close()
