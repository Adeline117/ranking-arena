import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' })
const page = await ctx.newPage()

const apis = []
page.on('request', req => {
  const url = req.url()
  if (url.includes('okx') && !url.includes('.css') && !url.includes('.js') && !url.includes('.png') && !url.includes('.woff') && (url.includes('smart') || url.includes('copy') || url.includes('lead') || url.includes('rank') || url.includes('trader') || url.includes('signal') || url.includes('priapi'))) {
    apis.push({ method: req.method(), url })
  }
})

console.log('Opening OKX Web3 leaderboard...')
await page.goto('https://web3.okx.com/zh-hans/strategy-center/copy-trading-signals', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(3000)

console.log('=== Intercepted API calls ===')
apis.forEach(a => console.log(`${a.method} | ${a.url}`))
await browser.close()
