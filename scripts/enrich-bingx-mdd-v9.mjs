#!/usr/bin/env node
/**
 * BingX MDD v9 — Playwright intercept session headers, then pure HTTP
 * 
 * Strategy:
 * 1. Launch browser, load bingx.com CopyTrading page once
 * 2. Intercept first successful api-app.qq-os.com response → capture headers
 * 3. Close browser immediately
 * 4. Use captured headers to call multi-rank + recommend APIs via node fetch
 * 5. Paginate through all traders, extract maxDrawDown from rankStat
 * 6. Match to DB by uid/shortUid and update leaderboard_ranks
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')

// ─── Step 1: Get DB rows needing enrichment ──────────────────────────────────
const { data: futuresRows } = await sb.from('leaderboard_ranks')
  .select('id,source_trader_id,win_rate,max_drawdown')
  .eq('source', 'bingx').is('max_drawdown', null)

const { data: spotRows } = await sb.from('leaderboard_ranks')
  .select('id,source_trader_id,win_rate,max_drawdown')
  .eq('source', 'bingx_spot').is('max_drawdown', null)

console.log(`Futures MDD null: ${futuresRows?.length}, Spot MDD null: ${spotRows?.length}`)

// Build lookup maps
const futuresMap = new Map(futuresRows?.map(r => [String(r.source_trader_id), r]) || [])
const spotMap = new Map(spotRows?.map(r => [String(r.source_trader_id), r]) || [])

// ─── Step 2: Playwright — capture session headers ────────────────────────────
console.log('\nLaunching browser to capture session headers...')
let capturedHeaders = null
let capturedCookies = null

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
})
const page = await ctx.newPage()

// Intercept request to get exact headers browser sends
page.on('request', req => {
  if (req.url().includes('qq-os.com') && !capturedHeaders) {
    capturedHeaders = req.headers()
    console.log('  Captured request headers from:', req.url().slice(0, 80))
  }
})

const traderDataMap = new Map() // uid → { maxDrawDown, winRate, nickName }

page.on('response', async res => {
  const url = res.url()
  if (!url.includes('qq-os.com')) return
  try {
    const json = await res.json()
    const results = json?.data?.result || json?.data?.list || (Array.isArray(json?.data) ? json.data : [])
    for (const item of results) {
      const rankStat = item?.rankStat || item
      const trader = item?.trader || item
      const uid = String(trader?.uid || rankStat?.uid || '')
      const shortUid = String(trader?.shortUid || rankStat?.shortUid || '')
      const nickName = trader?.nickName || ''
      const mdd = rankStat?.maxDrawDown ?? rankStat?.maximumDrawDown ?? null
      const wr = rankStat?.winRate ?? null
      if (uid || shortUid) {
        const entry = { mdd, wr, nickName }
        if (uid) traderDataMap.set(uid, entry)
        if (shortUid && shortUid !== uid) traderDataMap.set(shortUid, entry)
      }
    }
    if (results.length > 0) console.log(`  Captured ${results.length} traders from ${url.slice(0, 80)}`)
  } catch {}
})

try {
  await page.goto('https://bingx.com/en/CopyTrading/', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(6000)
} catch (e) { console.log('Page load note:', e.message) }

// Get cookies
capturedCookies = await ctx.cookies()
await browser.close()
console.log(`Browser closed. Captured ${traderDataMap.size} traders so far.`)
console.log(`Cookies: ${capturedCookies.map(c => c.name).join(', ')}`)

// ─── Step 3: Direct HTTP calls with captured headers + cookies ───────────────
if (capturedHeaders || capturedCookies.length > 0) {
  const cookieStr = capturedCookies.map(c => `${c.name}=${c.value}`).join('; ')
  const headers = {
    ...capturedHeaders,
    'Cookie': cookieStr,
    'Accept': 'application/json',
    'Referer': 'https://bingx.com/en/CopyTrading/',
  }

  // Try recommend endpoint with pagination
  console.log('\nFetching all traders via recommend API...')
  for (let pageId = 0; pageId < 20; pageId++) {
    try {
      const url = `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=${pageId}&pageSize=20`
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
      const json = await r.json()
      if (json.code !== 0) { console.log(`  Page ${pageId}: code=${json.code} ${json.msg} → stop`); break }
      const results = json?.data?.result || []
      if (results.length === 0) { console.log(`  Page ${pageId}: empty → stop`); break }
      for (const item of results) {
        const rankStat = item?.rankStat || {}
        const trader = item?.trader || {}
        const uid = String(trader?.uid || '')
        const shortUid = String(trader?.shortUid || '')
        const entry = { mdd: rankStat?.maxDrawDown ?? rankStat?.maximumDrawDown ?? null, wr: rankStat?.winRate ?? null, nickName: trader?.nickName || '' }
        if (uid) traderDataMap.set(uid, entry)
        if (shortUid) traderDataMap.set(shortUid, entry)
      }
      console.log(`  Recommend page ${pageId}: +${results.length} traders (total: ${traderDataMap.size})`)
      await sleep(300)
    } catch (e) { console.log(`  Page ${pageId} error:`, e.message); break }
  }

  // Try multi-rank endpoint
  console.log('\nFetching via multi-rank API...')
  for (let page = 0; page < 10; page++) {
    try {
      const url = `https://api-app.qq-os.com/api/copy-trade-facade/v1/rank/multi-rank?pageSize=20&page=${page}`
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
      const json = await r.json()
      if (json.code !== 0) { console.log(`  Rank page ${page}: code=${json.code} → stop`); break }
      const list = json?.data?.list || json?.data?.result || (Array.isArray(json?.data) ? json.data : [])
      if (list.length === 0) { console.log(`  Rank page ${page}: empty → stop`); break }
      for (const item of list) {
        const rankStat = item?.rankStat || item
        const trader = item?.trader || item
        const uid = String(trader?.uid || rankStat?.uid || '')
        const shortUid = String(trader?.shortUid || rankStat?.shortUid || '')
        const entry = { mdd: rankStat?.maxDrawDown ?? rankStat?.maximumDrawDown ?? null, wr: rankStat?.winRate ?? null, nickName: trader?.nickName || '' }
        if (uid) traderDataMap.set(uid, entry)
        if (shortUid) traderDataMap.set(shortUid, entry)
      }
      console.log(`  Rank page ${page}: +${list.length} (total: ${traderDataMap.size})`)
      await sleep(300)
    } catch (e) { console.log(`  Rank page ${page} error:`, e.message); break }
  }
}

console.log(`\nTotal traders from API: ${traderDataMap.size}`)
console.log('Sample DB IDs (futures):', [...futuresMap.keys()].slice(0, 3))
console.log('Sample API UIDs:', [...traderDataMap.keys()].slice(0, 3))

// ─── Step 4: Match and update ────────────────────────────────────────────────
let futuresUpdated = 0, spotUpdated = 0

for (const [dbId, dbRow] of futuresMap) {
  const match = traderDataMap.get(dbId)
  if (!match || match.mdd == null) continue
  if (DRY_RUN) { console.log(`[DRY] bingx ${dbId} MDD=${match.mdd}`); futuresUpdated++; continue }
  const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: match.mdd }).eq('id', dbRow.id)
  if (!error) futuresUpdated++
}

for (const [dbId, dbRow] of spotMap) {
  const match = traderDataMap.get(dbId)
  if (!match || match.mdd == null) continue
  if (DRY_RUN) { console.log(`[DRY] bingx_spot ${dbId} MDD=${match.mdd}`); spotUpdated++; continue }
  const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: match.mdd }).eq('id', dbRow.id)
  if (!error) spotUpdated++
}

console.log(`\n✅ Updated: futures=${futuresUpdated}/${futuresRows?.length}, spot=${spotUpdated}/${spotRows?.length}`)
console.log(`Unmatched DB IDs sample (futures):`, [...futuresMap.keys()].filter(id => !traderDataMap.has(id)).slice(0, 5))
