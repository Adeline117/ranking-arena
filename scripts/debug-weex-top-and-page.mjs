#!/usr/bin/env node
/**
 * Check topTraderListView endpoint + individual trader page HTML for avatars
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
    .limit(10)

  const testId = nullRows[0].source_trader_id
  const missingSet = new Set(nullRows.map(r => r.source_trader_id))
  console.log(`Testing with ${nullRows.length} traders, first: ${testId} (${nullRows[0].handle})`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  // Intercept topTraderListView
  let topTraderData = null
  let capturedHeaders = null
  let capturedUrl = null

  context.route('**/trace/topTraderListView*', async (route) => {
    const resp = await route.fetch().catch(() => null)
    if (resp) {
      try {
        const text = await resp.text()
        const json = JSON.parse(text)
        if (json.code === 'SUCCESS') {
          topTraderData = json.data
          console.log('\n=== topTraderListView response ===')
          console.log('rows count:', json.data?.rows?.length || json.data?.length)
          if (json.data?.rows?.[0]) {
            const r = json.data.rows[0]
            console.log('keys:', Object.keys(r).join(', '))
            console.log('headPic:', r.headPic)
            // Check for any null-avatar trader in top
            for (const row of json.data.rows) {
              const id = String(row.traderUserId || '')
              if (missingSet.has(id)) {
                console.log(`  FOUND null-avatar trader in top: ${id} headPic=${row.headPic}`)
              }
            }
          }
        }
        await route.fulfill({ response: resp, body: text })
      } catch { await route.fulfill({ response: resp }) }
    } else await route.continue()
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
  await page.goto('https://www.weex.com/copy-trading', { timeout: 60000, waitUntil: 'networkidle' })
  await sleep(3000)

  // Now navigate to individual trader page and capture HTML
  console.log(`\n=== Checking trader page HTML for ${testId} ===`)
  await page.goto(`https://www.weex.com/copy-trading/trader/${testId}`, { timeout: 30000, waitUntil: 'networkidle' })
  await sleep(2000)

  // Look for image tags that might be avatars
  const imgs = await page.evaluate(() => {
    const images = document.querySelectorAll('img')
    return [...images].map(img => img.src).filter(src => src && src.includes('http'))
  })
  console.log('Images on page:', imgs.slice(0, 10))

  // Check __NEXT_DATA__ for embedded trader data
  const nextData = await page.evaluate(() => {
    try {
      const el = document.getElementById('__NEXT_DATA__')
      if (!el) return null
      const data = JSON.parse(el.textContent)
      // Deep search for headPic
      const text = JSON.stringify(data)
      const matches = text.match(/"headPic":"([^"]+)"/g)
      return { hasHeadPic: !!matches, samples: matches?.slice(0, 3) }
    } catch { return null }
  })
  console.log('__NEXT_DATA__ headPic:', nextData)

  // Now test topTraderListView directly via captured headers
  if (capturedHeaders && capturedUrl) {
    const baseUrl = capturedUrl.split('/api/')[0] + '/api/v1/public/trace/topTraderListView'
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

    console.log('\n=== Calling topTraderListView directly ===')
    try {
      const resp = await fetch(baseUrl, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({ languageType: 0, simulation: 0 }),
        signal: AbortSignal.timeout(15000),
      })
      const json = await resp.json()
      console.log('code:', json.code, 'rows:', json.data?.rows?.length || json.data?.length)
      const rows = json.data?.rows || (Array.isArray(json.data) ? json.data : [])
      console.log('Sample keys:', Object.keys(rows[0] || {}).join(', '))
      for (const row of rows) {
        const id = String(row.traderUserId || '')
        if (missingSet.has(id)) console.log(`  In top! id=${id} headPic=${row.headPic}`)
      }
      // Show all headPic non-null
      const withPic = rows.filter(r => r.headPic)
      console.log(`topTraders with headPic: ${withPic.length}/${rows.length}`)
    } catch(e) { console.log('Error:', e.message) }

    // Also test traderAbstractInfo/traderHome via the captured URL base 
    console.log('\n=== traderAbstractInfo via captured URL base ===')
    for (const ep of ['traderHome', 'traderAbstractInfo', 'traderStatistics']) {
      const url = capturedUrl.split('/api/')[0] + `/api/v1/public/trace/${ep}`
      try {
        const body = JSON.stringify({ traderUserId: parseInt(testId), languageType: 0 })
        const r = await fetch(url, {
          method: 'POST',
          headers: reqHeaders,
          body,
          signal: AbortSignal.timeout(10000),
        })
        const txt = await r.text()
        if (!txt.includes('404')) {
          const j = JSON.parse(txt)
          console.log(`${ep}: code=${j.code} keys=${Object.keys(j.data || {}).slice(0,10).join(',')}`)
        } else {
          console.log(`${ep}: 404`)
        }
      } catch(e) { console.log(`${ep}: ${e.message.slice(0,60)}`) }
    }
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
