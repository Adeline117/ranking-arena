#!/usr/bin/env node
/**
 * Discover OKX Web3 copy-trade APIs by intercepting network requests
 */
import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  const apis = []
  page.on('response', async (response) => {
    const url = response.url()
    if ((url.includes('api') || url.includes('priapi')) && 
        (url.includes('copy') || url.includes('trade') || url.includes('leader') || url.includes('rank'))) {
      const ct = response.headers()['content-type'] || ''
      if (ct.includes('json')) {
        try {
          const body = await response.text()
          console.log(`\n=== ${response.status()} ${url} ===`)
          console.log(body.slice(0, 1000))
          apis.push(url)
        } catch {}
      }
    }
  })

  console.log('Navigating to OKX Web3 copy-trade leaderboard...')
  await page.goto('https://web3.okx.com/zh-hans/copy-trade/leaderboard', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 10000))

  // Try clicking on a trader to see detail API
  const traderLink = await page.$('a[href*="copy-trade"][href*="trader"], a[href*="copy-trade"][href*="detail"]')
  if (traderLink) {
    console.log('\n--- Clicking first trader ---')
    await traderLink.click()
    await new Promise(r => setTimeout(r, 5000))
  }

  console.log(`\n\nDiscovered ${apis.length} API endpoints`)
  await browser.close()
}

main().catch(console.error)
