#!/usr/bin/env node
/**
 * Capture weex API request with full headers, then replay
 */
import { chromium } from 'playwright'
import { execSync } from 'child_process'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
})
const page = await context.newPage()

// Intercept via CDP
const client = await context.newCDPSession(page)
await client.send('Network.enable')

let capturedRequest = null
const capturedResponses = {}

client.on('Network.requestWillBeSent', p => {
  const url = p.request.url
  if (url.includes('traderListView') || url.includes('traderHome') || url.includes('traderDetail')) {
    capturedRequest = {
      url,
      method: p.request.method,
      headers: p.request.headers,
      body: p.request.postData
    }
    console.log('CAPTURED REQUEST:', url)
    console.log('Headers:', JSON.stringify(p.request.headers, null, 2).slice(0, 800))
  }
})

client.on('Network.loadingFinished', async p => {
  const req = capturedRequest
  if (req) {
    try {
      const resp = await client.send('Network.getResponseBody', { requestId: p.requestId })
      capturedResponses[req.url] = resp.body.slice(0, 3000)
    } catch {}
  }
})

try {
  await page.goto('https://www.weex.com/copy-trading', { waitUntil: 'networkidle', timeout: 35000 })
  await new Promise(r => setTimeout(r, 5000))
} catch (e) { console.log('Nav error:', e.message.slice(0, 100)) }

console.log('\n=== Response Bodies ===')
for (const [url, body] of Object.entries(capturedResponses)) {
  console.log('URL:', url)
  console.log('BODY:', body.slice(0, 2000))
  console.log()
}

// Now try to navigate to a trader detail page and capture more APIs
if (capturedRequest) {
  // Try to make win rate leaderboard call
  try {
    await page.evaluate(async () => {
      // Try to call the weex SDK's API functions
      // Look for any global weex API objects
      const keys = Object.keys(window).filter(k => 
        k.toLowerCase().includes('api') || k.toLowerCase().includes('weex') || k.toLowerCase().includes('gateway')
      )
      console.log('Global API keys:', keys.slice(0, 20))
    })
  } catch (e) {}
}

// Get the actual gateway URL from the page's JS context
const gatewayUrl = await page.evaluate(() => {
  // Try to find the gateway URL
  try {
    const scripts = document.querySelectorAll('script')
    for (const s of scripts) {
      if (s.src && (s.src.includes('gateway') || s.src.includes('api'))) {
        return s.src
      }
    }
  } catch {}
  // Check if there's a config object
  try {
    return window.__WEEX_CONFIG__ || window.GATEWAY_URL || window.API_BASE || 'not found'
  } catch { return 'not found' }
})
console.log('\nGateway URL from page:', gatewayUrl)

// Use the captured request to try win_rate endpoint  
if (capturedRequest) {
  const headers = capturedRequest.headers
  const gatewayBase = capturedRequest.url.replace(/\/api\/.*/, '')
  console.log('\nGateway base:', gatewayBase)
  
  // Build curl command with same headers
  const headerArgs = Object.entries(headers)
    .filter(([k]) => !['accept-encoding', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'origin', 'host'].includes(k))
    .map(([k, v]) => `-H '${k}: ${v.replace(/'/g, "'\\''")}'`)
    .join(' ')
  
  // Try win rate endpoint
  const winRateUrl = `${gatewayBase}/api/v1/public/trace/traderListView`
  const winRateBody = JSON.stringify({ languageType: 0, sortRule: 7, simulation: 0, pageNo: 1, pageSize: 20, nickName: '' })
  
  const cmd = `curl -s --max-time 15 -X POST '${winRateUrl}' ${headerArgs} -H 'content-type: application/json' -d '${winRateBody}'`
  console.log('\nWin rate curl command (truncated):', cmd.slice(0, 300))
  
  try {
    const output = execSync(cmd, { timeout: 20000 }).toString()
    console.log('\nWin rate response:', output.slice(0, 2000))
  } catch (e) {
    console.log('Win rate error:', e.message.slice(0, 200))
  }
}

await browser.close()
