#!/usr/bin/env node
/**
 * Enrich Bybit Spot trader_snapshots with 7d/30d ROI and PNL
 *
 * Strategy:
 *   1. Use Playwright page.goto to paginate bybit listing API (gets leaderUserId→leaderMark map)
 *   2. Call leader-income API directly for each trader (bypasses geo-block)
 *   3. Update roi_7d, roi_30d, pnl_7d, pnl_30d
 *
 * Key: page.evaluate fetch() fails due to CORS, use page.goto() for listing
 *
 * Usage:
 *   node scripts/enrich-bybit-spot-7d30d.mjs
 *   node scripts/enrich-bybit-spot-7d30d.mjs --dry-run
 *   node scripts/enrich-bybit-spot-7d30d.mjs --limit=50
 *   node scripts/enrich-bybit-spot-7d30d.mjs --concurrency=6
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || 0
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 5
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const INCOME_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income'
const LIST_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list'

function parseMetrics(result) {
  // Store even 0 values — 0% ROI in 7d is valid (no activity in that period)
  // Skip only if truly empty profile (no cumulative activity)
  const cumTrade = parseInt(result.cumTradeCount || '0')
  const cumYield = parseInt(result.cumYieldE8 || '0')
  if (cumTrade === 0 && cumYield === 0) return {}

  const roi7  = parseInt(result.sevenDayYieldRateE4  || '0')
  const roi30 = parseInt(result.thirtyDayYieldRateE4 || '0')
  const pnl7  = parseInt(result.sevenDayProfitE8     || '0')
  const pnl30 = parseInt(result.thirtyDayProfitE8    || '0')

  return {
    roi_7d:  parseFloat((roi7  / 100).toFixed(2)),
    roi_30d: parseFloat((roi30 / 100).toFixed(2)),
    pnl_7d:  parseFloat((pnl7  / 1e8).toFixed(4)),
    pnl_30d: parseFloat((pnl30 / 1e8).toFixed(4)),
  }
}

async function fetchLeaderIncome(leaderMark) {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(
        `${INCOME_URL}?leaderMark=${encodeURIComponent(leaderMark)}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }
      )
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      const json = await res.json()
      if (json.retCode !== 0) return null
      return json.result
    } catch { if (i < 1) await sleep(500) }
  }
  return null
}

// Navigate to API URL and extract JSON (works around CORS restrictions)
async function navFetch(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 })
    if (!resp?.ok()) return null
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
    if (!text || text.startsWith('<')) return null
    return JSON.parse(text)
  } catch { return null }
}

async function processParallel(traders, processFn, concurrency) {
  let updated = 0, skipped = 0, done = 0
  const total = traders.length

  async function worker(batch) {
    for (const item of batch) {
      const n = await processFn(item)
      if (n > 0) updated += n
      else skipped++
      done++
      if (done % 50 === 0 || done === total)
        process.stdout.write(`\r  Progress: ${done}/${total} | updated=${updated} skipped=${skipped}    `)
    }
  }

  const batchSize = Math.ceil(traders.length / concurrency)
  const batches = []
  for (let i = 0; i < concurrency; i++) {
    const batch = traders.slice(i * batchSize, (i + 1) * batchSize)
    if (batch.length) batches.push(worker(batch))
  }
  await Promise.all(batches)
  console.log()
  return updated
}

async function main() {
  console.log('═══ Bybit Spot — 7d/30d ROI+PNL enrichment ═══')
  if (DRY_RUN) console.log('[DRY RUN]')

  const { count: before } = await supabase.from('trader_snapshots')
    .select('id', { count: 'exact', head: true }).eq('source', 'bybit_spot').is('roi_7d', null)
  console.log(`BEFORE: bybit_spot roi_7d NULL = ${before}`)

  // Fetch all rows needing enrichment
  let allRows = [], offset = 0
  while (true) {
    const { data } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d, pnl_7d, pnl_30d')
      .eq('source', 'bybit_spot')
      .is('roi_7d', null)
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  console.log(`Total rows to enrich: ${allRows.length}`)

  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }
  const needUIDs = new Set(traderMap.keys())
  console.log(`Unique traders: ${needUIDs.size}`)

  // Launch Playwright
  let puppeteer, StealthPlugin
  try {
    const m1 = await import('puppeteer-extra')
    const m2 = await import('puppeteer-extra-plugin-stealth')
    puppeteer = m1.default; StealthPlugin = m2.default
    puppeteer.use(StealthPlugin())
  } catch (e) { console.error('puppeteer not available:', e.message); process.exit(1) }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)

  // Visit bybit.com to get session cookies
  console.log('\nVisiting bybit.com to establish session...')
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(4000)
    console.log('  Page ready')
  } catch (e) { console.log('  Warning:', e.message?.slice(0, 60)) }

  // Test listing API access via page.goto
  const testResult = await navFetch(page, `${LIST_URL}?pageNo=1&pageSize=3&dataDuration=DATA_DURATION_SEVEN_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI`)
  console.log('  API test:', testResult ? `retCode=${testResult.retCode} len=${testResult.result?.leaderDetails?.length}` : 'FAILED')

  if (!testResult || testResult.retCode !== 0) {
    console.log('  Listing API not accessible — cannot map UIDs to leaderMarks')
    await browser.close()
    process.exit(1)
  }

  // Build UID → leaderMark mapping by paginating listing
  const uidToMark = new Map()
  const DURATIONS = ['DATA_DURATION_NINETY_DAY', 'DATA_DURATION_THIRTY_DAY', 'DATA_DURATION_SEVEN_DAY']
  const SORT_FIELDS = ['LEADER_SORT_FIELD_SORT_ROI', 'LEADER_SORT_FIELD_SORT_AUM', 'LEADER_SORT_FIELD_SORT_CUM_PNL']

  console.log('\n📡 Collecting UID→leaderMark mappings...')
  for (const sortField of SORT_FIELDS) {
    if (uidToMark.size >= needUIDs.size) break
    for (const duration of DURATIONS) {
      if (uidToMark.size >= needUIDs.size) break
      console.log(`  ${sortField} / ${duration}`)
      for (let pageNo = 1; pageNo <= 60; pageNo++) {
        const result = await navFetch(page,
          `${LIST_URL}?pageNo=${pageNo}&pageSize=50&dataDuration=${duration}&sortField=${sortField}`
        )
        if (!result || result.retCode !== 0) { console.log(`    Page ${pageNo}: error`); break }
        const items = result.result?.leaderDetails || []
        if (!items.length) break

        for (const item of items) {
          const uid = String(item.leaderUserId || '')
          const mark = item.leaderMark
          if (uid && mark) uidToMark.set(uid, mark)
        }
        await sleep(250)
      }
      console.log(`  → ${uidToMark.size} total mappings so far`)
    }
  }

  console.log(`\n✓ Total UID→leaderMark mappings: ${uidToMark.size}`)
  const missing = [...needUIDs].filter(uid => !uidToMark.has(uid))
  console.log(`  ${needUIDs.size - missing.length}/${needUIDs.size} traders resolved`)
  console.log(`  ${missing.length} traders not found in listing (may be inactive/delisted)`)

  await browser.close()

  // Now enrich via direct API
  console.log('\n📡 Enriching via leader-income API...')
  const resolved = [...traderMap.entries()].filter(([uid]) => uidToMark.has(uid))
  let traders = LIMIT ? resolved.slice(0, LIMIT) : resolved

  const totalUpdated = await processParallel(traders, async ([uid, rows]) => {
    const leaderMark = uidToMark.get(uid)
    const result = await fetchLeaderIncome(leaderMark)
    if (!result) return 0
    const metrics = parseMetrics(result)
    if (!Object.keys(metrics).length) return 0

    let updated = 0
    for (const row of rows) {
      const updates = {}
      if (row.roi_7d == null && metrics.roi_7d != null) updates.roi_7d = metrics.roi_7d
      if (row.roi_30d == null && metrics.roi_30d != null) updates.roi_30d = metrics.roi_30d
      if (row.pnl_7d == null && metrics.pnl_7d != null) updates.pnl_7d = metrics.pnl_7d
      if (row.pnl_30d == null && metrics.pnl_30d != null) updates.pnl_30d = metrics.pnl_30d
      if (!Object.keys(updates).length) continue

      if (DRY_RUN) {
        console.log(`\n  [DRY] uid=${uid} row=${row.id}:`, updates)
        updated++
      } else {
        const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', row.id)
        if (!error) updated++
      }
    }
    return updated
  }, CONCURRENCY)

  // Count after
  const { count: after } = await supabase.from('trader_snapshots')
    .select('id', { count: 'exact', head: true }).eq('source', 'bybit_spot').is('roi_7d', null)

  console.log(`\n═══ RESULTS ═══`)
  console.log(`BEFORE: ${before} | AFTER: ${after}`)
  console.log(`Row updates: ${totalUpdated} | Filled: ${(before || 0) - (after || 0)} rows`)
  if (missing.length > 0) console.log(`Note: ${missing.length} traders could not be resolved (inactive/delisted)`)
}

main().catch(e => { console.error(e); process.exit(1) })
