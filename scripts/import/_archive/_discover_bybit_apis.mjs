#!/usr/bin/env node
/**
 * Discover Bybit copy-trading position API endpoints by intercepting network requests
 * on a trader's profile page.
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
puppeteer.use(StealthPlugin())

const TRADER_URL = 'https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=almighty_trades'

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  const apiCalls = []
  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('beehive') || url.includes('order') || url.includes('position') || url.includes('trade')) {
      const status = response.status()
      let body = ''
      try { body = (await response.text()).slice(0, 500) } catch {}
      apiCalls.push({ url: url.split('?')[0], status, bodyPreview: body.slice(0, 200) })
      console.log(`[${status}] ${url.slice(0, 120)}`)
    }
  })

  console.log('Navigating to trader profile...')
  try {
    await page.goto(TRADER_URL, { waitUntil: 'networkidle2', timeout: 45000 })
  } catch { console.log('Timeout, continuing...') }

  // Wait for dynamic content
  await new Promise(r => setTimeout(r, 5000))

  // Click on "Positions" or "History" tab if available
  await page.evaluate(() => {
    document.querySelectorAll('div, span, button, a').forEach(el => {
      const text = (el.textContent || '').toLowerCase().trim()
      if (text === 'positions' || text === 'history' || text === 'trades' || text === 'order history') {
        try { el.click() } catch {}
      }
    })
  })
  await new Promise(r => setTimeout(r, 3000))

  console.log('\n=== All API calls ===')
  for (const call of apiCalls) {
    console.log(`${call.status} ${call.url}`)
    if (call.bodyPreview) console.log(`  ${call.bodyPreview}`)
  }

  await browser.close()
}

main().catch(console.error)
