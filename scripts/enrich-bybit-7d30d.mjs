#!/usr/bin/env node
/**
 * Enrich Bybit futures trader_snapshots with 7d/30d ROI and PNL
 *
 * API: api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=<base64>
 * Fields:
 *   sevenDayYieldRateE4  / 100 → roi_7d
 *   thirtyDayYieldRateE4 / 100 → roi_30d
 *   sevenDayProfitE8     / 1e8 → pnl_7d
 *   thirtyDayProfitE8    / 1e8 → pnl_30d
 *
 * Phase 1: Parallel direct API for base64 leaderMark IDs (concurrency=5)
 * Phase 2: Playwright listing → UID→leaderMark map → leader-income for numeric IDs
 *
 * Usage:
 *   node scripts/enrich-bybit-7d30d.mjs
 *   node scripts/enrich-bybit-7d30d.mjs --dry-run
 *   node scripts/enrich-bybit-7d30d.mjs --limit=50
 *   node scripts/enrich-bybit-7d30d.mjs --phase=1   (only direct API)
 *   node scripts/enrich-bybit-7d30d.mjs --phase=2   (only Playwright)
 *   node scripts/enrich-bybit-7d30d.mjs --concurrency=8
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
const ONLY_PHASE = parseInt(process.argv.find(a => a.startsWith('--phase='))?.split('=')[1]) || 0
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 5
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const INCOME_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income'

const isBase64Mark = id => id.includes('=') || id.includes('+') || id.includes('/')

function parseMetrics(result) {
  // Store even 0 values — 0% ROI in 7d is valid data (trader had no activity that period)
  // Only skip if cumTradeCount=0 AND cumYieldE8=0 (completely empty profile = bad/expired ID)
  const cumTrade = parseInt(result.cumTradeCount || '0')
  const cumYield = parseInt(result.cumYieldE8 || '0')
  if (cumTrade === 0 && cumYield === 0) return {} // truly empty profile

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

async function updateRows(rows, metrics) {
  let updated = 0
  for (const row of rows) {
    const updates = {}
    if (row.roi_7d == null && metrics.roi_7d != null) updates.roi_7d = metrics.roi_7d
    if (row.roi_30d == null && metrics.roi_30d != null) updates.roi_30d = metrics.roi_30d
    if (row.pnl_7d == null && metrics.pnl_7d != null) updates.pnl_7d = metrics.pnl_7d
    if (row.pnl_30d == null && metrics.pnl_30d != null) updates.pnl_30d = metrics.pnl_30d
    if (!Object.keys(updates).length) continue

    if (DRY_RUN) {
      console.log(`  [DRY] ${row.source_trader_id.slice(0, 16)} row ${row.id}:`, updates)
      updated++
    } else {
      const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) updated++
    }
  }
  return updated
}

// Parallel processing with semaphore
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
  console.log() // newline after progress
  return updated
}

async function phase1Direct(traderMap) {
  console.log('\n━━━ Phase 1: Direct API for base64 leaderMark IDs ━━━')
  const base64Traders = [...traderMap.entries()].filter(([id]) => isBase64Mark(id))
  let traders = base64Traders
  if (LIMIT) traders = traders.slice(0, LIMIT)
  console.log(`${traders.length} traders with base64 marks (concurrency=${CONCURRENCY})`)

  const updated = await processParallel(traders, async ([leaderMark, rows]) => {
    const result = await fetchLeaderIncome(leaderMark)
    if (!result) return 0
    const metrics = parseMetrics(result)
    if (!Object.keys(metrics).length) return 0
    return await updateRows(rows, metrics)
  }, CONCURRENCY)

  console.log(`Phase 1 done: updated=${updated}`)
  return updated
}

async function phase2Playwright(traderMap) {
  console.log('\n━━━ Phase 2: Playwright for numeric IDs ━━━')
  const numericTraders = [...traderMap.entries()].filter(([id]) => !isBase64Mark(id))
    .filter(([id]) => /^\d{6,}$/.test(id))
  console.log(`${numericTraders.length} traders with numeric IDs`)
  if (!numericTraders.length) { console.log('  Nothing to do'); return 0 }

  const needUIDs = new Set(numericTraders.map(([id]) => id))

  let puppeteer, StealthPlugin
  try {
    const m1 = await import('puppeteer-extra')
    const m2 = await import('puppeteer-extra-plugin-stealth')
    puppeteer = m1.default; StealthPlugin = m2.default
    puppeteer.use(StealthPlugin())
  } catch (e) { console.log('puppeteer not available:', e.message); return 0 }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)

  console.log('  Visiting bybit.com...')
  try {
    // Use a URL that loads (200 OK) to establish proper cookies
    const resp = await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    console.log('  bybit.com status:', resp?.status())
    await sleep(4000)
  } catch (e) { console.log('  Warning:', e.message?.slice(0, 60)) }
  
  // Quick test
  const testData = await navFetch(`https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=2&dataDuration=DATA_DURATION_SEVEN_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI`)
  console.log('  Listing API test:', testData ? `retCode=${testData.retCode} len=${testData.result?.leaderDetails?.length}` : 'FAILED')

  const uidToMark = new Map()
  const DURATIONS = ['DATA_DURATION_NINETY_DAY', 'DATA_DURATION_THIRTY_DAY', 'DATA_DURATION_SEVEN_DAY']
  const LIST_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list'

  async function navFetch(url) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 })
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
      if (!text || text.startsWith('<') || text.length < 10) return null
      return JSON.parse(text)
    } catch { return null }
  }

  for (const duration of DURATIONS) {
    if (uidToMark.size >= needUIDs.size) break
    console.log(`  Listing ${duration}...`)
    for (let pageNo = 1; pageNo <= 40; pageNo++) {
      const result = await navFetch(`${LIST_URL}?pageNo=${pageNo}&pageSize=50&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`)

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
  }
  console.log(`  Found ${uidToMark.size}/${needUIDs.size} UID→leaderMark mappings`)
  await browser.close()

  // Now enrich via direct API
  let traders = numericTraders.filter(([uid]) => uidToMark.has(uid))
  if (LIMIT) traders = traders.slice(0, LIMIT)
  console.log(`  ${traders.length} traders with resolved marks`)

  const updated = await processParallel(traders, async ([uid, rows]) => {
    const leaderMark = uidToMark.get(uid)
    const result = await fetchLeaderIncome(leaderMark)
    if (!result) return 0
    const metrics = parseMetrics(result)
    if (!Object.keys(metrics).length) return 0
    return await updateRows(rows, metrics)
  }, CONCURRENCY)

  console.log(`Phase 2 done: updated=${updated}`)
  return updated
}

async function main() {
  console.log('═══ Bybit Futures — 7d/30d ROI+PNL enrichment ═══')
  if (DRY_RUN) console.log('[DRY RUN]')

  const { count: before } = await supabase.from('trader_snapshots')
    .select('id', { count: 'exact', head: true }).eq('source', 'bybit').is('roi_7d', null)
  console.log(`BEFORE: bybit roi_7d NULL = ${before}`)

  let allRows = [], offset = 0
  while (true) {
    const { data } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d, pnl_7d, pnl_30d')
      .eq('source', 'bybit').is('roi_7d', null)
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  console.log(`Total rows: ${allRows.length}`)

  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }
  console.log(`Unique traders: ${traderMap.size}`)

  let totalUpdated = 0
  if (!ONLY_PHASE || ONLY_PHASE === 1) totalUpdated += await phase1Direct(traderMap)
  if (!ONLY_PHASE || ONLY_PHASE === 2) totalUpdated += await phase2Playwright(traderMap)

  const { count: after } = await supabase.from('trader_snapshots')
    .select('id', { count: 'exact', head: true }).eq('source', 'bybit').is('roi_7d', null)
  console.log(`\nAFTER: bybit roi_7d NULL = ${after}`)
  console.log(`Total row updates: ${totalUpdated} | Filled: ${(before || 0) - (after || 0)} rows`)
}

main().catch(e => { console.error(e); process.exit(1) })
