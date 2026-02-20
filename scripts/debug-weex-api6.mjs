#!/usr/bin/env node
/**
 * Capture weex signed headers then replay to paginate all traders
 */
import { chromium } from 'playwright'
import { execSync } from 'child_process'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
})
const page = await context.newPage()

let capturedRequest = null

const client = await context.newCDPSession(page)
await client.send('Network.enable')

client.on('Network.requestWillBeSent', p => {
  if (p.request.url.includes('traderListView') && !capturedRequest) {
    capturedRequest = { url: p.request.url, headers: p.request.headers, body: p.request.postData }
  }
})

try {
  await page.goto('https://www.weex.com/copy-trading', { waitUntil: 'networkidle', timeout: 35000 })
  await new Promise(r => setTimeout(r, 3000))
} catch (e) { console.log('Nav error:', e.message.slice(0, 100)) }

if (!capturedRequest) {
  console.log('No request captured')
  await browser.close()
  process.exit(1)
}

console.log('Captured request to:', capturedRequest.url)
console.log('Headers keys:', Object.keys(capturedRequest.headers).join(', '))

// Now replay with the captured headers but different bodies
const url = capturedRequest.url
const headers = capturedRequest.headers

// Build header args for curl
const headerArgs = Object.entries(headers)
  .filter(([k]) => !['content-length', 'connection'].includes(k.toLowerCase()))
  .map(([k, v]) => `-H '${k}: ${v.replace(/'/g, "'\\''")}'`)
  .join(' ')

// Test with page 1 first
const testBody = JSON.stringify({ languageType: 0, sortRule: 9, simulation: 0, pageNo: 1, pageSize: 50, nickName: '' })
const cmd = `curl -s --max-time 15 -X POST '${url}' ${headerArgs} -H 'content-type: application/json' -d '${testBody.replace(/'/g, "'\\''")}'`

console.log('\nTesting page 1...')
try {
  const output = execSync(cmd, { timeout: 20000 }).toString()
  const data = JSON.parse(output)
  console.log('Status code from data:', data.code)
  console.log('Total traders:', data?.data?.totals)
  console.log('Got rows:', data?.data?.rows?.length)
  if (data?.data?.rows?.[0]) {
    const first = data.data.rows[0]
    console.log('First:', first.traderUserId, first.traderNickName)
    console.log('ItemVoList:', JSON.stringify(first.itemVoList))
  }
} catch (e) {
  console.log('Error:', e.message.slice(0, 200))
}

// Also try trader home for one trader
const homeBody = JSON.stringify({ traderUserId: 4188609913, languageType: 0 })
for (const ep of ['traderHome', 'traderDetail', 'traderRiskAbstract', 'traderProfile', 'traderStatistics', 'traderAbstractInfo']) {
  const detailUrl = url.replace('traderListView', ep)
  const detailCmd = `curl -s --max-time 10 -X POST '${detailUrl}' ${headerArgs} -H 'content-type: application/json' -d '${homeBody}'`
  try {
    const out = execSync(detailCmd, { timeout: 12000 }).toString()
    if (out && !out.includes('521') && !out.includes('404')) {
      const parsed = JSON.parse(out)
      console.log('\n=== ' + ep + ' ===')
      console.log(JSON.stringify(parsed, null, 2).slice(0, 1000))
    }
  } catch {}
}

await browser.close()
