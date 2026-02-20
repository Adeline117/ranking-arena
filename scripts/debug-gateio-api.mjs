#!/usr/bin/env node
/**
 * Debug: intercept Gate.io copy trading API calls
 */
import { chromium } from 'playwright'
import { sleep } from './lib/shared.mjs'

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  
  const allRequests = []
  const allResponses = []
  
  page.on('request', req => {
    const url = req.url()
    if (url.includes('copy') || url.includes('leader') || url.includes('trader') || url.includes('api')) {
      allRequests.push({ method: req.method(), url: url.slice(0, 150) })
    }
  })
  
  page.on('response', async res => {
    const url = res.url()
    if (res.status() !== 200) return
    if (!url.includes('copy') && !url.includes('leader') && !url.includes('api')) return
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const j = await res.json()
      const preview = JSON.stringify(j).slice(0, 200)
      allResponses.push({ url: url.slice(0, 150), preview })
    } catch {}
  })

  console.log('=== Navigating to gate.io/copytrading ===')
  await page.goto('https://www.gate.io/copytrading', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
  await sleep(5000)
  
  console.log('\n=== API Requests ===')
  for (const r of allRequests.slice(0, 30)) console.log(`${r.method} ${r.url}`)
  
  console.log('\n=== JSON Responses ===')
  for (const r of allResponses.slice(0, 20)) console.log(`${r.url}\n  → ${r.preview}\n`)
  
  // Now navigate to a specific trader
  console.log('\n=== Navigating to trader 21597 ===')
  allRequests.length = 0
  allResponses.length = 0
  
  await page.goto('https://www.gate.io/copytrading/trader/21597', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
  await sleep(4000)
  
  console.log('\n=== Trader detail API Requests ===')
  for (const r of allRequests.slice(0, 30)) console.log(`${r.method} ${r.url}`)
  
  console.log('\n=== Trader detail JSON Responses ===')
  for (const r of allResponses.slice(0, 20)) console.log(`${r.url}\n  → ${r.preview}\n`)
  
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
