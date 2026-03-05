#!/usr/bin/env node
/**
 * Debug: intercept all network requests on a bitget spot trader page
 */
import { chromium } from 'playwright'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const traderId = process.argv[2] || 'spot_10comjak'
  console.log(`Intercepting network for trader: ${traderId}`)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  const page = await ctx.newPage()

  // Intercept all API-looking requests
  const apiCalls = []
  page.on('request', req => {
    const url = req.url()
    if (url.includes('/v1/') || url.includes('/api/') || url.includes('trace') || url.includes('profit') || url.includes('cycle')) {
      const postData = req.postData()
      apiCalls.push({ url: url.split('?')[0], method: req.method(), postData })
    }
  })

  // Also listen to responses
  const responses = {}
  page.on('response', async resp => {
    const url = resp.url()
    if (url.includes('/v1/') && (url.includes('trace') || url.includes('profit') || url.includes('cycle') || url.includes('Detail') || url.includes('detail'))) {
      try {
        const body = await resp.text()
        responses[url.split('?')[0].split('/').slice(-1)[0]] = {
          url: url.split('?')[0],
          status: resp.status(),
          body: body.slice(0, 2000),
        }
      } catch {}
    }
  })

  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${traderId}/spot`,
      { waitUntil: 'networkidle', timeout: 45000 }
    )
  } catch(e) {
    console.log('Nav warn:', e.message.slice(0, 100))
  }
  await sleep(5000)

  console.log('\n=== API Requests Made ===')
  for (const call of apiCalls) {
    console.log(`\n${call.method} ${call.url}`)
    if (call.postData) console.log('  Body:', call.postData.slice(0, 300))
  }

  console.log('\n=== API Responses ===')
  for (const [name, r] of Object.entries(responses)) {
    console.log(`\n${name} (${r.status}): ${r.url}`)
    console.log('  Body:', r.body.slice(0, 500))
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
