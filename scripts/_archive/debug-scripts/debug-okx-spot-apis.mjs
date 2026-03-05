#!/usr/bin/env node
/**
 * Debug OKX Spot copy trading APIs - intercept network calls
 * Find what APIs are called when visiting spot trader profile
 */
import { chromium } from 'playwright'

const BASE = 'https://www.okx.com/en-gb/copy-trading/spot'
const TRADER_ID = '27FA6B9BF399CFA2'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  const page = await context.newPage()
  
  const apiCalls = []
  page.on('request', req => {
    const url = req.url()
    if (url.includes('api') || url.includes('priapi')) {
      apiCalls.push({ method: req.method(), url: url.split('?')[0] })
    }
  })
  
  page.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('api') && !url.includes('priapi')) return
    try {
      const json = await resp.json()
      if (JSON.stringify(json).includes('drawdown') || JSON.stringify(json).includes('Drawdown') || JSON.stringify(json).includes('maxDd')) {
        console.log('=== FOUND MDD IN RESPONSE ===')
        console.log('URL:', url)
        console.log('Data:', JSON.stringify(json).slice(0, 500))
      }
    } catch {}
  })
  
  console.log('Navigating to OKX spot list page...')
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('Load timeout:', e.message))
  await new Promise(r => setTimeout(r, 5000))
  
  console.log('\nAPI calls made (spot list page):')
  for (const c of apiCalls.slice(0, 30)) {
    console.log(`  ${c.method} ${c.url}`)
  }
  
  // Try clicking on the first trader
  apiCalls.length = 0
  console.log('\nClicking first trader...')
  const firstTrader = page.locator('[class*=leader-item], [class*=trader-item], [class*=card]').first()
  if (await firstTrader.isVisible({ timeout: 3000 }).catch(() => false)) {
    await firstTrader.click()
    await new Promise(r => setTimeout(r, 5000))
    console.log('API calls after click:')
    for (const c of apiCalls.slice(0, 20)) {
      console.log(`  ${c.method} ${c.url}`)
    }
  }
  
  await browser.close()
}

main().catch(console.error)
