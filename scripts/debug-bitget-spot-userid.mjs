#!/usr/bin/env node
/**
 * Debug: get real internal user IDs for bitget spot traders
 */
import { chromium } from 'playwright'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const traderId = process.argv[2] || 'spot_10comjak'
  console.log(`Looking up internal ID for: ${traderId}`)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  const page = await ctx.newPage()

  // Capture userIndex and other identity calls
  const responses = {}
  page.on('response', async resp => {
    const url = resp.url()
    if (url.includes('userIndex') || url.includes('traderDetailPage') || url.includes('userinfo') || url.includes('social')) {
      try {
        const body = await resp.text()
        const key = url.split('/').slice(-1)[0].split('?')[0]
        responses[key] = { url, status: resp.status(), body }
      } catch {}
    }
  })

  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${traderId}/spot`,
      { waitUntil: 'networkidle', timeout: 40000 }
    )
  } catch(e) {
    console.log('Nav warn:', e.message.slice(0, 100))
  }
  await sleep(3000)

  console.log('\n=== Identity API Responses ===')
  for (const [name, r] of Object.entries(responses)) {
    console.log(`\n${name} (${r.status}): ${r.url}`)
    console.log(r.body.slice(0, 1000))
  }

  // Now try to call userIndex directly via page.evaluate
  console.log('\n=== Direct userIndex call ===')
  const userIndexResult = await page.evaluate(async ({ traderId }) => {
    try {
      const resp = await fetch('/v1/social/public/userIndex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: traderId })
      })
      return { status: resp.status, data: await resp.json() }
    } catch(e) { return { error: e.toString() } }
  }, { traderId })
  console.log(JSON.stringify(userIndexResult, null, 2))

  // Try with numeric part
  const numericId = traderId.replace(/^spot_/, '')
  console.log(`\n=== userIndex with rawId=${numericId} ===`)
  const rawResult = await page.evaluate(async ({ numericId }) => {
    try {
      const resp = await fetch('/v1/social/public/userIndex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: numericId })
      })
      return { status: resp.status, data: await resp.json() }
    } catch(e) { return { error: e.toString() } }
  }, { numericId })
  console.log(JSON.stringify(rawResult, null, 2))

  // Try traderDetailPage with traderUid
  console.log('\n=== traderDetailPage with spot_ prefix ===')
  const detailResult = await page.evaluate(async ({ traderId }) => {
    try {
      const resp = await fetch('/v1/trace/spot/trader/traderDetailPage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languageType: 0, traderUid: traderId })
      })
      return { status: resp.status, data: await resp.json() }
    } catch(e) { return { error: e.toString() } }
  }, { traderId })
  console.log(JSON.stringify(detailResult, null, 2))

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
