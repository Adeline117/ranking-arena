#!/usr/bin/env node
/**
 * OKX spot API discovery with page.on('response')
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'en-GB',
})
const page = await context.newPage()

const apiCalls = []
page.on('response', async res => {
  const url = res.url()
  if (url.includes('/api/') && res.status() < 400) {
    try {
      const body = await res.text()
      if (body.length < 50000 && !body.startsWith('<!')) {
        apiCalls.push({ url: url.slice(0, 200), status: res.status(), body: body.slice(0, 1500) })
      }
    } catch {}
  }
})

try {
  await page.goto('https://www.okx.com/en/copy-trading', { waitUntil: 'networkidle', timeout: 40000 })
  await new Promise(r => setTimeout(r, 3000))
  console.log('Initial load done, API calls so far:', apiCalls.length)
  
  // Find and click spot tab  
  const spotTab = await page.$('text="Spot"')
  if (spotTab) {
    console.log('Clicking spot tab...')
    await spotTab.click()
    await new Promise(r => setTimeout(r, 8000))
    console.log('After spot click, API calls:', apiCalls.length)
  }
} catch (e) { console.log('Error:', e.message.slice(0, 100)) }

console.log('\n=== API Calls:', apiCalls.length)
for (const call of apiCalls) {
  console.log('\n--- ' + call.url + ' ---')
  console.log(call.body.slice(0, 800))
}

await browser.close()
