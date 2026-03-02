import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: false })  // try non-headless 
const ctx = await browser.newContext({ 
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  recordHar: { path: '/tmp/okx_har.json' }
})
const page = await ctx.newPage()
const found_apis = []

page.on('response', async res => {
  const url = res.url()
  if (url.includes('/priapi/') && !url.match(/\.(js|css|png|woff|ico|svg)(\?|$)/)) {
    try {
      const body = await res.json()
      const str = JSON.stringify(body)
      if (str.includes('winRate') || (str.includes('"data"') && str.length > 2000)) {
        console.log(`\n🎯 ${url.slice(0,200)}`)
        console.log(str.slice(0, 800))
        found_apis.push(url)
      }
    } catch {}
  }
})

await page.goto('https://web3.okx.com/zh-hans/strategy-center/copy-trading-signals', { timeout: 60000 })
await page.waitForTimeout(15000)
await page.evaluate(() => window.scrollBy(0, 800))
await page.waitForTimeout(5000)

await ctx.close()
await browser.close()

if (!found_apis.length) {
  console.log('\n⚠️ No data APIs found in browser mode either')
  console.log('Trying direct API with fake fingerprint...')
  
  const params = new URLSearchParams({ pt: '1', rankStart: '1', rankEnd: '10', t: Date.now() })
  const res = await fetch(`https://web3.okx.com/priapi/v1/dx/strategy/copy-trade/leader/list?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://web3.okx.com/zh-hans/strategy-center/copy-trading-signals',
      'x-zkdex-env': 'undefined',
      'app-type': 'web',
    }
  })
  const data = await res.json().catch(() => null)
  console.log('Result:', JSON.stringify(data)?.slice(0, 500))
}
