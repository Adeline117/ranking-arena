#!/usr/bin/env node
/**
 * Discover MEXC spot copy trading API by intercepting all network calls
 * on the futures copy trade home page (which may have a spot section)
 */
import { chromium } from 'playwright'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
const context = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1920, height: 1080 } })
const page = await context.newPage()

// Capture ALL JSON responses
const capturedAPIs = []
page.on('response', async (res) => {
  const u = res.url()
  const ct = res.headers()['content-type'] || ''
  if (!ct.includes('json')) return
  if (u.includes('.js') || u.includes('.css')) return
  
  try {
    const body = await res.text()
    if (!body || body.startsWith('<!') || body.length < 5) return
    capturedAPIs.push({ url: u, body })
    
    // Only log copy/trade/spot related
    const lc = u.toLowerCase()
    if (lc.includes('copy') || lc.includes('trader') || lc.includes('rank')) {
      console.log(`[API] ${u.slice(0, 150)}`)
      console.log(`  ${body.slice(0, 300)}`)
    }
  } catch {}
})

// Try the futures copy trade page - it has spot section too
console.log('Navigating to https://www.mexc.com/futures/copyTrade/home ...')
try {
  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(8000)
} catch (e) {
  console.log('Nav error:', e.message.slice(0, 100))
}

// Close popups
await page.evaluate(() => {
  document.querySelectorAll('button, [class*="close"], [class*="modal"]').forEach(el => {
    const text = (el.textContent || '').trim()
    if (['关闭','OK','Got it','确定','Close','I understand','知道了','X'].some(t => text === t || text.includes(t))) {
      try { el.click() } catch {}
    }
  })
}).catch(() => {})
await sleep(2000)

// Log all tabs/buttons
const tabs = await page.evaluate(() => {
  const els = document.querySelectorAll('button, [role="tab"], a, li, span[class*="tab"], div[class*="tab"]')
  return Array.from(els)
    .map(e => e.textContent?.trim())
    .filter(t => t && t.length < 60 && t.length > 1)
    .slice(0, 50)
}).catch(() => [])
console.log('\nTabs/buttons:', [...new Set(tabs)])

// Try clicking "Spot" tab
for (const tabText of ['Spot', 'SPOT', 'Spot Copy', 'Spot Trader', 'Spot Trading', '现货']) {
  try {
    const el = await page.locator(`text="${tabText}"`).first()
    const vis = await el.isVisible({ timeout: 2000 }).catch(() => false)
    if (vis) {
      console.log(`\nClicking: "${tabText}"`)
      await el.click()
      await sleep(6000)
      break
    }
  } catch {}
}

// Try "All Traders" tab
for (const tabText of ['All Traders', '全部交易员', 'All', 'All traders']) {
  try {
    const el = await page.locator(`text="${tabText}"`).first()
    const vis = await el.isVisible({ timeout: 2000 }).catch(() => false)
    if (vis) {
      console.log(`Clicking: "${tabText}"`)
      await el.click()
      await sleep(5000)
      break
    }
  } catch {}
}

// Scroll down
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {})
await sleep(3000)

// Check captured APIs for any copy trade data
console.log('\n=== All captured API URLs ===')
const copyAPIs = capturedAPIs.filter(a => {
  const lc = a.url.toLowerCase()
  return lc.includes('copy') || lc.includes('trader') || lc.includes('rank') || lc.includes('leader')
})
console.log(`Total: ${capturedAPIs.length}, Copy/trader related: ${copyAPIs.length}`)

for (const api of copyAPIs) {
  console.log('\nURL:', api.url)
  try {
    const data = JSON.parse(api.body)
    // Look for trader lists
    const searchArr = (obj, depth = 0) => {
      if (depth > 5) return
      if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') {
        const keys = Object.keys(obj[0])
        if (keys.some(k => ['nickname', 'nickName', 'roi', 'winRate', 'uid', 'traderId', 'userId'].includes(k))) {
          console.log(`  → Found trader array! ${obj.length} items, keys: ${keys.slice(0,10).join(',')}`)
          console.log(`  Sample: ${JSON.stringify(obj[0]).slice(0, 300)}`)
        }
      }
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          searchArr(v, depth + 1)
        }
      }
    }
    searchArr(data)
    console.log('  Raw (200 chars):', api.body.slice(0, 200))
  } catch {
    console.log('  (parse error)')
  }
}

// Now specifically test the MEXC API with spot parameters
console.log('\n\n=== Testing MEXC v2 API with spot parameters ===')
const testURLs = [
  'https://www.mexc.com/api/copy-trade/main/v1/traders/v2?page=0&size=10&type=SPOT',
  'https://www.mexc.com/api/copy-trade/main/v1/traders/v2?page=0&size=10&tradeType=SPOT',
  'https://www.mexc.com/api/copy-trade/spot/v1/traders?page=0&size=10',
  'https://www.mexc.com/api/copy-trade/main/v1/spot/traders?page=0&size=10',
  'https://www.mexc.com/api/copy-trade/main/v1/traders?page=0&size=10&sort=roi&tradeType=spot',
]

for (const testUrl of testURLs) {
  try {
    const resp = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: 'include' })
      return { status: r.status, body: await r.text() }
    }, testUrl)
    console.log(`\n${testUrl.split('/').slice(-3).join('/')}`)
    console.log(`  Status: ${resp.status}, Body: ${resp.body.slice(0, 200)}`)
  } catch (e) {
    console.log(`  Error: ${e.message.slice(0, 100)}`)
  }
}

await browser.close()
