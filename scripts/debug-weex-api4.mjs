#!/usr/bin/env node
/**
 * Use Playwright to make weex API calls from WITHIN the browser page context
 * The page's JS already has the SDK that adds signed headers via interceptors
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
})
const page = await context.newPage()

let capturedTraderListData = null

// Intercept responses via CDP
const client = await context.newCDPSession(page)
await client.send('Network.enable')

const requestMap = {}
client.on('Network.requestWillBeSent', p => {
  if (p.request.url.includes('traderListView')) {
    requestMap[p.requestId] = p.request
  }
})
client.on('Network.loadingFinished', async p => {
  if (requestMap[p.requestId]) {
    try {
      const resp = await client.send('Network.getResponseBody', { requestId: p.requestId })
      const data = JSON.parse(resp.body)
      capturedTraderListData = { 
        url: requestMap[p.requestId].url,
        body: requestMap[p.requestId].postData,
        data
      }
    } catch {}
  }
})

try {
  await page.goto('https://www.weex.com/copy-trading', { waitUntil: 'networkidle', timeout: 35000 })
  await new Promise(r => setTimeout(r, 4000))
} catch (e) { console.log('Nav error:', e.message.slice(0, 100)) }

// Show what we captured
if (capturedTraderListData) {
  console.log('Initial traderListView URL:', capturedTraderListData.url)
  console.log('Request body:', capturedTraderListData.body)
  console.log('Response rows count:', capturedTraderListData.data?.data?.rows?.length)
  console.log('Total:', capturedTraderListData.data?.data?.totals)
  if (capturedTraderListData.data?.data?.rows?.[0]) {
    const firstRow = capturedTraderListData.data.data.rows[0]
    console.log('First trader:', firstRow.traderUserId, firstRow.traderNickName)
    console.log('ItemVoList:', JSON.stringify(firstRow.itemVoList))
  }
}

// Use axios/XHR directly from the page context
// The weex SDK automatically adds signed headers to XHR requests
const winRateData = await page.evaluate(async () => {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    // Try relative URL first
    xhr.open('POST', '/api/v1/public/trace/traderListView', true)
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        resolve({ status: xhr.status, body: xhr.responseText.slice(0, 3000) })
      }
    }
    xhr.send(JSON.stringify({ languageType: 0, sortRule: 7, simulation: 0, pageNo: 1, pageSize: 5 }))
  })
})
console.log('\nWin rate XHR response:', JSON.stringify(winRateData, null, 2))

// Try to access the page's own axios instance
const axiosResult = await page.evaluate(async () => {
  try {
    // Check if window.axios or any global HTTP client exists
    const axiosLike = window.axios || window.$http || window.Vue?.prototype?.$http
    if (axiosLike) {
      const result = await axiosLike.post('/api/v1/public/trace/traderListView', {
        languageType: 0, sortRule: 7, simulation: 0, pageNo: 1, pageSize: 5
      })
      return { found: true, data: result.data }
    }
    return { found: false, msg: 'No global axios found' }
  } catch (e) {
    return { error: e.message }
  }
})
console.log('\nAxios result:', JSON.stringify(axiosResult, null, 2))

// Try another XHR to trader home/detail
const TRADER_ID = 4188609913
const detailData = await page.evaluate(async (traderId) => {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/v1/public/trace/traderHome', true)
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        resolve({ status: xhr.status, body: xhr.responseText.slice(0, 3000) })
      }
    }
    xhr.send(JSON.stringify({ traderUserId: traderId, languageType: 0 }))
  })
}, TRADER_ID)
console.log('\nTrader home XHR response:', JSON.stringify(detailData, null, 2))

await browser.close()
