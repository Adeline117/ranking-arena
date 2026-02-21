#!/usr/bin/env node
/**
 * BingX MDD Enrichment v10
 *
 * Discovery: The working URL is https://bingx.com/en/CopyTrading/{uid}
 * This triggers the browser to call:
 *   /api/copy-trade-facade/v4/trader/account/futures/stat?uid={uid}&apiIdentity=...
 * which returns maxDrawDown as a percentage string (e.g., "5.23%").
 *
 * For bingx: use source_trader_id as the UID (long number)
 * For bingx_spot: try search endpoint (slug-based IDs)
 *
 * Strategy:
 * 1. Load leaderboard page to establish session
 * 2. Batch 3 tabs: navigate each null-MDD trader to their detail page
 * 3. Intercept /v4/trader/account/futures/stat response
 * 4. Parse maxDrawDown string → number
 * 5. Update leaderboard_ranks
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const DRY_RUN = process.argv.includes('--dry-run')
const CONCURRENCY = 3
const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseMddString(s) {
  if (s == null) return null
  const str = String(s).replace('%', '').replace('-', '').trim()
  if (!str || str === '--') return null
  const f = parseFloat(str)
  if (isNaN(f)) return null
  // Values should be 0-100 range (already percentage)
  return Math.round(Math.abs(f) * 100) / 100
}

function parseWrString(s) {
  if (s == null) return null
  const str = String(s).replace('%', '').replace('+', '').trim()
  if (!str || str === '--') return null
  const f = parseFloat(str)
  if (isNaN(f)) return null
  return Math.round(f * 100) / 100
}

// ─── Step 1: Get null MDD rows from DB ───────────────────────────────────────
console.log('=== BingX MDD Enrichment v10 ===')
if (DRY_RUN) console.log('[DRY RUN]')

const { data: bingxNullRows } = await sb.from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bingx')
  .is('max_drawdown', null)

const { data: spotNullRows } = await sb.from('leaderboard_ranks')
  .select('id, source_trader_id, handle, win_rate, max_drawdown')
  .eq('source', 'bingx_spot')
  .is('max_drawdown', null)

console.log(`\nbingx null MDD: ${bingxNullRows?.length}`)
console.log(`bingx_spot null MDD: ${spotNullRows?.length}`)

// ─── Step 2: Launch browser ───────────────────────────────────────────────────
console.log('\nLaunching Playwright browser...')
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
})
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US'
})
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  window.chrome = { runtime: {} }
})

// Step 3: Initialize session via leaderboard page
console.log('Initializing session via leaderboard...')
const initPage = await ctx.newPage()
await initPage.goto('https://bingx.com/en/CopyTrading/leaderBoard', {
  waitUntil: 'domcontentloaded', timeout: 30000
}).catch(e => console.log('  Init nav note:', e.message))
await sleep(4000)
await initPage.close()
console.log('Session initialized.')

// ─── Step 4: Process bingx futures traders ────────────────────────────────────
async function processBingxFuturesTrader(row) {
  const uid = row.source_trader_id
  const url = `https://bingx.com/en/CopyTrading/${uid}`
  
  const page = await ctx.newPage()
  const client = await ctx.newCDPSession(page)
  await client.send('Network.enable')
  
  let statData = null
  
  client.on('Network.responseReceived', async ({ requestId, response }) => {
    if (!response.url.includes('futures/stat')) return
    try {
      const body = await client.send('Network.getResponseBody', { requestId })
      statData = JSON.parse(body.body)?.data
    } catch {}
  })
  
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })
    await sleep(4000)
  } catch (e) {
    // timeout OK, data may already be captured
  }
  
  await page.close()
  
  if (!statData) {
    console.log(`  ✗ uid=${uid}: no stat API response (trader may be inactive)`)
    return { updated: false, reason: 'no_api_response' }
  }
  
  const mdd = parseMddString(statData.maxDrawDown)
  // Also try to get win rate from stat data (strWinRate or similar)
  const wr = parseWrString(statData.winRate || statData.strWinRate)
  
  console.log(`  uid=${uid}: maxDrawDown="${statData.maxDrawDown}" → mdd=${mdd}% wr=${wr}`)
  
  if (mdd === null) {
    console.log(`    Could not parse MDD from: ${JSON.stringify(statData).slice(0, 200)}`)
    return { updated: false, reason: 'parse_failed' }
  }
  
  if (DRY_RUN) {
    console.log(`    [DRY] Would update id=${row.id} max_drawdown=${mdd}`)
    return { updated: true, mdd }
  }
  
  const updates = { max_drawdown: mdd }
  if (row.win_rate === null && wr !== null) updates.win_rate = wr
  
  const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
  if (error) {
    console.log(`    DB error: ${error.message}`)
    return { updated: false, reason: 'db_error' }
  }
  return { updated: true, mdd }
}

// ─── Step 5: Also process via main recommend page for MORE traders ─────────────
// Intercept recommend API on main CopyTrading page to get additional traders
// with full stats
async function captureFromRecommendPage() {
  console.log('\nCapturing traders from recommend API (main CopyTrading page)...')
  const page = await ctx.newPage()
  const client = await ctx.newCDPSession(page)
  await client.send('Network.enable')
  
  const capturedTraders = new Map() // uid → { mdd, wr }
  
  client.on('Network.responseReceived', async ({ requestId, response }) => {
    if (!response.url.includes('recommend') && !response.url.includes('futures/stat')) return
    try {
      const body = await client.send('Network.getResponseBody', { requestId })
      const json = JSON.parse(body.body)
      
      if (response.url.includes('recommend') && json.data?.result) {
        for (const item of json.data.result) {
          const uid = String(item.trader?.uid || '')
          const mddRaw = item.rankStat?.maxDrawDown ?? item.rankStat?.maximumDrawDown
          const wrRaw = item.rankStat?.winRate
          if (uid) {
            capturedTraders.set(uid, {
              mdd: mddRaw != null ? parseMddString(String(mddRaw)) : null,
              wr: wrRaw != null ? parseWrString(String(wrRaw)) : null
            })
          }
        }
        console.log(`  Recommend: +${json.data.result.length} traders (total: ${capturedTraders.size})`)
      }
    } catch {}
  })
  
  await page.goto('https://bingx.com/en/CopyTrading/', {
    waitUntil: 'networkidle', timeout: 30000
  }).catch(() => {})
  await sleep(5000)
  
  // Try scrolling to trigger more API calls
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await sleep(3000)
  
  await page.close()
  return capturedTraders
}

// Run recommend page capture first
const recommendTraders = await captureFromRecommendPage()
console.log(`Recommend API: ${recommendTraders.size} traders with data`)

// ─── Step 6: Process bingx futures in batches ────────────────────────────────
let bingxUpdated = 0
let bingxSkipped = 0
let bingxFromRecommend = 0

const bingxToProcess = []
for (const row of (bingxNullRows || [])) {
  // Check if we already have data from recommend API
  const uid = row.source_trader_id
  const data = recommendTraders.get(uid)
  if (data && data.mdd !== null) {
    // Update from recommend cache
    if (DRY_RUN) {
      console.log(`[DRY] recommend cache: uid=${uid} mdd=${data.mdd}`)
      bingxFromRecommend++
    } else {
      const updates = { max_drawdown: data.mdd }
      if (row.win_rate === null && data.wr !== null) updates.win_rate = data.wr
      const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) { bingxFromRecommend++; console.log(`  ✓ recommend: uid=${uid} mdd=${data.mdd}`) }
    }
  } else {
    bingxToProcess.push(row)
  }
}

console.log(`\nFrom recommend cache: ${bingxFromRecommend}/${bingxNullRows?.length}`)
console.log(`Remaining to process via detail pages: ${bingxToProcess.length}`)

// Process in batches of 3
for (let i = 0; i < bingxToProcess.length; i += CONCURRENCY) {
  const batch = bingxToProcess.slice(i, i + CONCURRENCY)
  console.log(`\nBatch ${Math.floor(i/CONCURRENCY)+1}/${Math.ceil(bingxToProcess.length/CONCURRENCY)}: processing ${batch.length} traders`)
  
  const results = await Promise.all(batch.map(row => processBingxFuturesTrader(row)))
  
  for (const result of results) {
    if (result.updated) bingxUpdated++
    else bingxSkipped++
  }
  
  if (i + CONCURRENCY < bingxToProcess.length) await sleep(1000)
}

console.log(`\n=== bingx futures: updated=${bingxUpdated + bingxFromRecommend}/${bingxNullRows?.length} (${bingxFromRecommend} from recommend, ${bingxUpdated} from detail pages, ${bingxSkipped} skipped) ===`)

// ─── Step 7: bingx_spot traders ──────────────────────────────────────────────
// bingx_spot source_trader_id is a handle/slug (not numeric UID)
// The spot copy trading page uses different APIs
async function processSpotTrader(row) {
  const handle = row.handle || row.source_trader_id
  
  // Try navigating to the spot copy trading page for this trader
  // Spot detail URL pattern (to find): might use handle or UID
  // First check the search API
  const page = await ctx.newPage()
  const client = await ctx.newCDPSession(page)
  await client.send('Network.enable')
  
  let statData = null
  
  client.on('Network.responseReceived', async ({ requestId, response }) => {
    const url = response.url
    if (!url.includes('spot') && !url.includes('trader')) return
    if (!url.includes('stat') && !url.includes('rank') && !url.includes('search')) return
    try {
      const body = await client.send('Network.getResponseBody', { requestId })
      const json = JSON.parse(body.body)
      const str = JSON.stringify(json)
      if (str.includes('maxDrawdown') || str.includes('winRate')) {
        statData = json.data
        console.log(`  [spot API] ${url}: ${str.slice(0, 200)}`)
      }
    } catch {}
  })
  
  // Navigate to spot copy trading page with handle
  const urls = [
    `https://bingx.com/en/CopyTrading?type=spot&trader=${handle}`,
    `https://bingx.com/en/CopyTrading/spot/${handle}`,
  ]
  
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
      await sleep(3000)
      if (statData) break
    } catch {}
  }
  
  await page.close()
  
  if (!statData) {
    console.log(`  ✗ spot handle=${handle}: no data`)
    return { updated: false }
  }
  
  const mdd = parseMddString(statData.maxDrawdown || statData.maxDrawDown)
  const wr = parseWrString(statData.winRate)
  
  console.log(`  spot handle=${handle}: mdd=${mdd} wr=${wr}`)
  if (mdd === null) return { updated: false }
  
  if (DRY_RUN) { console.log(`    [DRY] id=${row.id} mdd=${mdd}`); return { updated: true } }
  
  const updates = { max_drawdown: mdd }
  if (row.win_rate === null && wr !== null) updates.win_rate = wr
  
  const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
  return { updated: !error }
}

// Also try the spot search API via the spot leaderboard page
async function captureFromSpotPage() {
  console.log('\nCapturing spot traders from bingx spot copy trading page...')
  const page = await ctx.newPage()
  const client = await ctx.newCDPSession(page)
  await client.send('Network.enable')
  
  const spotTraders = new Map() // slug → { mdd, wr }
  
  function toSlug(name) {
    return String(name || '').toLowerCase().trim()
      .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
  }
  
  client.on('Network.responseReceived', async ({ requestId, response }) => {
    if (!response.url.includes('spot')) return
    try {
      const body = await client.send('Network.getResponseBody', { requestId })
      const json = JSON.parse(body.body)
      const str = JSON.stringify(json)
      if (str.includes('maxDrawdown') || str.includes('winRate')) {
        const items = json.data?.result || json.data?.list || (Array.isArray(json.data) ? json.data : [])
        for (const item of items) {
          const traderInfo = item.trader || {}
          const rankStat = item.rankStat || {}
          const nick = traderInfo.nickName || traderInfo.traderName || ''
          const slug = toSlug(nick)
          const mdd = parseMddString(String(rankStat.maxDrawdown || rankStat.maxDrawDown || ''))
          const wr = parseWrString(String(rankStat.winRate || ''))
          if (slug && (mdd !== null || wr !== null)) {
            spotTraders.set(slug, { mdd, wr, nick })
          }
        }
        if (items.length > 0) console.log(`  Spot API: +${items.length} traders, total: ${spotTraders.size}`)
      }
    } catch {}
  })
  
  // Navigate to spot copy trading
  await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle', timeout: 30000
  }).catch(() => {})
  await sleep(5000)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await sleep(3000)
  
  await page.close()
  return spotTraders
}

const spotPageTraders = await captureFromSpotPage()
console.log(`Spot page: ${spotPageTraders.size} traders with data`)

let spotUpdated = 0
let spotSkipped = 0

function toSlug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
}

// Match spot traders by slug
const spotToProcess = []
for (const row of (spotNullRows || [])) {
  const slug = row.source_trader_id
  const handleSlug = toSlug(row.handle || '')
  const data = spotPageTraders.get(slug) || spotPageTraders.get(handleSlug)
  
  if (data && data.mdd !== null) {
    if (DRY_RUN) {
      console.log(`[DRY] spot: slug=${slug} mdd=${data.mdd}`)
      spotUpdated++
    } else {
      const updates = { max_drawdown: data.mdd }
      if (row.win_rate === null && data.wr !== null) updates.win_rate = data.wr
      const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) { spotUpdated++; console.log(`  ✓ spot: slug=${slug} mdd=${data.mdd}`) }
      else { spotSkipped++; console.log(`  ✗ spot DB error: ${error.message}`) }
    }
  } else {
    spotToProcess.push(row)
  }
}

console.log(`\nSpot from page: ${spotUpdated}/${spotNullRows?.length}`)
console.log(`Spot remaining to process via detail: ${spotToProcess.length}`)

// Process remaining spot traders via detail pages (in batches of 3)
for (let i = 0; i < spotToProcess.length; i += CONCURRENCY) {
  const batch = spotToProcess.slice(i, i + CONCURRENCY)
  const results = await Promise.all(batch.map(row => processSpotTrader(row)))
  for (const result of results) {
    if (result.updated) spotUpdated++
    else spotSkipped++
  }
  if (i + CONCURRENCY < spotToProcess.length) await sleep(1000)
}

// ─── Final summary ────────────────────────────────────────────────────────────
await browser.close()

const totalBingxUpdated = bingxUpdated + bingxFromRecommend
console.log(`\n${'='.repeat(60)}`)
console.log(`✅ FINAL RESULTS:`)
console.log(`  bingx futures: ${totalBingxUpdated}/${bingxNullRows?.length} updated (${bingxSkipped} skipped/inactive)`)
console.log(`  bingx_spot:    ${spotUpdated}/${spotNullRows?.length} updated (${spotSkipped} skipped)`)

// Final DB check
const { count: bingxRemaining } = await sb.from('leaderboard_ranks')
  .select('id', { count: 'exact', head: true }).eq('source', 'bingx').is('max_drawdown', null)
const { count: spotRemaining } = await sb.from('leaderboard_ranks')
  .select('id', { count: 'exact', head: true }).eq('source', 'bingx_spot').is('max_drawdown', null)

console.log(`\nDB remaining null MDD:`)
console.log(`  bingx:      ${bingxRemaining}`)
console.log(`  bingx_spot: ${spotRemaining}`)
