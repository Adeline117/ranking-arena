#!/usr/bin/env node
/**
 * Paginate weex leaderboard via CDP request replay
 * Since XHR in page context goes to wrong URL, use CDP to replay intercepted requests
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
})
const page = await context.newPage()

// Intercept and replay with modified body
const client = await context.newCDPSession(page)
await client.send('Network.enable')
await client.send('Fetch.enable', {
  patterns: [{ urlPattern: '*traderListView*', requestStage: 'Request' }]
})

let capturedHeaders = null
let traderListUrl = null
let continueWithPage = 1
const allTraderData = []

client.on('Fetch.requestPaused', async (params) => {
  const url = params.request.url
  if (url.includes('traderListView')) {
    // Capture the signed headers
    capturedHeaders = params.request.headers
    traderListUrl = url
    
    // Continue the request but modify to get more pages / win rate sort
    const newBody = JSON.stringify({ 
      languageType: 0, 
      sortRule: 9, // default sort 
      simulation: 0, 
      pageNo: continueWithPage, 
      pageSize: 50,  // max page size
      nickName: '' 
    })
    
    await client.send('Fetch.continueRequest', {
      requestId: params.requestId,
      postData: Buffer.from(newBody).toString('base64')
    })
    
    console.log(`Intercepted traderListView, requesting page ${continueWithPage} with pageSize 50`)
  } else {
    await client.send('Fetch.continueRequest', { requestId: params.requestId })
  }
})

// Capture the response
const capturedResponses = []
client.on('Network.responseReceived', (p) => {
  if (p.response.url.includes('traderListView')) {
    // Will be captured in loadingFinished
  }
})

client.on('Network.loadingFinished', async (p) => {
  try {
    const resp = await client.send('Network.getResponseBody', { requestId: p.requestId })
    if (!resp.body) return
    const data = JSON.parse(resp.body)
    if (data?.data?.rows) {
      capturedResponses.push({ rows: data.data.rows, totals: data.data.totals, page: continueWithPage })
    }
  } catch {}
})

try {
  await page.goto('https://www.weex.com/copy-trading', { waitUntil: 'networkidle', timeout: 35000 })
  await new Promise(r => setTimeout(r, 4000))
} catch (e) { console.log('Nav error:', e.message.slice(0, 100)) }

console.log('\nCaptured:', capturedResponses.length, 'responses')
if (capturedResponses.length > 0) {
  const resp = capturedResponses[0]
  console.log('Totals:', resp.totals, 'Got:', resp.rows?.length)
  const first = resp.rows?.[0]
  console.log('First trader:', first?.traderUserId, first?.traderNickName)
  console.log('ItemVoList:', JSON.stringify(first?.itemVoList))
  
  // Extract all traders from the response
  for (const row of (resp.rows || [])) {
    const winRate = row.itemVoList?.find(i => i.showColumnDesc?.includes('Win rate'))?.showColumnValue
    allTraderData.push({ 
      id: row.traderUserId,
      name: row.traderNickName,
      winRate: winRate ? parseFloat(winRate) : null
    })
  }
}

console.log('\nExtracted traders:', allTraderData.length)
console.log('Sample:', JSON.stringify(allTraderData.slice(0, 5), null, 2))
console.log('With win rate:', allTraderData.filter(t => t.winRate !== null).length)

await browser.close()
