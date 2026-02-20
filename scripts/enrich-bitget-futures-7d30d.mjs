#!/usr/bin/env node
/**
 * enrich-bitget-futures-7d30d.mjs
 * Enriches bitget_futures trader_snapshots with roi_7d, roi_30d.
 *
 * Strategy:
 * - Launch one Playwright browser, establish session on bitget.com/copy-trading/futures
 * - Use in-page fetch() via page.evaluate() to call internal cycleData API (cycleTime 7 / 30)
 *   which bypasses CORS / auth issues by using browser cookies
 * - Process with CONCURRENCY parallel pages
 * - Only targets trader_snapshots WHERE source='bitget_futures' AND roi_7d IS NULL
 * - Updates roi_7d and roi_30d in-place
 * - Logs every 50, verifies DB at the end
 *
 * Usage: node scripts/enrich-bitget-futures-7d30d.mjs [--limit=200] [--dry-run]
 */

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const args = process.argv.slice(2)
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '2000')
const DRY_RUN = args.includes('--dry-run')
const CONCURRENCY = 5
const DELAY_MS = 600          // delay between traders per worker
const GAP_MS = 300            // gap between 7d and 30d calls for same trader
const REFRESH_EVERY = 80      // re-navigate every N API calls per page

const sleep = ms => new Promise(r => setTimeout(r, ms))
const parseNum = v => { if (v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n }

// ─── API call via in-page fetch ───────────────────────────────────────────────
async function fetchCycleData(page, traderId, cycleTime, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let result
    try {
      result = await page.evaluate(async ({ traderId, cycleTime }) => {
        try {
          const r = await fetch('/v1/trigger/trace/public/cycleData', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ languageType: 0, triggerUserId: traderId, cycleTime }),
          })
          const text = await r.text()
          if (text.startsWith('<')) return { htmlError: true, status: r.status }
          return { status: r.status, ok: r.ok, data: JSON.parse(text) }
        } catch (e) {
          return { error: e.toString() }
        }
      }, { traderId, cycleTime })
    } catch (e) {
      return { error: `page.evaluate failed: ${e.message}` }
    }

    if (result.error) return { error: result.error }
    if (result.htmlError) return { error: `HTML response (status ${result.status})` }
    if (result.status === 429) {
      console.log(`    ⏳ 429 rate limit, waiting ${(attempt + 1) * 5}s...`)
      await sleep((attempt + 1) * 5000)
      continue
    }
    if (!result.ok) return { error: `HTTP ${result.status}` }
    return result.data
  }
  return { error: '429 max retries exhausted' }
}

// ─── Extract ROI from cycleData response ────────────────────────────────────
function extractRoi(apiResp) {
  if (!apiResp || apiResp.error) return null
  if (apiResp.code !== '00000') return null
  const stats = apiResp.data?.statisticsDTO
  if (!stats) return null
  const v = parseNum(stats.profitRate)
  if (v == null) return null
  // profitRate appears to be in decimal (e.g. 0.15 = 15%) — normalise to percent
  // The existing enrich-bitget-pnl-roi.mjs stores it raw from the API.
  // Inspect: if abs(v) < 10 and it looks like a ratio, multiply by 100
  // But to be safe, store as-is (same convention as existing roi column)
  return parseFloat(v.toFixed(6))
}

