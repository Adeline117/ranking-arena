/**
 * Discover detail API endpoints by visiting trader profile pages
 */
import { chromium } from 'playwright'

const PROXY = 'http://127.0.0.1:7890'

async function discoverGateio() {
  console.log('\n=== Gate.io API Discovery ===')
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY } })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  
  const apis = []
  page.on('request', req => {
    const url = req.url()
    if (url.includes('copy') || url.includes('leader') || url.includes('trader')) {
      apis.push({ method: req.method(), url })
    }
  })
  page.on('response', async res => {
    const url = res.url()
    if ((url.includes('copy') || url.includes('leader') || url.includes('trader')) && res.headers()['content-type']?.includes('json')) {
      try {
        const data = await res.json()
        console.log(`  📡 ${res.status()} ${url.split('?')[0]}`)
        console.log(`     Keys: ${JSON.stringify(Object.keys(data?.data || data || {})).slice(0,200)}`)
      } catch {}
    }
  })

  // Visit a trader detail page
  await page.goto('https://www.gate.io/copytrading/share?trader_id=1001', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 8000))
  
  console.log('\nAll API calls:')
  apis.forEach(a => console.log(`  ${a.method} ${a.url.split('?')[0]}`))
  
  await browser.close()
}

async function discoverKucoin() {
  console.log('\n=== KuCoin API Discovery ===')
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY } })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  
  const apis = []
  page.on('request', req => {
    const url = req.url()
    if (url.includes('copy') || url.includes('leader') || url.includes('trade')) {
      apis.push({ method: req.method(), url })
    }
  })
  page.on('response', async res => {
    const url = res.url()
    if ((url.includes('copy') || url.includes('leader') || url.includes('trade')) && res.headers()['content-type']?.includes('json')) {
      try {
        const data = await res.json()
        console.log(`  📡 ${res.status()} ${url.split('?')[0]}`)
        const d = data?.data || data
        console.log(`     Keys: ${JSON.stringify(Object.keys(d)).slice(0,200)}`)
        // Show some values if they have win/draw/trade fields
        const str = JSON.stringify(d).slice(0, 500)
        if (str.includes('win') || str.includes('draw') || str.includes('trade') || str.includes('mdd')) {
          console.log(`     Sample: ${str.slice(0, 300)}`)
        }
      } catch {}
    }
  })

  // Visit KuCoin copy trading leader page
  await page.goto('https://www.kucoin.com/copy-trading/leader/1002262', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 8000))
  
  // Try alternate URL patterns
  await page.goto('https://www.kucoin.com/copytrading/trader/1002262', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 5000))
  
  console.log('\nAll API calls:')
  apis.forEach(a => console.log(`  ${a.method} ${a.url}`))
  
  await browser.close()
}

async function discoverCoinex() {
  console.log('\n=== CoinEx API Discovery ===')
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY } })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  
  const apis = []
  page.on('request', req => {
    const url = req.url()
    if (url.includes('copy') || url.includes('trader') || url.includes('leader')) {
      apis.push({ method: req.method(), url, body: req.postData() })
    }
  })
  page.on('response', async res => {
    const url = res.url()
    if ((url.includes('copy') || url.includes('trader') || url.includes('leader')) && res.headers()['content-type']?.includes('json')) {
      try {
        const data = await res.json()
        console.log(`  📡 ${res.status()} ${url.split('?')[0]}`)
        const d = data?.data || data
        console.log(`     Keys: ${JSON.stringify(Object.keys(d)).slice(0,200)}`)
        console.log(`     Sample: ${JSON.stringify(d).slice(0, 400)}`)
      } catch {}
    }
  })

  // Visit CoinEx trader page - try nickname-based URL
  await page.goto('https://www.coinex.com/en/copy-trading/futures/trader/28752282', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 8000))
  
  console.log('\nAll API calls:')
  apis.forEach(a => console.log(`  ${a.method} ${a.url}${a.body ? ' BODY: ' + a.body.slice(0,200) : ''}`))
  
  await browser.close()
}

async function discoverOkxWeb3() {
  console.log('\n=== OKX Web3 API Discovery ===')
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY } })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  
  const apis = []
  page.on('response', async res => {
    const url = res.url()
    if ((url.includes('copy') || url.includes('trader') || url.includes('leader') || url.includes('rank')) && res.headers()['content-type']?.includes('json')) {
      try {
        const data = await res.json()
        console.log(`  📡 ${res.status()} ${url}`)
        const d = data?.data || data
        console.log(`     Sample: ${JSON.stringify(d).slice(0, 400)}`)
      } catch {}
    }
  })

  // OKX Web3 leaderboard page first to find links
  await page.goto('https://web3.okx.com/zh-hans/copy-trade/leaderboard', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 8000))
  
  // Try clicking first trader card
  const links = await page.evaluate(() => {
    const anchors = document.querySelectorAll('a[href*="trader"], a[href*="copy"]')
    return Array.from(anchors).slice(0, 5).map(a => a.href)
  })
  console.log('Links found:', links)
  
  if (links[0]) {
    await page.goto(links[0], { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 8000))
  }
  
  await browser.close()
}

// Run all discoveries
await discoverGateio()
await discoverKucoin()
await discoverCoinex()
await discoverOkxWeb3()
