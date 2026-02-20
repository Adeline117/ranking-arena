#!/usr/bin/env node
/**
 * fix-avatars-weex.mjs
 * Fetch and store real avatar URLs for weex traders.
 * 
 * Uses Playwright + proxy + route interception to capture signed headers,
 * then replays traderListView with all sort orders to collect headPic URLs.
 * 
 * source_trader_id = traderUserId (numeric string)
 * avatar field = headPic
 * 
 * HARD RULES:
 *   - Only update WHERE avatar_url IS NULL in trader_sources
 *   - Never overwrite existing avatars
 *   - Only real CDN URLs, no fabricated avatars
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

function isRealAvatar(url) {
  if (!url || typeof url !== 'string' || url.length < 10) return false
  if (!url.startsWith('http')) return false
  const lower = url.toLowerCase()
  const fakes = ['boringavatars', 'dicebear', 'identicon']
  return !fakes.some(f => lower.includes(f))
}

async function captureAndFetchAll(missingIds) {
  const avatarMap = new Map()

  console.log('  🎭 Launching Playwright with proxy...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const context = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  })

  let capturedHeaders = null
  let capturedUrl = null

  // Use route interception to capture signed headers
  const headersPromise = new Promise((resolve) => {
    context.route('**/trace/traderListView*', async (route) => {
      const req = route.request()
      const headers = req.headers()

      if (!capturedHeaders && headers['x-sig']) {
        capturedHeaders = { ...headers }
        capturedUrl = req.url()
        console.log(`  ✓ Captured signed headers (x-sig: ${headers['x-sig']?.slice(0, 20)}...)`)
      }

      // Continue original request and capture response
      const resp = await route.fetch().catch(() => null)
      if (resp) {
        try {
          const text = await resp.text()
          const json = JSON.parse(text)
          if (json.code === 'SUCCESS') {
            for (const row of json.data?.rows || []) {
              const id = String(row.traderUserId || '')
              if (id && isRealAvatar(row.headPic)) avatarMap.set(id, row.headPic)
            }
          }
          await route.fulfill({ response: resp, body: text })
        } catch {
          await route.fulfill({ response: resp })
        }
      } else {
        await route.continue()
      }

      if (capturedHeaders) resolve()
    })
  })

  const page = await context.newPage()
  console.log('  Loading https://www.weex.com/copy-trading...')
  try {
    await page.goto('https://www.weex.com/copy-trading', { timeout: 60000, waitUntil: 'domcontentloaded' })
  } catch (e) {
    console.log('  Page load error (non-fatal):', e.message.slice(0, 80))
  }

  // Wait for headers
  await Promise.race([headersPromise, sleep(20000)])
  await sleep(2000)
  await browser.close()

  console.log(`  After page load: ${avatarMap.size} avatars captured from intercept`)

  if (!capturedHeaders) {
    console.log('  ⚠️  No signed headers captured')
    return avatarMap
  }

  // Build node-fetch-compatible headers
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.weex.com',
    'Referer': 'https://www.weex.com/',
    'User-Agent': capturedHeaders['user-agent'] || 'Mozilla/5.0',
  }
  // Add all signed headers
  for (const k of ['x-sig', 'x-timestamp', 'appversion', 'bundleid', 'language', 'locale',
                   'terminalcode', 'terminaltype', 'sidecar', 'vs', 'traceid',
                   'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']) {
    if (capturedHeaders[k]) reqHeaders[k] = capturedHeaders[k]
  }

  console.log(`  Paginating all sort orders via proxy...`)

  // Use whatever gateway URL was captured (weex168.ru, janapw.com, weex.com, etc.)
  const baseGatewayUrl = capturedUrl.split('/api/')[0] + '/api/v1/public/trace/traderListView'

  const SORT_RULES = [9, 0, 5, 6, 7, 8, 1, 2, 4]
  let total = 9999

  for (const sortRule of SORT_RULES) {
    let pageNo = 1

    while ((pageNo - 1) * 20 < total) {
      try {
        const body = JSON.stringify({
          languageType: 0,
          sortRule,
          simulation: 0,
          pageNo,
          pageSize: 20,
          nickName: '',
        })

        const resp = await fetch(baseGatewayUrl, {
          method: 'POST',
          headers: reqHeaders,
          body,
          signal: AbortSignal.timeout(15000),
        })

        const json = await resp.json()
        if (json.code !== 'SUCCESS' || !json.data?.rows) {
          console.log(`  sort=${sortRule} p=${pageNo}: failed (${json.code})`)
          break
        }

        total = json.data.totals || total
        for (const row of json.data.rows) {
          const id = String(row.traderUserId || '')
          if (id && isRealAvatar(row.headPic)) avatarMap.set(id, row.headPic)
        }

        const matched = missingIds ? [...missingIds].filter(id => avatarMap.has(id)).length : -1
        process.stdout.write(`  sort=${sortRule} p=${pageNo}: +${json.data.rows.length} | avatars=${avatarMap.size} matched=${matched}/${missingIds?.size || '?'}\r`)

        if (!json.data.nextFlag) break
        pageNo++
        await sleep(300)
      } catch (e) {
        console.log(`\n  sort=${sortRule} p=${pageNo}: ${e.message.slice(0, 60)}`)
        break
      }
    }
    console.log()

    if (missingIds && [...missingIds].filter(id => avatarMap.has(id)).length >= missingIds.size) {
      console.log('  All traders found, stopping early!')
      break
    }
  }

  return avatarMap
}

async function main() {
  console.log('🖼️  Weex Avatar Fix\n')

  // Get traders with null avatar
  let allRows = []
  let start = 0
  while (true) {
    const { data, error } = await sb
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', 'weex')
      .is('avatar_url', null)
      .range(start, start + 499)
    if (error) throw new Error('DB error: ' + error.message)
    if (!data || data.length === 0) break
    allRows = allRows.concat(data)
    if (data.length < 500) break
    start += 500
  }

  console.log(`📊 Before: ${allRows.length} traders need avatars`)
  if (allRows.length === 0) { console.log('✅ Nothing to do!'); return }

  const missingIds = new Set(allRows.map(r => r.source_trader_id))
  const avatarMap = await captureAndFetchAll(missingIds)

  const matched = allRows.filter(r => avatarMap.has(r.source_trader_id)).length
  console.log(`\n  Total avatars collected: ${avatarMap.size}`)
  console.log(`  Matched: ${matched}/${allRows.length}`)

  // Update DB
  console.log('\n💾 Updating trader_sources...')
  let updated = 0, skipped = 0

  for (const row of allRows) {
    const avatar = avatarMap.get(row.source_trader_id)
    if (!avatar) { skipped++; continue }

    const { error } = await sb
      .from('trader_sources')
      .update({ avatar_url: avatar })
      .eq('id', row.id)
      .is('avatar_url', null)

    if (error) {
      console.warn(`  ❌ id=${row.id}: ${error.message}`)
    } else {
      updated++
    }
  }

  const { count: nullCount } = await sb
    .from('trader_sources')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'weex')
    .is('avatar_url', null)

  console.log(`\n✅ Updated: ${updated} | Skipped: ${skipped}`)
  console.log(`📊 After: weex null_avatar=${nullCount}`)
}

main().catch(e => { console.error(e); process.exit(1) })
