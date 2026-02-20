#!/usr/bin/env node
/**
 * Check if the 177 null-avatar weex traders appear in the API at all
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
  // Get ALL null-avatar trader IDs
  const { data: nullRows } = await sb.from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'weex')
    .is('avatar_url', null)
  const missingIds = new Set(nullRows.map(r => r.source_trader_id))
  console.log(`Null-avatar traders in DB: ${missingIds.size}`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  let capturedHeaders = null, capturedUrl = null
  const headersPromise = new Promise((resolve) => {
    context.route('**/trace/traderListView*', async (route) => {
      const req = route.request()
      const headers = req.headers()
      if (!capturedHeaders && headers['x-sig']) {
        capturedHeaders = { ...headers }
        capturedUrl = req.url()
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

  if (!capturedHeaders) { console.log('No headers captured'); return }

  const baseUrl = capturedUrl.split('/api/')[0] + '/api/v1/public/trace/traderListView'
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.weex.com',
    'Referer': 'https://www.weex.com/',
    'User-Agent': capturedHeaders['user-agent'] || 'Mozilla/5.0',
  }
  for (const k of ['x-sig','x-timestamp','appversion','bundleid','language','locale','terminalcode','terminaltype','sidecar','vs','traceid','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform']) {
    if (capturedHeaders[k]) reqHeaders[k] = capturedHeaders[k]
  }

  // Collect all traders from API: with AND without headPic
  const apiAll = new Map()   // id -> headPic (or null)
  let total = 9999

  for (const sortRule of [9]) {  // Just do one sort order first
    let pageNo = 1
    while ((pageNo - 1) * 20 < total) {
      try {
        const body = JSON.stringify({ languageType: 0, sortRule, simulation: 0, pageNo, pageSize: 20, nickName: '' })
        const resp = await fetch(baseUrl, {
          method: 'POST', headers: reqHeaders, body,
          signal: AbortSignal.timeout(15000),
        })
        const json = await resp.json()
        if (json.code !== 'SUCCESS' || !json.data?.rows) break
        total = json.data.totals || total
        for (const row of json.data.rows) {
          const id = String(row.traderUserId || '')
          if (id) apiAll.set(id, row.headPic || null)
        }
        if (!json.data.nextFlag) break
        pageNo++
        await sleep(200)
      } catch(e) { console.log('Error p'+pageNo+':', e.message.slice(0,60)); break }
    }
  }

  console.log(`API traders (sort=9 only): ${apiAll.size}, total declared: ${total}`)

  // Check overlap
  let inApiWithPic = 0, inApiNoPic = 0, notInApi = 0
  for (const id of missingIds) {
    if (apiAll.has(id)) {
      if (apiAll.get(id)) inApiWithPic++
      else inApiNoPic++
    } else {
      notInApi++
    }
  }

  console.log(`\nOf the ${missingIds.size} null-avatar traders:`)
  console.log(`  In API with headPic: ${inApiWithPic}   <-- these should have been fixed`)
  console.log(`  In API but headPic null: ${inApiNoPic} <-- API has no avatar for them`)
  console.log(`  Not in API at all: ${notInApi}         <-- inactive/removed traders`)

  // Show sample of "not in API" traders
  const notInApiIds = [...missingIds].filter(id => !apiAll.has(id)).slice(0, 5)
  console.log('\nSample not-in-API traders:')
  for (const id of notInApiIds) {
    const r = nullRows.find(r => r.source_trader_id === id)
    console.log('  ', id, r?.handle)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
