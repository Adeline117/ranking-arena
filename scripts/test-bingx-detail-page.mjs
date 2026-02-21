#!/usr/bin/env node
/**
 * Test: what API calls does the BingX trader detail page make?
 * Navigate to https://bingx.com/en/CopyTrading/trader-detail/7933020
 * Log ALL api-app.qq-os.com responses
 */
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))

console.log('Launching browser...')
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
})
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US'
})
const page = await ctx.newPage()

const capturedResponses = []

page.on('response', async (resp) => {
  const url = resp.url()
  if (!url.includes('qq-os.com') && !url.includes('bingx.com/api')) return
  try {
    const json = await resp.json()
    const status = resp.status()
    console.log(`\n[${status}] ${url}`)
    console.log('  Keys:', JSON.stringify(Object.keys(json || {})))
    if (json?.data) {
      console.log('  data keys:', JSON.stringify(Object.keys(json.data || {})))
      // Try to find rankStat
      const str = JSON.stringify(json)
      if (str.includes('maxDrawDown') || str.includes('rankStat') || str.includes('winRate')) {
        console.log('  *** CONTAINS MDD/RANKSTAT/WINRATE ***')
        // Extract relevant part
        const data = json.data || {}
        const rankStat = data.rankStat || data.traderDetail?.rankStat || null
        if (rankStat) {
          console.log('  rankStat:', JSON.stringify(rankStat).slice(0, 500))
        }
        capturedResponses.push({ url, json })
      }
    }
  } catch (e) {
    // Non-JSON response
    const status = resp.status()
    if (url.includes('qq-os.com')) console.log(`[${status}] ${url} (non-JSON)`)
  }
})

console.log('Navigating to trader detail page...')
await page.goto('https://bingx.com/en/CopyTrading/trader-detail/7933020', {
  waitUntil: 'domcontentloaded',
  timeout: 30000
}).catch(e => console.log('Nav note:', e.message))

await sleep(8000)

if (capturedResponses.length > 0) {
  console.log(`\n\n=== FOUND ${capturedResponses.length} RELEVANT RESPONSES ===`)
  for (const { url, json } of capturedResponses) {
    console.log(`\n--- ${url} ---`)
    console.log(JSON.stringify(json, null, 2).slice(0, 2000))
  }
} else {
  console.log('\n\nNo relevant responses captured. The page may not have loaded the API data.')
  // Try to get network log
  console.log('\nPage title:', await page.title())
}

await browser.close()
console.log('Done.')
