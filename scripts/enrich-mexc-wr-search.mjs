#!/usr/bin/env node
/**
 * enrich-mexc-wr-search.mjs
 *
 * Enriches win_rate + max_drawdown for MEXC traders with NULL values.
 * These traders exist in the DB but weren't captured by the top-1797
 * leaderboard scroll because they rank lower.
 *
 * Strategy:
 *   1. Launch browser briefly to get session cookies
 *   2. Use Node.js fetch (with cookies) to scan all ~444 pages directly
 *      — Much faster than page.evaluate (5-10 pages/second vs 5/second)
 *   3. Update DB for all matched handles
 *   4. Fallback: browser search box for any still-missing handles
 *
 * Usage:
 *   node scripts/enrich-mexc-wr-search.mjs          # full run
 *   node scripts/enrich-mexc-wr-search.mjs --test   # test first 5 traders
 *   node scripts/enrich-mexc-wr-search.mjs --limit 50
 */

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import path from 'path'

// ─── Config ───────────────────────────────────────────────────────────────────
const ROOT = new URL('..', import.meta.url).pathname
const envPath = path.join(ROOT, '.env.local')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]
    })
)

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const TEST_MODE = process.argv.includes('--test')
const LIMIT_ARG = (() => {
  const i = process.argv.indexOf('--limit')
  return i !== -1 ? parseInt(process.argv[i + 1]) : null
})()

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PAGE_SIZE = 50
const CONCURRENCY = 5   // parallel API calls at once
const DELAY_MS = 100    // delay between batches

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toPercent(v) {
  if (v == null) return null
  const f = parseFloat(v)
  if (isNaN(f)) return null
  if (Math.abs(f) <= 1.0 && f !== 0) return Math.round(f * 10000) / 100
  return Math.round(f * 100) / 100
}

function extractTraderData(item) {
  if (!item) return null
  const winRate = item.winRate ?? item.win_rate ?? item.totalWinRate ?? null
  const mdd = item.maxDrawdown7 ?? item.maxDrawdown ?? item.max_drawdown ?? null
  const trades = item.openTimes ?? item.openTime ?? item.totalOpenTime ?? item.trades_count ?? null
  return {
    win_rate: toPercent(winRate),
    max_drawdown: mdd != null ? Math.abs(toPercent(mdd)) : null,
    trades_count: trades != null ? parseInt(trades) : null,
  }
}

