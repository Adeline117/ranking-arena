#!/usr/bin/env node
/**
 * Test per-trader detail endpoints for avatar fields
 * Uses Playwright to capture signed headers, then tests traderHome/traderDetail
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
  // Get a sample of null-avatar traders
  const { data: nullRows } = await sb.from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'weex')
    .is('avatar_url', null)
    .limit(5)

  console.log('Testing with traders:', nullRows.map(r => `${r.source_trader_id}(${r.handle})`).join(', '))

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  let capturedHeaders = null
  let capturedUrl = null

  const headersPromise = new Promise((resolve) => {
    context.route('**/trace/traderListView*', async (route) => {
      const req = route.request()
      const headers = req.headers()
      if (!capturedHeaders && headers['x-sig']) {
        capturedHeaders = { ...headers }
        capturedUrl = req.url()
        console.log('✓ Captured signed headers')
        resolve()
      }
      const resp = await route.fetch().catch(() => null)
      if (resp) await route.fulfill({ response: resp })
      else await route.continue()
    })
  })

  const page = await context.newPage()
  await page.goto('https://www.weex.com/copy-trading', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await Promise.race([headersPromise, sleep(20000)])
  await browser.close()

  if (!capturedHeaders || !capturedUrl) {
    console.log('Failed to capture headers')
    return
  }

  const baseUrl = capturedUrl.split('/api/')[0] + '/api/v1/public/trace/'

  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.weex.com',
    'Referer': 'https://www.weex.com/',
    'User-Agent': capturedHeaders['user-agent'] || 'Mozilla/5.0',
  }
  for (const k of ['x-sig', 'x-timestamp', 'appversion', 'bundleid', 'language', 'locale',
                   'terminalcode', 'terminaltype', 'sidecar', 'vs', 'traceid',
                   'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']) {
    if (capturedHeaders[k]) reqHeaders[k] = capturedHeaders[k]
  }

  const testId = nullRows[0].source_trader_id

  // Check traderListView response for this trader to see all fields
  console.log('\n=== First, check full traderListView fields for trader w/ headPic ===')
  try {
    const resp = await fetch(baseUrl + 'traderListView', {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({ languageType: 0, sortRule: 9, simulation: 0, pageNo: 1, pageSize: 20, nickName: '' }),
      signal: AbortSignal.timeout(15000),
    })
    const json = await resp.json()
    if (json.data?.rows?.[0]) {
      const r = json.data.rows[0]
      console.log('Trader:', r.traderUserId, r.traderNickName)
      console.log('Fields:', Object.keys(r).join(', '))
      console.log('headPic:', r.headPic)
      console.log('headImg:', r.headImg)
      console.log('avatar:', r.avatar)
      console.log('portraitUrl:', r.portraitUrl)
      console.log('photoUrl:', r.photoUrl)
    }
  } catch(e) { console.log('traderListView error:', e.message) }

  // Test detail endpoints
  const ENDPOINTS = ['traderHome', 'traderDetail', 'traderProfile', 'traderAbstractInfo', 'traderRiskAbstract']
  for (const ep of ENDPOINTS) {
    console.log(`\n=== ${ep} for trader ${testId} ===`)
    try {
      const body = JSON.stringify({ traderUserId: parseInt(testId), languageType: 0 })
      const resp = await fetch(baseUrl + ep, {
        method: 'POST',
        headers: { ...reqHeaders, 'content-length': String(body.length) },
        body,
        signal: AbortSignal.timeout(12000),
      })
      const text = await resp.text()
      const json = JSON.parse(text)
      console.log('code:', json.code)
      if (json.data) {
        const keys = Object.keys(json.data)
        console.log('data keys:', keys.join(', '))
        // Print avatar-related fields
        for (const k of keys) {
          if (/head|avatar|photo|portrait|pic|img|icon/i.test(k)) {
            console.log(`  ${k}:`, json.data[k])
          }
        }
      } else {
        console.log(JSON.stringify(json).slice(0, 300))
      }
    } catch(e) { console.log('Error:', e.message.slice(0,100)) }
    await sleep(500)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
