#!/usr/bin/env node
/**
 * Discover MEXC spot copy-trading and Weex spot/futures APIs
 * Uses Playwright to intercept XHR/fetch responses
 */
import { chromium } from 'playwright'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function discoverMEXCSpot() {
  console.log('\n' + '='.repeat(60))
  console.log('MEXC SPOT COPY TRADING DISCOVERY')
  console.log('='.repeat(60))

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  const context = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1920, height: 1080 } })
  const page = await context.newPage()

  const capturedAPIs = []

  page.on('response', async (res) => {
    const u = res.url()
    const ct = res.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    if (u.includes('.js') || u.includes('.css')) return

    try {
      const body = await res.text()
      if (!body || body.startsWith('<!')) return
      
      const lowerU = u.toLowerCase()
      if (lowerU.includes('copy') || lowerU.includes('trader') || lowerU.includes('rank') || 
          lowerU.includes('leader') || lowerU.includes('spot')) {
        capturedAPIs.push({ url: u, status: res.status(), body: body.slice(0, 2000) })
        console.log(`[MEXC] API: ${u.slice(0, 120)}`)
        console.log(`  Body preview: ${body.slice(0, 300)}`)
      }
    } catch {}
  })

  // First try the main copy-trade page
  console.log('\nVisiting https://www.mexc.com/copy-trade ...')
  try {
    await page.goto('https://www.mexc.com/copy-trade', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(8000)
    
    // Log all text visible to find tabs
    const pageTitle = await page.title()
    console.log('Page title:', pageTitle)
    
    // Look for spot tab
    const allText = await page.evaluate(() => {
      const els = document.querySelectorAll('button, [role="tab"], a, .tab-item, [class*="tab"]')
      return Array.from(els).map(e => e.textContent?.trim()).filter(t => t && t.length < 50)
    })
    const uniqueText = [...new Set(allText)].filter(Boolean)
    console.log('Tabs/buttons found:', uniqueText.slice(0, 30))
    
    // Try clicking spot-related tabs
    for (const tabText of ['Spot', 'spot', 'SPOT', 'Spot Copy', 'Spot Trading']) {
      try {
        const el = await page.locator(`text="${tabText}"`).first()
        if (await el.isVisible({ timeout: 2000 })) {
          console.log(`Clicking tab: "${tabText}"`)
          await el.click()
          await sleep(5000)
          break
        }
      } catch {}
    }
    
    // Scroll to load more
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(3000)
    
  } catch (e) {
    console.log('MEXC nav error:', e.message.slice(0, 200))
  }

  console.log('\nTotal MEXC APIs captured:', capturedAPIs.length)
  for (const api of capturedAPIs) {
    console.log('\n---')
    console.log('URL:', api.url)
    console.log('Body:', api.body.slice(0, 500))
  }

  await browser.close()
  return capturedAPIs
}

async function discoverWeexSpot() {
  console.log('\n' + '='.repeat(60))
  console.log('WEEX SPOT COPY TRADING DISCOVERY')
  console.log('='.repeat(60))

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  const context = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1920, height: 1080 } })
  const page = await context.newPage()

  const capturedTraderData = []
  let responseStructure = null

  // Use CDP to capture response bodies
  const client = await context.newCDPSession(page)
  await client.send('Network.enable')

  const requestMap = {}
  client.on('Network.requestWillBeSent', p => {
    if (p.request.url.includes('traderListView') || p.request.url.includes('copyTrade') || 
        p.request.url.includes('copy-trade') || p.request.url.includes('/trace/')) {
      requestMap[p.requestId] = { url: p.request.url, method: p.request.method, body: p.request.postData }
    }
  })

  client.on('Network.loadingFinished', async p => {
    if (requestMap[p.requestId]) {
      try {
        const resp = await client.send('Network.getResponseBody', { requestId: p.requestId })
        if (!resp.body) return
        const data = JSON.parse(resp.body)
        const req = requestMap[p.requestId]
        console.log(`[WEEX] Response from: ${req.url.slice(0, 120)}`)
        console.log(`  Keys at data level: ${data.data ? Object.keys(data.data).join(', ') : 'N/A'}`)
        
        // Try various data structures
        const rows = data?.data?.rows || data?.data?.list || data?.data?.content || data?.data?.traders || 
                     data?.list || data?.rows || (Array.isArray(data?.data) ? data.data : null)
        
        if (rows && rows.length > 0) {
          const firstRow = rows[0]
          console.log(`  Found ${rows.length} traders. First row keys: ${Object.keys(firstRow).join(', ')}`)
          console.log(`  First row sample: ${JSON.stringify(firstRow).slice(0, 500)}`)
          
          if (!responseStructure) {
            responseStructure = { url: req.url, firstRow, total: data?.data?.totals || data?.data?.total || rows.length }
          }
          
          capturedTraderData.push(...rows)
        } else {
          console.log(`  Body: ${JSON.stringify(data).slice(0, 400)}`)
        }
      } catch (e) {
        console.log('  Parse error:', e.message.slice(0, 100))
      }
    }
  })

  console.log('\nVisiting https://www.weex.com/copy-trading ...')
  try {
    await page.goto('https://www.weex.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 35000 })
    await sleep(8000)
    
    const pageTitle = await page.title()
    console.log('Page title:', pageTitle)
    
    // Find tabs
    const allText = await page.evaluate(() => {
      const els = document.querySelectorAll('button, [role="tab"], a, .tab-item, [class*="tab"], li')
      return Array.from(els).map(e => ({ text: e.textContent?.trim(), tag: e.tagName, cls: e.className?.slice(0, 50) }))
        .filter(e => e.text && e.text.length < 60 && e.text.length > 1)
    })
    const uniqueTabText = [...new Set(allText.map(e => e.text))].filter(Boolean)
    console.log('Tabs/buttons:', uniqueTabText.slice(0, 40))
    
    // Try clicking spot tab
    for (const tabText of ['Spot', 'Spot Copy', 'SPOT', 'Spot Trading', 'Spot Trader']) {
      try {
        const el = await page.locator(`text="${tabText}"`).first()
        if (await el.isVisible({ timeout: 2000 })) {
          console.log(`Clicking: "${tabText}"`)
          await el.click()
          await sleep(6000)
          break
        }
      } catch {}
    }
    
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(3000)
    
  } catch (e) {
    console.log('WEEX nav error:', e.message.slice(0, 200))
  }

  if (responseStructure) {
    console.log('\nWeex response structure found:')
    console.log('URL:', responseStructure.url)
    console.log('Total:', responseStructure.total)
    console.log('First row keys:', Object.keys(responseStructure.firstRow).join(', '))
    console.log('Full first row:', JSON.stringify(responseStructure.firstRow, null, 2).slice(0, 1000))
  }

  console.log('\nTotal captured traders:', capturedTraderData.length)
  if (capturedTraderData.length > 0) {
    console.log('Sample IDs:', capturedTraderData.slice(0, 5).map(r => r.traderUserId || r.userId || r.id || r.traderId || JSON.stringify(Object.keys(r))).join(', '))
  }

  await browser.close()
  return { capturedTraderData, responseStructure }
}

// Run discoveries
try {
  await discoverMEXCSpot()
} catch (e) {
  console.error('MEXC discovery failed:', e.message)
}

try {
  await discoverWeexSpot()
} catch (e) {
  console.error('WEEX discovery failed:', e.message)
}
