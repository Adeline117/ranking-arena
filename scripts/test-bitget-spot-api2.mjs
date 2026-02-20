#!/usr/bin/env node
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const TRADER_ID = process.argv[2] || 'b0b0497186b63851a195'

async function main() {
  console.log(`Testing trader: ${TRADER_ID}`)
  
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  const allUrls = []
  page.on('response', async (resp) => {
    allUrls.push({ url: resp.url(), status: resp.status() })
  })

  console.log('Navigating...')
  let pageContent = ''
  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${TRADER_ID}/spot`,
      { waitUntil: 'networkidle', timeout: 30000 }
    )
    pageContent = await page.title()
  } catch (e) {
    console.log('Navigation error:', e.message)
  }
  
  console.log('Page title:', pageContent)
  await sleep(3000)
  
  console.log(`Total requests: ${allUrls.length}`)
  const apiUrls = allUrls.filter(r => r.url.includes('/api/') || r.url.includes('bitget.com'))
  console.log('\nBitget API URLs:')
  apiUrls.slice(0, 30).forEach(r => console.log(`  [${r.status}] ${r.url.substring(0, 120)}`))
  
  await browser.close()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
