/**
 * API Discovery - Visit each exchange's copy trading page and intercept API calls
 * to find what fields are available for enrichment.
 * 
 * Usage: node scripts/import/discover_apis_v3.mjs <platform>
 */
import { chromium } from 'playwright'
import { sleep } from '../lib/shared.mjs'

const PROXY = 'http://127.0.0.1:7890'

const PAGES = {
  mexc: 'https://www.mexc.com/futures/copyTrade/home',
  bingx: 'https://bingx.com/en/CopyTrading/leaderBoard',
  kucoin: 'https://www.kucoin.com/copytrading',
  coinex: 'https://www.coinex.com/en/copy-trading/futures',
  phemex: 'https://phemex.com/copy-trading/list',
  bitfinex: 'https://www.bitfinex.com/leaderboard',
  lbank: 'https://www.lbank.com/copy-trading',
  weex: 'https://www.weex.com/copy-trading',
  blofin: 'https://blofin.com/copy-trade?tab=leaderboard&module=futures',
  toobit: 'https://www.toobit.com/en-US/copytrading',
  btcc: 'https://www.btcc.com/en-US/copy-trading',
  xt: 'https://www.xt.com/en/copy-trading/futures',
}

async function discover(platform) {
  const url = PAGES[platform]
  if (!url) { console.log('Unknown platform:', platform); return }
  
  console.log(`\n=== Discovering ${platform} APIs ===`)
  console.log(`URL: ${url}`)
  
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: PROXY },
  })
  
  const apiCalls = []
  
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1920, height: 1080 })
    
    page.on('response', async (res) => {
      const u = res.url()
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      if (u.includes('cdn') || u.includes('static') || u.includes('analytics') || u.includes('google') || u.includes('gtag')) return
      
      try {
        const json = await res.json()
        const entry = { url: u.split('?')[0], status: res.status(), keys: null, sampleItem: null }
        
        // Try to find the data array
        const findList = (obj, depth = 0) => {
          if (depth > 3) return null
          if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') return obj
          if (typeof obj === 'object' && obj !== null) {
            for (const k of Object.keys(obj)) {
              const r = findList(obj[k], depth + 1)
              if (r) return r
            }
          }
          return null
        }
        
        const list = findList(json)
        if (list) {
          entry.keys = Object.keys(list[0])
          entry.sampleItem = list[0]
          entry.listLength = list.length
        } else {
          entry.keys = Object.keys(json.data || json.result || json)
        }
        
        apiCalls.push(entry)
      } catch {}
    })
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await sleep(5000)
    
    // Scroll down to trigger more loads
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800))
      await sleep(2000)
    }
    
    // Try clicking "next page" or similar
    await page.evaluate(() => {
      document.querySelectorAll('button, [class*="next"], [class*="page"]').forEach(el => {
        if (el.textContent?.includes('Next') || el.textContent?.includes('>') || el.textContent?.includes('2')) {
          try { el.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(3000)
    
  } finally {
    await browser.close()
  }
  
  console.log(`\nFound ${apiCalls.length} API calls:`)
  for (const call of apiCalls) {
    console.log(`\n  ${call.url}`)
    console.log(`    Status: ${call.status}, List: ${call.listLength || 'N/A'}`)
    console.log(`    Keys: ${JSON.stringify(call.keys)?.slice(0, 300)}`)
    if (call.sampleItem) {
      // Show relevant fields
      const relevant = {}
      for (const [k, v] of Object.entries(call.sampleItem)) {
        if (/win|rate|draw|mdd|trade|count|pnl|profit|aum|asset|balance|roi|return/i.test(k)) {
          relevant[k] = v
        }
      }
      if (Object.keys(relevant).length) console.log(`    Relevant: ${JSON.stringify(relevant)}`)
    }
  }
}

const platform = process.argv[2]?.toLowerCase()
if (!platform) {
  console.log('Usage: node discover_apis_v3.mjs <platform>')
  console.log('Platforms:', Object.keys(PAGES).join(', '))
} else {
  discover(platform).catch(console.error)
}
