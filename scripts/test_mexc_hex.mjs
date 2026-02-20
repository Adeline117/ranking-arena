#!/usr/bin/env node
import puppeteer from 'puppeteer'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const HEX_IDS = [
  '00025d434afe4c609b24c49383597c1c',
  '000f8fb5833f40c0a05e3a3296b73f9d',
  '00204fa46d6f48e98ac7155b947439be',
]

async function main() {
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  
  // Intercept all JSON responses
  const captured = []
  page.on('response', async response => {
    const url = response.url()
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const data = await response.json()
      if (url.includes('copy') || url.includes('trader') || url.includes('rank')) {
        const shortUrl = url.split('?')[0].split('/').slice(-3).join('/')
        console.log(`📡 ${shortUrl}`)
        if (data?.data) {
          console.log('  keys:', Object.keys(data.data).slice(0, 10))
        }
      }
    } catch {}
  })
  
  await page.setRequestInterception(true)
  page.on('request', req => {
    const type = req.resourceType()
    if (['image', 'stylesheet', 'font', 'media'].includes(type)) req.abort()
    else req.continue()
  })
  
  console.log('🌐 Loading MEXC trader profile page...')
  const hexId = HEX_IDS[0]
  
  // Try profile page URL
  await page.goto(`https://www.mexc.com/futures/copyTrade/traderInfo?traderId=${hexId}`, { 
    waitUntil: 'domcontentloaded', timeout: 30000 
  }).catch(e => console.log('Nav error:', e.message))
  await sleep(5000)
  
  // Now test APIs via fetch
  const results = await page.evaluate(async (ids) => {
    const results = {}
    
    // Test various endpoints
    const endpoints = [
      // By hex traderId
      `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2/${ids[0]}/detail`,
      `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/detail?traderId=${ids[0]}`,
      `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/${ids[0]}`,
      `https://contract.mexc.com/api/v1/copytrading/v2/public/trader/detail?traderId=${ids[0]}`,
      `https://contract.mexc.com/api/v1/copytrading/v2/public/trader/info?uid=${ids[0]}`,
      // Search
      `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=5&traderId=${ids[0]}`,
      `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=5&uid=${ids[0]}`,
    ]
    
    for (const url of endpoints) {
      try {
        const resp = await fetch(url)
        const text = await resp.text()
        let data = null
        try { data = JSON.parse(text) } catch {}
        results[url.split('/').slice(-2).join('/')] = {
          status: resp.status,
          hasData: data?.data != null,
          success: data?.success,
          preview: text.substring(0, 200)
        }
      } catch (e) {
        results[url] = { error: e.message }
      }
    }
    return results
  }, HEX_IDS)
  
  console.log('\nEndpoint results:')
  for (const [url, r] of Object.entries(results)) {
    console.log(`\n${url}:`, JSON.stringify(r, null, 2))
  }
  
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