// ─── Worker: processes a slice of traders ───────────────────────────────────
async function worker(page, traders, workerId, counters) {
  let apiCalls = 0

  for (let i = 0; i < traders.length; i++) {
    const { source_trader_id: tid } = traders[i]

    process.stdout.write(`  [W${workerId}|${i + 1}/${traders.length}] ${tid.slice(0, 12)}... `)

    // Refresh session every REFRESH_EVERY API calls
    if (apiCalls > 0 && apiCalls % REFRESH_EVERY === 0) {
      process.stdout.write(`\n  [W${workerId}] 🔄 refreshing session...\n`)
      await page.goto('https://www.bitget.com/copy-trading/futures', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      }).catch(() => {})
      await sleep(2000)
    }

    // Fetch 7D
    const resp7 = await fetchCycleData(page, tid, 7)
    apiCalls++
    const roi7 = extractRoi(resp7)
    await sleep(GAP_MS)

    // Fetch 30D
    const resp30 = await fetchCycleData(page, tid, 30)
    apiCalls++
    const roi30 = extractRoi(resp30)

    process.stdout.write(`7d=${roi7 ?? 'null'} 30d=${roi30 ?? 'null'}`)

    if (roi7 == null && roi30 == null) {
      const reason = resp7?.error || `code=${resp7?.code}`
      process.stdout.write(` ⚠️  no data (${reason})\n`)
      counters.noData++
    } else {
      if (!DRY_RUN) {
        const updates = {}
        if (roi7 != null) updates.roi_7d = roi7
        if (roi30 != null) updates.roi_30d = roi30

        const { error: upErr } = await sb
          .from('trader_snapshots')
          .update(updates)
          .eq('source', 'bitget_futures')
          .eq('source_trader_id', tid)

        if (upErr) {
          process.stdout.write(` ❌ DB: ${upErr.message}\n`)
          counters.errors++
        } else {
          process.stdout.write(` ✅\n`)
          counters.updated++
        }
      } else {
        process.stdout.write(` [DRY-RUN]\n`)
        counters.updated++
      }
    }

    // Progress checkpoint every 50
    if ((counters.updated + counters.noData + counters.errors) % 50 === 0 &&
        (counters.updated + counters.noData + counters.errors) > 0) {
      console.log(`\n  📊 Checkpoint: updated=${counters.updated} noData=${counters.noData} errors=${counters.errors}\n`)
    }

    await sleep(DELAY_MS + Math.random() * 200)
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🔄 Bitget Futures roi_7d/roi_30d Enrichment`)
  console.log(`   Source: bitget_futures | Limit: ${LIMIT} | Concurrency: ${CONCURRENCY} | DRY_RUN: ${DRY_RUN}`)
  console.log('')

  // 1. Count nulls
  const { count: nullCount, error: countErr } = await sb
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bitget_futures')
    .is('roi_7d', null)

  if (countErr) { console.error('Count error:', countErr.message); process.exit(1) }
  console.log(`📊 trader_snapshots WHERE source='bitget_futures' AND roi_7d IS NULL: ${nullCount}`)

  if (nullCount === 0) {
    console.log('✅ Nothing to enrich — all roi_7d are filled')
    process.exit(0)
  }

  // 2. Fetch traders needing enrichment
  const { data: allTraders, error: fetchErr } = await sb
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'bitget_futures')
    .is('roi_7d', null)
    .order('arena_score', { ascending: false })
    .limit(LIMIT)

  if (fetchErr) { console.error('Fetch error:', fetchErr.message); process.exit(1) }

  // Dedupe and filter valid hex IDs
  const seen = new Set()
  const traders = allTraders.filter(t => {
    if (seen.has(t.source_trader_id)) return false
    seen.add(t.source_trader_id)
    return /^[a-f0-9]{10,}$/i.test(t.source_trader_id)
  })

  console.log(`Found ${traders.length} unique valid-hex traders with null roi_7d (of ${allTraders.length} fetched)`)
  console.log('')

  if (traders.length === 0) {
    console.log('⚠️  No valid hex-ID traders to process')
    process.exit(0)
  }

  // 3. Launch browser
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })

  // 4. Warm up pages with session cookies
  console.log(`🌐 Establishing ${CONCURRENCY} Bitget sessions...`)
  const pages = []
  for (let i = 0; i < CONCURRENCY; i++) {
    const p = await ctx.newPage()
    await p.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css}', r => r.abort())
    pages.push(p)
  }

  // Navigate first page, then reuse context cookies for rest
  await pages[0].goto('https://www.bitget.com/copy-trading/futures', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  }).catch(e => console.warn('Warm-up nav warn:', e.message))
  await sleep(3000)

  // Navigate remaining pages in parallel
  await Promise.all(pages.slice(1).map(p =>
    p.goto('https://www.bitget.com/copy-trading/futures', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(() => {})
  ))
  await sleep(1500)
  console.log('✅ All sessions ready\n')

  // 5. Split work across workers
  const chunkSize = Math.ceil(traders.length / CONCURRENCY)
  const chunks = []
  for (let i = 0; i < CONCURRENCY; i++) {
    const slice = traders.slice(i * chunkSize, (i + 1) * chunkSize)
    if (slice.length) chunks.push(slice)
  }
  console.log(`Splitting ${traders.length} traders across ${chunks.length} workers (chunk ~${chunkSize})`)
  console.log('')

  const counters = { updated: 0, noData: 0, errors: 0 }

  const start = Date.now()
  await Promise.all(chunks.map((chunk, idx) => worker(pages[idx], chunk, idx + 1, counters)))
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  await browser.close()

  // 6. Summary
  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Done in ${elapsed}s`)
  console.log(`   Updated: ${counters.updated}`)
  console.log(`   No data: ${counters.noData}`)
  console.log(`   Errors:  ${counters.errors}`)

  // 7. Verify DB
  const { count: remaining } = await sb
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bitget_futures')
    .is('roi_7d', null)

  const { count: filled7 } = await sb
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bitget_futures')
    .not('roi_7d', 'is', null)

  const { count: filled30 } = await sb
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bitget_futures')
    .not('roi_30d', 'is', null)

  console.log(`\n📊 DB Verification (bitget_futures trader_snapshots):`)
  console.log(`   roi_7d  NULL before: ${nullCount}  →  after: ${remaining}`)
  console.log(`   roi_7d  filled: ${filled7}`)
  console.log(`   roi_30d filled: ${filled30}`)
  console.log('')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
