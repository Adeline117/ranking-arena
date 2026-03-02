import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36', viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

page.on('response', async res => {
  const url = res.url()
  if (!url.match(/\.(js|css|png|woff|ico|svg|webp)(\?|$)/) && url.includes('priapi')) {
    try {
      const body = await res.json()
      const str = JSON.stringify(body)
      if (str.includes('winRate') || str.includes('"list":[{') && str.length > 1000) {
        console.log(`\n✅ ${url}`); console.log(str.slice(0, 1200))
      }
    } catch {}
  }
})

const urls = [
  'https://web3.okx.com/zh-hans/copy-trading',
  'https://web3.okx.com/copy-trading',
  'https://web3.okx.com/zh-hans/copy-trade',
  'https://web3.okx.com/trade/copy-trading'
]

for (const u of urls) {
  console.log('Trying:', u)
  try {
    await page.goto(u, { timeout: 20000 })
    await page.waitForTimeout(5000)
    const title = await page.title()
    console.log('Title:', title)
  } catch(e) { console.log('Error:', e.message.slice(0,100)) }
}
await browser.close()