// ─── DB ───────────────────────────────────────────────────────────────────────
async function getNullTraders() {
  let all = []
  let offset = 0
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, handle')
      .eq('source', 'mexc')
      .is('win_rate', null)
      .range(offset, offset + 999)
    if (error) throw new Error('DB error: ' + error.message)
    if (!data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  return all
}

async function updateTrader(sourceTraderid, fields) {
  const update = {}
  if (fields.win_rate != null) update.win_rate = fields.win_rate
  if (fields.max_drawdown != null) update.max_drawdown = fields.max_drawdown
  if (fields.trades_count != null) update.trades_count = fields.trades_count
  if (!Object.keys(update).length) return 0

  const { data, error } = await sb
    .from('leaderboard_ranks')
    .update(update)
    .eq('source', 'mexc')
    .eq('source_trader_id', sourceTraderid)
    .is('win_rate', null)
    .select('id')

  if (error) {
    console.error(`  ✗ DB error for "${sourceTraderid}":`, error.message)
    return 0
  }
  return data?.length || 0
}

// ─── Cookie extraction ────────────────────────────────────────────────────────
async function getCookies() {
  console.log('🌐 Launching browser to get session cookies...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  await page.goto('https://www.mexc.com/futures/copyTrade/home', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(() => {})
  await sleep(4000)

  // Get cookies as header string
  const cookies = await context.cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  await browser.close()
  console.log(`  Got ${cookies.length} cookies`)
  return cookieStr
}

// ─── Direct HTTP page fetch ───────────────────────────────────────────────────
async function fetchPage(pageNum, cookieStr) {
  const url = `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=${PAGE_SIZE}&orderBy=COMPREHENSIVE&page=${pageNum}`
  try {
    const r = await fetch(url, {
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.mexc.com/futures/copyTrade/home',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!r.ok) return { ok: false, status: r.status }
    const d = await r.json()
    return {
      ok: true,
      content: d?.data?.content || [],
      total: d?.data?.total || 0,
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ─── Parallel paginated scan ───────────────────────────────────────────────────
async function paginatedScan(handleSet, cookieStr) {
  const found = new Map() // lowerHandle -> data

  // Get page 1 first to find total
  const first = await fetchPage(1, cookieStr)
  if (!first.ok || !first.content.length) {
    console.log('  ❌ Page 1 fetch failed or empty. Cookies may have expired.')
    return found
  }

  const totalTraders = first.total
  const totalPages = Math.ceil(totalTraders / PAGE_SIZE)
  console.log(`  Total traders: ${totalTraders} → ${totalPages} pages (${PAGE_SIZE}/page, ${CONCURRENCY} concurrent)`)

  // Check page 1 results
  for (const item of first.content) {
    const nick = (item.nickname || item.nickName || '').toLowerCase().trim()
    if (nick && handleSet.has(nick) && !found.has(nick)) {
      found.set(nick, extractTraderData(item))
    }
  }

  // Scan remaining pages with concurrency
  const startTime = Date.now()
  let nextPage = 2

  while (nextPage <= totalPages && found.size < handleSet.size) {
    // Build a batch of pages
    const batch = []
    for (let i = 0; i < CONCURRENCY && nextPage <= totalPages; i++, nextPage++) {
      batch.push(nextPage)
    }

    // Fetch batch in parallel
    const results = await Promise.all(batch.map(p => fetchPage(p, cookieStr)))

    for (let i = 0; i < results.length; i++) {
      const res = results[i]
      if (!res.ok) {
        console.log(`  Page ${batch[i]}: error ${res.status || res.error}`)
        continue
      }
      for (const item of res.content) {
        const nick = (item.nickname || item.nickName || '').toLowerCase().trim()
        if (nick && handleSet.has(nick) && !found.has(nick)) {
          const data = extractTraderData(item)
          found.set(nick, data)
        }
      }
    }

    // Progress every 50 pages
    const currentPage = batch[batch.length - 1]
    if (currentPage % 50 < CONCURRENCY || found.size >= handleSet.size) {
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      console.log(`  Page ${currentPage}/${totalPages} | Found: ${found.size}/${handleSet.size} | ${elapsed}s`)
    }

    if (found.size >= handleSet.size) {
      console.log(`  ✨ All ${handleSet.size} handles found! Stopping scan.`)
      break
    }

    await sleep(DELAY_MS)
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000)
  console.log(`  Scan complete: ${found.size} found in ${elapsed}s`)
  return found
}

// ─── Fallback: browser search box ─────────────────────────────────────────────
async function searchBoxFallback(remainingHandles, cookieStr) {
  if (!remainingHandles.length) return new Map()
  console.log(`\n🔍 Search box fallback for ${remainingHandles.length} handles...`)

  // Try direct search API variants first (no browser needed)
  const found = new Map()
  for (const handle of remainingHandles) {
    const encoded = encodeURIComponent(handle)
    const searchUrls = [
      `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=10&orderBy=COMPREHENSIVE&page=1&search=${encoded}`,
      `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=10&orderBy=COMPREHENSIVE&page=1&keyword=${encoded}`,
      `https://contract.mexc.com/api/v1/copytrading/v2/public/trader/list?pageNum=1&pageSize=10&keyword=${encoded}`,
    ]
    for (const url of searchUrls) {
      try {
        const r = await fetch(url, {
          headers: {
            'Cookie': cookieStr,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.mexc.com/futures/copyTrade/home',
          },
        })
        if (!r.ok) continue
        const d = await r.json()
        const list = d?.data?.content || d?.data?.list || d?.result?.list || d?.list || []
        if (!Array.isArray(list) || !list.length) continue
        const lh = handle.toLowerCase()
        const match = list.find(t => (t.nickname || t.nickName || '').toLowerCase() === lh)
        if (match) {
          found.set(lh, extractTraderData(match))
          console.log(`  ✅ "${handle}" via search API: WR=${found.get(lh).win_rate}%`)
          break
        }
      } catch {}
    }
    await sleep(200)
  }
  return found
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60))
  console.log('MEXC WR Search Enrichment')
  console.log('='.repeat(60))

  // 1. Fetch NULL traders from DB
  let traders = await getNullTraders()
  console.log(`\nFound ${traders.length} traders with NULL win_rate`)

  if (LIMIT_ARG) {
    traders = traders.slice(0, LIMIT_ARG)
    console.log(`(limited to ${LIMIT_ARG})`)
  } else if (TEST_MODE) {
    traders = traders.slice(0, 5)
    console.log('(TEST MODE: first 5)')
  }

  if (!traders.length) {
    console.log('Nothing to do!')
    return
  }

  // 2. Build unique handle set (lowercase → original)
  const uniqueHandles = new Map()
  for (const t of traders) {
    const lk = t.source_trader_id.toLowerCase().trim()
    if (!uniqueHandles.has(lk)) uniqueHandles.set(lk, t.source_trader_id)
  }
  const handleSet = new Set(uniqueHandles.keys())
  console.log(`Unique handles: ${handleSet.size}`)

  // 3. Get browser cookies
  const cookieStr = await getCookies()

  // 4. Paginated scan (primary)
  console.log('\n' + '─'.repeat(60))
  console.log('PRIMARY: Paginated leaderboard scan via Node.js fetch')
  console.log('─'.repeat(60))
  const foundMap = await paginatedScan(handleSet, cookieStr)

  // 5. Update DB for found traders
  let totalUpdated = 0
  const foundHandleKeys = new Set()

  for (const [lowerHandle, data] of foundMap) {
    const origHandle = uniqueHandles.get(lowerHandle)
    if (!origHandle) continue
    foundHandleKeys.add(lowerHandle)

    const n = await updateTrader(origHandle, data)
    totalUpdated += n
    if (n > 0) {
      console.log(`  ✅ "${origHandle}": WR=${data.win_rate}% MDD=${data.max_drawdown}% → ${n} rows`)
    }
  }

  // 6. Find remaining
  const remaining = [...handleSet]
    .filter(h => !foundHandleKeys.has(h))
    .map(h => uniqueHandles.get(h))
    .filter(Boolean)

  console.log(`\nAfter scan: ${foundHandleKeys.size} found, ${remaining.length} not found`)

  // 7. Try search API fallback for remaining
  if (remaining.length > 0) {
    const fallbackFound = await searchBoxFallback(remaining, cookieStr)
    for (const [lh, data] of fallbackFound) {
      const origHandle = uniqueHandles.get(lh)
      if (!origHandle) continue
      const n = await updateTrader(origHandle, data)
      totalUpdated += n
    }
    const stillMissing = remaining.filter(h => !fallbackFound.has(h.toLowerCase()))
    if (stillMissing.length) {
      console.log(`\n⚠️  Still not found (${stillMissing.length}) — likely delisted or inactive traders:`)
      stillMissing.slice(0, 20).forEach(h => console.log(`  - ${h}`))
      if (stillMissing.length > 20) console.log(`  ... and ${stillMissing.length - 20} more`)
    }
  }

  // 8. Final summary
  console.log('\n' + '='.repeat(60))
  console.log('FINAL SUMMARY')
  console.log('='.repeat(60))
  console.log(`Handles processed:  ${handleSet.size}`)
  console.log(`Found in MEXC:      ${foundHandleKeys.size}`)
  console.log(`DB rows updated:    ${totalUpdated}`)
  console.log(`Not found:          ${remaining.length}`)

  // DB verification
  const { count: remainingDb } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'mexc')
    .is('win_rate', null)

  console.log(`\n📊 DB NULL win_rate remaining: ${remainingDb}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
