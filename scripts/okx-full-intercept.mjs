import { chromium } from 'playwright'

const browser = await chromium.launch({ 
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
})
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' }
})
const page = await ctx.newPage()

const allReqs = []
page.on('request', req => {
  if (!req.url().includes('.js') && !req.url().includes('.css') && !req.url().includes('.png') && !req.url().includes('.woff') && !req.url().includes('.ico') && req.url().includes('okx')) {
    allReqs.push(`${req.method()} ${req.url()}`)
  }
})

page.on('response', async res => {
  const url = res.url()
  if (url.includes('ranking') || url.includes('signal') || url.includes('smart') || url.includes('copy-trade')) {
    try {
      const body = await res.text()
      if (body.length > 100) { console.log(`\n🎯 ${url}`); console.log(body.slice(0, 400)) }
    } catch {}
  }
})

// Try different possible URLs
const urls = [
  'https://web3.okx.com/zh-hans/strategy-center/copy-trading-signals',
  'https://web3.okx.com/strategy-center/copy-trading-signals',
  'https://web3.okx.com/en/strategy-center/copy-trading-signals',
]

for (const url of urls) {
  console.log(`\nTrying: ${url}`)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(6000)
    const title = await page.title()
    console.log('Page title:', title)
    // Try to find and click something  
    const content = await page.content()
    if (content.includes('winRate') || content.includes('胜率') || content.includes('ranking')) {
      console.log('✅ Found relevant content!')
      break
    }
  } catch(e) { console.log('Error:', e.message.slice(0, 100)) }
}

console.log('\nAll requests captured:', allReqs.filter(r => r.includes('priapi')).slice(0, 20).join('\n'))
await browser.close()
