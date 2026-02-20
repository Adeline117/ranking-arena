#!/usr/bin/env node
/**
 * Check getHistoryOrderList/getOpenOrderList and topTraderListView for avatar data
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const PROXY = 'http://127.0.0.1:7890'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const { data: nullRows } = await sb.from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'weex')
    .is('avatar_url', null)
    .limit(3)

  const testId = nullRows[0].source_trader_id

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  let capturedHeaders = null, capturedUrl = null

  // Capture order list and top trader data
  context.on('response', async resp => {
    const url = resp.url()
    if (url.includes('getHistoryOrderList') || url.includes('getOpenOrderList')) {
      try {
        const json = await resp.json().catch(() => null)
        if (json?.data?.rows?.[0]) {
          const r = json.data.rows[0]
          console.log(`\n=== ${url.split('/trace/')[1]} keys ===`)
          console.log(Object.keys(r).join(', '))
          const headPicFields = Object.entries(r).filter(([k]) => /head|avatar|photo|portrait|pic|img/i.test(k))
          console.log('Avatar fields:', headPicFields)
        }
      } catch {}
    }
    if (url.includes('topTraderListView')) {
      try {
        const json = await resp.json().catch(() => null)
        if (json?.data) {
          console.log('\n=== topTraderListView ===')
          console.log('data type:', typeof json.data, Array.isArray(json.data) ? 'array' : '')
          const items = Array.isArray(json.data) ? json.data : (json.data.rows || [json.data])
          for (const item of items.slice(0, 3)) {
            console.log('  keys:', Object.keys(item).join(', '))
            // Check list field
            if (item.list && Array.isArray(item.list)) {
              console.log('  list[0] keys:', Object.keys(item.list[0] || {}).join(', '))
              console.log('  list[0] headPic:', item.list[0]?.headPic)
              for (const t of item.list.slice(0, 5)) {
                const id = String(t.traderUserId || '')
                if (nullRows.some(r => r.source_trader_id === id)) {
                  console.log(`  FOUND NULL AVATAR in top list: ${id} headPic=${t.headPic}`)
                }
              }
            }
          }
        }
      } catch {}
    }
    if (url.includes('traderListView') && !capturedHeaders) {
      // Get from request
    }
  })

  context.route('**/trace/traderListView*', async (route) => {
    const req = route.request()
    const headers = req.headers()
    if (!capturedHeaders && headers['x-sig']) {
      capturedHeaders = { ...headers }
      capturedUrl = req.url()
    }
    const resp = await route.fetch().catch(() => null)
    if (resp) await route.fulfill({ response: resp })
    else await route.continue()
  })

  const page = await context.newPage()
  // First load main page to capture headers + topTraderListView
  await page.goto('https://www.weex.com/copy-trading', { timeout: 60000, waitUntil: 'networkidle' })
  await sleep(3000)

  // Now load the null-avatar trader's detail page
  await page.goto(`https://www.weex.com/copy-trading/trader/${testId}`, { timeout: 30000, waitUntil: 'networkidle' })
  await sleep(3000)

  // Test the captured headers with different API paths
  if (capturedHeaders && capturedUrl) {
    console.log('\n=== Testing more API endpoints ===')
    const baseGateway = capturedUrl.split('/api/')[0]
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://www.weex.com',
      'Referer': 'https://www.weex.com/',
      'User-Agent': capturedHeaders['user-agent'],
    }
    for (const k of ['x-sig','x-timestamp','appversion','bundleid','language','locale','terminalcode','terminaltype','sidecar','vs','traceid','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform']) {
      if (capturedHeaders[k]) reqHeaders[k] = capturedHeaders[k]
    }

    // Try traderHome with captured gateway URL
    const endpoints = [
      { ep: 'traderHome', body: { traderUserId: parseInt(testId), languageType: 0 } },
      { ep: 'traderDetail', body: { traderUserId: parseInt(testId), languageType: 0 } },
      { ep: 'traderInfo', body: { traderUserId: parseInt(testId) } },
      { ep: 'getTraderInfo', body: { traderUserId: parseInt(testId) } },
      { ep: 'traderListView', body: { languageType: 0, sortRule: 9, simulation: 0, pageNo: 1, pageSize: 20, nickName: nullRows[0].handle } },
    ]

    for (const { ep, body } of endpoints) {
      // Try both /api/v1/public and /api/v1/private
      for (const prefix of ['/api/v1/public/trace/', '/api/v1/private/trace/', '/api/v1/']) {
        const url = baseGateway + prefix + ep
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: reqHeaders,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
          })
          const text = await resp.text()
          if (!text.includes('404') && text.startsWith('{')) {
            const json = JSON.parse(text)
            if (json.code && json.code !== 'FAILURE') {
              console.log(`${prefix}${ep}: code=${json.code}`)
              if (json.data) {
                const bodyStr = JSON.stringify(json.data)
                const avatarMatches = bodyStr.match(/"(head|avatar|photo|portrait|pic)[A-Za-z]*":"([^"]{10,200})"/gi)
                if (avatarMatches) console.log('  Avatar fields:', avatarMatches.slice(0,5))
              }
            }
          }
        } catch {}
      }
    }
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
