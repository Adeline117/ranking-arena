import { chromium } from 'playwright'

const BASE = 'https://www.arenafi.org'
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
})
const page = await context.newPage()

// Phase 1: Get actual trader links from Bybit and OKX ranking pages by clicking on them
console.log('=== Finding actual trader detail links ===')

// Bybit ranking page - click first trader
await page.goto(BASE + '/rankings/bybit', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)

// Click on the first trader row to see what URL it navigates to
const bybitTraderUrl = await page.evaluate(() => {
  const links = document.querySelectorAll('a[href*="/trader/"]')
  const hrefs = []
  for (const link of links) {
    const href = link.getAttribute('href')
    if (href) hrefs.push(href)
  }
  return hrefs
})
console.log('Bybit trader links found:')
for (const url of bybitTraderUrl.slice(0, 5)) {
  console.log('  ' + url)
}

// Test Bybit detail - first trader
if (bybitTraderUrl.length > 0) {
  const bybitUrl = bybitTraderUrl[0]
  console.log('\nNavigating to Bybit trader: ' + bybitUrl)
  
  // Check API call
  const apiCalls = []
  page.on('response', resp => {
    if (resp.url().includes('/api/') && resp.url().includes('trader')) {
      apiCalls.push({ url: resp.url().substring(0, 200), status: resp.status() })
    }
  })
  
  await page.goto(BASE + bybitUrl, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: '/tmp/arena-bybit-detail-test.png', fullPage: false })
  
  const pageText = await page.textContent('body')
  console.log('Page shows "Trader Not Found": ' + pageText.includes('Trader Not Found'))
  console.log('Page shows trader name: ' + !pageText.includes('Trader Not Found'))
  
  console.log('API calls made:')
  for (const call of apiCalls) {
    console.log('  [' + call.status + '] ' + call.url)
  }
}

// OKX ranking page
await page.goto(BASE + '/rankings/okx', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)

const okxTraderUrls = await page.evaluate(() => {
  const links = document.querySelectorAll('a[href*="/trader/"]')
  return Array.from(links).map(l => l.getAttribute('href')).slice(0, 5)
})
console.log('\nOKX trader links found:')
for (const url of okxTraderUrls) {
  console.log('  ' + url)
}

if (okxTraderUrls.length > 0) {
  const okxUrl = okxTraderUrls[0]
  console.log('\nNavigating to OKX trader: ' + okxUrl)
  
  const apiCalls2 = []
  page.on('response', resp => {
    if (resp.url().includes('/api/') && resp.url().includes('trader')) {
      apiCalls2.push({ url: resp.url().substring(0, 200), status: resp.status() })
    }
  })
  
  await page.goto(BASE + okxUrl, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: '/tmp/arena-okx-detail-test.png', fullPage: false })
  
  const pageText = await page.textContent('body')
  console.log('Page shows "Trader Not Found": ' + pageText.includes('Trader Not Found'))
  
  console.log('API calls:')
  for (const call of apiCalls2) {
    console.log('  [' + call.status + '] ' + call.url)
  }
}

// GMX trader detail test
await page.goto(BASE + '/rankings/gmx', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)

const gmxTraderUrls = await page.evaluate(() => {
  const links = document.querySelectorAll('a[href*="/trader/"]')
  return Array.from(links).map(l => l.getAttribute('href')).slice(0, 3)
})
console.log('\nGMX trader links found:')
for (const url of gmxTraderUrls) {
  console.log('  ' + url)
}

if (gmxTraderUrls.length > 0) {
  console.log('\nNavigating to GMX trader: ' + gmxTraderUrls[0])
  await page.goto(BASE + gmxTraderUrls[0], { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: '/tmp/arena-gmx-detail-test.png', fullPage: false })
  
  const pageText = await page.textContent('body')
  console.log('Page shows "Trader Not Found": ' + pageText.includes('Trader Not Found'))
  
  // Check content
  console.log('Has ROI: ' + (pageText.includes('ROI') || pageText.includes('Return')))
  console.log('Has PnL: ' + (pageText.includes('PnL') || pageText.includes('$')))
  console.log('Has Win Rate: ' + (pageText.includes('Win')))
  console.log('Has Score: ' + (pageText.includes('Score')))
  
  // Try Stats tab
  try {
    const statsBtn = page.locator('button, a').filter({ hasText: /Stats/i }).first()
    if (await statsBtn.isVisible({ timeout: 2000 })) {
      await statsBtn.click()
      await page.waitForTimeout(3000)
      await page.screenshot({ path: '/tmp/arena-gmx-detail-stats.png', fullPage: false })
      console.log('GMX Stats tab screenshot saved')
    }
  } catch(e) {}
}

// MEXC trader detail test
await page.goto(BASE + '/rankings/mexc', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)

const mexcTraderUrls = await page.evaluate(() => {
  const links = document.querySelectorAll('a[href*="/trader/"]')
  return Array.from(links).map(l => l.getAttribute('href')).slice(0, 3)
})
console.log('\nMEXC trader links found:')
for (const url of mexcTraderUrls) {
  console.log('  ' + url)
}

if (mexcTraderUrls.length > 0) {
  console.log('\nNavigating to MEXC trader: ' + mexcTraderUrls[0])
  await page.goto(BASE + mexcTraderUrls[0], { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: '/tmp/arena-mexc-detail-test.png', fullPage: false })
  
  const pageText = await page.textContent('body')
  console.log('Page shows "Trader Not Found": ' + pageText.includes('Trader Not Found'))
  console.log('Has ROI: ' + (pageText.includes('ROI') || pageText.includes('Return')))
}

// Additional: test period switching on a working detail page
console.log('\n=== Period Switch Test (Binance) ===')
await page.goto(BASE + '/trader/4915088971323900929?platform=binance_futures', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(4000)

// Try clicking 7D period
try {
  const period7d = page.locator('button, [role="tab"]').filter({ hasText: /^7D$/ }).first()
  if (await period7d.isVisible({ timeout: 3000 })) {
    await period7d.click()
    await page.waitForTimeout(3000)
    await page.screenshot({ path: '/tmp/arena-binance-7d.png', fullPage: false })
    console.log('7D period clicked, screenshot saved')
    
    const bodyText = await page.textContent('body')
    const roiMatch = bodyText.match(/[+-]?\d+[\d,.]*%/)
    console.log('ROI shown: ' + (roiMatch ? roiMatch[0] : 'not found'))
  }
} catch(e) {
  console.log('7D period error: ' + e.message.substring(0, 80))
}

// Try clicking 30D period
try {
  const period30d = page.locator('button, [role="tab"]').filter({ hasText: /^30D$/ }).first()
  if (await period30d.isVisible({ timeout: 3000 })) {
    await period30d.click()
    await page.waitForTimeout(3000)
    await page.screenshot({ path: '/tmp/arena-binance-30d.png', fullPage: false })
    console.log('30D period clicked, screenshot saved')
  }
} catch(e) {
  console.log('30D period error: ' + e.message.substring(0, 80))
}

await browser.close()
console.log('\nDone!')
