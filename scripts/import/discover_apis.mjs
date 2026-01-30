/**
 * API Discovery Script - uses Playwright to visit each copy trading page
 * and intercept ALL network requests to find hidden API endpoints
 */
import { chromium } from 'playwright'

const TARGETS = [
  { name: 'pionex', url: 'https://www.pionex.com/copy-trade', alt: ['https://www.pionex.com/en/copy-trade'] },
  { name: 'bitmart', url: 'https://www.bitmart.com/en-US/futures/copy-trading', alt: ['https://www.bitmart.com/en-US/futures-copy-trading'] },
  { name: 'gateio', url: 'https://www.gate.io/copy_trading/traders', alt: ['https://www.gate.io/copy_trading', 'https://www.gate.io/copytrading'] },
  { name: 'phemex', url: 'https://phemex.com/copy-trading', alt: ['https://phemex.com/copy-trade', 'https://phemex.com/en/copy-trading'] },
]

async function discoverAPIs(browser, target) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🔍 Discovering APIs for ${target.name}: ${target.url}`)
  console.log(`${'='.repeat(60)}`)

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  })
  
  const page = await context.newPage()
  const apiCalls = []
  const jsonResponses = []

  // Intercept ALL responses
  page.on('response', async (response) => {
    const url = response.url()
    const status = response.status()
    const ct = response.headers()['content-type'] || ''
    
    // Log all API/XHR calls (non-static resources)
    if (!url.match(/\.(js|css|png|jpg|gif|svg|woff|woff2|ico|ttf|eot)(\?|$)/i) && 
        !url.includes('google') && !url.includes('facebook') && !url.includes('analytics') &&
        !url.includes('cloudflare') && !url.includes('sentry')) {
      apiCalls.push({ url: url.substring(0, 200), status, ct: ct.substring(0, 50) })
    }
    
    // Capture JSON responses with data
    if (ct.includes('json') && status === 200) {
      try {
        const text = await response.text().catch(() => '')
        if (text && text.length > 50 && text.length < 500000) {
          const json = JSON.parse(text)
          // Check if it contains trader/list/array data
          const hasArray = (obj) => {
            if (Array.isArray(obj) && obj.length > 0) return true
            if (obj && typeof obj === 'object') {
              for (const v of Object.values(obj)) {
                if (Array.isArray(v) && v.length > 0) return true
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                  for (const v2 of Object.values(v)) {
                    if (Array.isArray(v2) && v2.length > 0) return true
                  }
                }
              }
            }
            return false
          }
          
          if (hasArray(json)) {
            jsonResponses.push({
              url: url.substring(0, 300),
              preview: text.substring(0, 500),
              size: text.length
            })
          }
        }
      } catch {}
    }
  })

  const urls = [target.url, ...(target.alt || [])]
  
  for (const url of urls) {
    try {
      console.log(`\n  📡 Trying: ${url}`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(8000)
      
      const title = await page.title()
      const currentUrl = page.url()
      console.log(`  Title: ${title}`)
      console.log(`  URL: ${currentUrl}`)
      
      // Check for Cloudflare
      if (title.includes('Just a moment') || title.includes('Cloudflare')) {
        console.log('  ⚠️ Cloudflare challenge detected, waiting...')
        await page.waitForTimeout(10000)
        const newTitle = await page.title()
        console.log(`  After wait: ${newTitle}`)
      }
      
      // Close popups
      await page.evaluate(() => {
        document.querySelectorAll('button, [role="button"], [class*="close"]').forEach(btn => {
          const text = (btn.textContent || '').toLowerCase()
          if (['ok', 'got it', 'accept', 'close', 'confirm', 'i understand', 'agree'].some(t => text.includes(t))) {
            try { btn.click() } catch {}
          }
        })
      }).catch(() => {})
      
      await page.waitForTimeout(3000)
      
      // Scroll to trigger lazy loading
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await page.waitForTimeout(2000)
      }
      
      // Check page content
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '').catch(() => '')
      if (bodyText.includes('%') || bodyText.includes('ROI') || bodyText.includes('trader')) {
        console.log('  ✅ Page has trader content')
        console.log(`  Body preview: ${bodyText.substring(0, 300)}`)
      } else {
        console.log(`  Body preview: ${bodyText.substring(0, 300)}`)
      }
      
      // Take screenshot
      await page.screenshot({ path: `/tmp/${target.name}_discover_${Date.now()}.png`, fullPage: false }).catch(() => {})
      
      if (jsonResponses.length > 0) break // Found data, stop trying alternates
    } catch (e) {
      console.log(`  Error: ${e.message}`)
    }
  }

  // Report findings
  console.log(`\n  📊 API Calls Found: ${apiCalls.length}`)
  for (const call of apiCalls) {
    console.log(`    [${call.status}] ${call.url}`)
  }
  
  console.log(`\n  📦 JSON Responses with Arrays: ${jsonResponses.length}`)
  for (const resp of jsonResponses) {
    console.log(`\n    URL: ${resp.url}`)
    console.log(`    Size: ${resp.size} bytes`)
    console.log(`    Preview: ${resp.preview.substring(0, 300)}`)
  }

  await context.close()
  return { apiCalls, jsonResponses }
}

async function main() {
  console.log('🔍 API Discovery for Copy Trading Platforms\n')
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const results = {}
  for (const target of TARGETS) {
    try {
      results[target.name] = await discoverAPIs(browser, target)
    } catch (e) {
      console.log(`  ❌ ${target.name}: ${e.message}`)
    }
  }

  await browser.close()
  
  console.log(`\n${'='.repeat(60)}`)
  console.log('📋 SUMMARY')
  console.log(`${'='.repeat(60)}`)
  for (const [name, result] of Object.entries(results)) {
    console.log(`  ${name}: ${result.apiCalls.length} API calls, ${result.jsonResponses.length} JSON with data`)
  }
}

main().catch(console.error)
