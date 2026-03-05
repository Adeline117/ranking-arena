#!/usr/bin/env node
/**
 * Capture weex POST headers (not OPTIONS) then paginate all traders
 */
import { chromium } from 'playwright'
import { execSync } from 'child_process'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
})
const page = await context.newPage()

let capturedPostRequest = null
const allTraderData = []

const client = await context.newCDPSession(page)
await client.send('Network.enable')

// Capture POST request (not OPTIONS preflight)
client.on('Network.requestWillBeSent', p => {
  if (p.request.url.includes('traderListView') && p.request.method === 'POST' && !capturedPostRequest) {
    capturedPostRequest = { url: p.request.url, headers: p.request.headers, body: p.request.postData }
    console.log('Captured POST request!')
    console.log('Headers:', JSON.stringify(Object.entries(p.request.headers).slice(0, 15)))
  }
})

// Capture responses
client.on('Network.loadingFinished', async p => {
  try {
    const resp = await client.send('Network.getResponseBody', { requestId: p.requestId })
    if (!resp.body) return
    const data = JSON.parse(resp.body)
    if (data?.data?.rows) {
      for (const row of data.data.rows) {
        const winRate = row.itemVoList?.find(i => i.showColumnDesc?.includes('Win rate'))?.showColumnValue
        allTraderData.push({
          id: String(row.traderUserId),
          name: row.traderNickName,
          winRate: winRate ? parseFloat(winRate) : null
        })
      }
      console.log(`Got ${data.data.rows.length} traders (total captured so far: ${allTraderData.length} of ${data.data.totals})`)
    }
  } catch {}
})

try {
  await page.goto('https://www.weex.com/copy-trading', { waitUntil: 'networkidle', timeout: 35000 })
  await new Promise(r => setTimeout(r, 3000))
} catch (e) { console.log('Nav error:', e.message.slice(0, 100)) }

if (capturedPostRequest) {
  console.log('\n=== Captured POST Request ===')
  console.log('URL:', capturedPostRequest.url)
  console.log('Headers:', JSON.stringify(capturedPostRequest.headers, null, 2).slice(0, 600))
  
  // Try replaying with different page sizes
  const url = capturedPostRequest.url
  const headers = capturedPostRequest.headers
  
  const headerArgs = Object.entries(headers)
    .filter(([k]) => !['content-length', 'connection', 'accept-encoding'].includes(k.toLowerCase()))
    .map(([k, v]) => `-H '${k}: ${v.replace(/'/g, "'\\''")}'`)
    .join(' ')
  
  // Try page 1 with larger size
  console.log('\nTrying page 1 with pageSize=100...')
  const body1 = JSON.stringify({ languageType: 0, sortRule: 9, simulation: 0, pageNo: 1, pageSize: 100, nickName: '' })
  try {
    const out = execSync(`curl -s --max-time 15 -X POST '${url}' ${headerArgs} -H 'content-type: application/json' -d '${body1.replace(/'/g, "'\\''")}'`, { timeout: 20000 }).toString()
    const data = JSON.parse(out)
    console.log('Response code:', data.code, 'Rows:', data?.data?.rows?.length, 'Total:', data?.data?.totals)
    if (data?.data?.rows?.[0]) {
      console.log('First item:', data.data.rows[0].traderUserId, data.data.rows[0].traderNickName)
      console.log('ItemVoList:', JSON.stringify(data.data.rows[0].itemVoList))
    }
  } catch (e) {
    console.log('Replay error:', e.message.slice(0, 200))
  }
}

console.log('\nTotal traders from live capture:', allTraderData.length)
console.log('Sample:', JSON.stringify(allTraderData.slice(0, 3), null, 2))

await browser.close()
