#!/usr/bin/env node
/**
 * fix-avatars-bingx-spot.mjs
 * Fetch and store real avatar URLs for bingx_spot traders.
 * 
 * Uses Playwright to intercept the BingX spot copy trading API:
 *   POST https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search
 *   Returns: [{ trader: { nickName, uid }, rankStat: {...} }]
 * 
 * source_trader_id in DB = slug of nickName (lowercase, non-alphanum → _)
 * Avatar field = trader.headUrl || trader.avatar || trader.avatarUrl
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

const sleep = ms => new Promise(r => setTimeout(r, ms))

function toSlug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
}

function isRealAvatar(url) {
  if (!url || typeof url !== 'string' || url.length < 10) return false
  if (!url.startsWith('http')) return false
  const lower = url.toLowerCase()
  const fakes = ['placeholder', 'boringavatars', 'dicebear', 'identicon', 'favicon']
  return !fakes.some(f => lower.includes(f))
}

async function main() {
  console.log('🖼️  BingX Spot Avatar Fix\n')

  // Fetch traders with null avatar
  let allRows = []
  let start = 0
  while (true) {
    const { data, error } = await sb
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', 'bingx_spot')
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

  // Build lookup maps
  const slugToRow = new Map() // slug -> row
  const uidToRow = new Map()  // uid -> row
  for (const row of allRows) {
    slugToRow.set(row.source_trader_id, row)
    const handleSlug = toSlug(row.handle || '')
    if (handleSlug && handleSlug !== row.source_trader_id) {
      slugToRow.set(handleSlug, row)
    }
  }

  const avatarMap = new Map() // source_trader_id -> avatarUrl

  console.log('\n🎭 Launching Playwright...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  })
  const page = await context.newPage()

  let postHeaders = null
  let postUrlBase = null
  let apiTotal = 0

  // CDP to capture POST request headers
  const client = await context.newCDPSession(page)
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', ({ request }) => {
    if (request.url.includes('spot/trader/search') && request.method === 'POST') {
      postHeaders = { ...request.headers }
      postUrlBase = request.url.split('?')[0]
      console.log('  ✓ Captured signed POST headers')
    }
  })

  // Process API items
  function processItem(item) {
    const traderInfo = item.trader || item.traderInfo || {}
    const rankStat = item.rankStat || {}
    
    const nickName = traderInfo.nickName || traderInfo.traderName || traderInfo.nickname || ''
    const uid = String(traderInfo.uid || traderInfo.uniqueId || traderInfo.traderId || '')
    const avatar = traderInfo.headUrl || traderInfo.avatar || traderInfo.avatarUrl ||
                   item.headUrl || item.avatar
    
    if (!isRealAvatar(avatar)) return
    
    const slug = toSlug(nickName)
    
    // Match to DB rows
    if (slugToRow.has(slug)) {
      const row = slugToRow.get(slug)
      avatarMap.set(row.source_trader_id, avatar)
    }
    if (uid && uidToRow.has(uid)) {
      const row = uidToRow.get(uid)
      avatarMap.set(row.source_trader_id, avatar)
    }
    // Also try exact source_trader_id match (in case some have uid-based IDs)
    if (uid && slugToRow.has(uid)) {
      const row = slugToRow.get(uid)
      avatarMap.set(row.source_trader_id, avatar)
    }
  }

  // Intercept API responses
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('spot/trader/search') && !url.includes('copy') && !url.includes('trader')) return
    if (response.status() >= 400) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      
      // Try different response structures
      const result = json?.data?.result || json?.data?.list || json?.data?.rows ||
                     (Array.isArray(json?.data) ? json.data : null) || []
      
      if (result.length > 0) {
        apiTotal = json?.data?.total || json?.data?.totalNum || apiTotal
        for (const item of result) processItem(item)
        console.log(`  Intercepted ${result.length} traders, ${avatarMap.size} matched from ${allRows.length}`)
      }
    } catch {}
  })

  console.log('  Loading BingX spot copy trading page...')
  await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle',
    timeout: 90000,
  }).catch(() => console.log('  ⚠ Load timeout, continuing...'))
  await sleep(5000)

  // Dismiss popups
  for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Accept All', 'Confirm']) {
    try {
      const btn = page.locator(`button:has-text("${text}"), [role="button"]:has-text("${text}")`).first()
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click().catch(() => {})
        await sleep(200)
      }
    } catch {}
  }

  console.log(`  After page load: ${avatarMap.size} matched`)

  // Paginate using captured headers
  if (postHeaders && postUrlBase && apiTotal > 0) {
    const totalPages = Math.ceil(apiTotal / 12)
    console.log(`  Fetching pages 1-${totalPages} via captured headers (${apiTotal} total)...`)
    
    for (let pageId = 1; pageId < Math.min(totalPages, 200); pageId++) {
      const url = `${postUrlBase}?pageId=${pageId}&pageSize=12`
      const prevSize = avatarMap.size
      
      try {
        await page.evaluate(async ({ url, headers }) => {
          try {
            await fetch(url, { method: 'POST', headers, body: '{}' })
          } catch {}
        }, { url, headers: postHeaders })
        await sleep(600)
        
        if (avatarMap.size === prevSize && pageId > 5) {
          // No new avatars found for a few pages
        }
      } catch (e) {
        console.log(`  pageId=${pageId} error: ${e.message.slice(0, 50)}`)
      }
      
      if ((pageId + 1) % 10 === 0) {
        console.log(`  Page ${pageId+1}/${totalPages}: ${avatarMap.size} matched`)
      }
      
      if (avatarMap.size >= allRows.length) {
        console.log('  All traders found! Stopping.')
        break
      }
    }
  }

  await browser.close()
  console.log(`\n  Total matched: ${avatarMap.size}/${allRows.length}`)

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
      .is('avatar_url', null) // safety

    if (error) {
      console.warn(`  ❌ id=${row.id}: ${error.message}`)
    } else {
      updated++
    }
  }

  const { count: nullCount } = await sb
    .from('trader_sources')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bingx_spot')
    .is('avatar_url', null)

  console.log(`\n✅ Updated: ${updated} | Skipped: ${skipped}`)
  console.log(`📊 After: bingx_spot null_avatar=${nullCount}`)
}

main().catch(e => { console.error(e); process.exit(1) })
