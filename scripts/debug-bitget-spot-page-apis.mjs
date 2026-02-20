#!/usr/bin/env node
/**
 * Navigate to Bitget spot copy-trading leaderboard and intercept ALL API calls
 */
import { chromium } from 'playwright'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  const page = await ctx.newPage()

  // Capture all API requests/responses
  const captured = []
  page.on('request', req => {
    const url = req.url()
    if (url.includes('/v1/') && !url.includes('monitor') && !url.includes('buried') && !url.includes('bgstatic')) {
      captured.push({ type: 'request', url: url.split('?')[0], method: req.method(), postData: req.postData()?.slice(0, 200) })
    }
  })
  page.on('response', async resp => {
    const url = resp.url()
    if (url.includes('/v1/') && !url.includes('monitor') && !url.includes('buried') && !url.includes('bgstatic')) {
      try {
        const body = await resp.text()
        if (!body.startsWith('<')) {
          captured.push({ type: 'response', url: url.split('?')[0], status: resp.status(), body: body.slice(0, 500) })
        }
      } catch {}
    }
  })

  // Navigate to spot copy-trading leaderboard  
  console.log('Navigating to spot leaderboard...')
  await page.goto('https://www.bitget.com/copy-trading/spot', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(5000)

  // Print all API calls
  const seen = new Set()
  console.log('\n=== API Requests (unique) ===')
  for (const c of captured) {
    if (c.type === 'request') {
      const key = `${c.method} ${c.url}`
      if (!seen.has(key)) {
        seen.add(key)
        console.log(`\n${key}`)
        if (c.postData) console.log('  Body:', c.postData)
      }
    }
  }

  console.log('\n=== Interesting Responses ===')
  for (const c of captured) {
    if (c.type === 'response' && c.status === 200 && 
        (c.url.includes('trace') || c.url.includes('profit') || c.url.includes('copy') || c.url.includes('trader') || c.url.includes('rank'))) {
      console.log(`\n${c.url} (${c.status}):`)
      console.log(c.body.slice(0, 500))
    }
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
