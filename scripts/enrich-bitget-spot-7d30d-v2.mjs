#!/usr/bin/env node
/**
 * enrich-bitget-spot-7d30d-v2.mjs
 * 
 * Correct approach for bitget_spot roi_7d / roi_30d enrichment.
 * 
 * Problem: source_trader_id values like "spot_10comjak" are username slugs.
 *          The API requires internal hex traderUid (e.g. "bab7497188b23a51a294").
 * 
 * Strategy:
 * 1. Scan 7d leaderboard (max 200 entries, dataCycle=7) - extract roi_7d by username match
 * 2. Scan 30d leaderboard (up to 5586 entries, dataCycle=30) - extract roi_30d + build uid map
 * 3. For traders found via uid, call queryProfitRate with hex uid for any still-missing periods
 * 4. Update DB only with real API data
 * 
 * Matching: strip "spot_" prefix, compare to userName (case-insensitive)
 *           For BGUSER- format: spot_bguser1psvkjrp ↔ BGUSER-1PSVKJRP
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')

function normalizeUsername(rawId) {
  // Convert "bguser1psvkjrp" -> "BGUSER-1PSVKJRP" for matching
  if (rawId.startsWith('bguser')) {
    return `BGUSER-${rawId.slice(6).toUpperCase()}`
  }
  return rawId
}

function matchesTrader(row, rawIdsSet, rawToOriginal) {
  const userName = (row.userName || '').toLowerCase()
  const displayName = (row.displayName || '').toLowerCase()
  
  // Direct match
  if (rawIdsSet.has(userName)) return rawToOriginal.get(userName)
  if (rawIdsSet.has(displayName)) return rawToOriginal.get(displayName)
  
  // BGUSER- format
  if (userName.startsWith('bguser-')) {
    const compact = 'bguser' + userName.slice(7)  // "BGUSER-1PSV" -> "bguser1psv"
    if (rawIdsSet.has(compact)) return rawToOriginal.get(compact)
  }
  if (displayName.startsWith('bguser-')) {
    const compact = 'bguser' + displayName.slice(7)
    if (rawIdsSet.has(compact)) return rawToOriginal.get(compact)
  }
  
  return null
}

async function scanLeaderboard(page, dataCycle, rawIdsSet, rawToOriginal) {
  const found = {}  // source_trader_id -> { uid, roi }
  let totalScanned = 0
  
  for (let page_no = 1; page_no <= 200; page_no++) {
    const r = await page.evaluate(async ({ page_no, dataCycle }) => {
      try {
        const resp = await fetch('/v1/trace/spot/public/uta/traderView', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pageNo: page_no, pageSize: 50, sortRule: 2, sortFlag: 0,
            dataCycle, fullStatus: 1, languageType: 0
          })
        })
        return { status: resp.status, data: await resp.json() }
      } catch(e) { return { error: e.toString() } }
    }, { page_no, dataCycle })

    if (r.error) {
      console.warn(`  Page ${page_no} error: ${r.error}`)
      await sleep(2000)
      continue
    }

    const rows = r.data?.data?.rows
    const nextFlag = r.data?.data?.nextFlag
    if (!rows?.length) break

    totalScanned += rows.length

    for (const row of rows) {
      const originalId = matchesTrader(row, rawIdsSet, rawToOriginal)
      if (originalId) {
        const roiItem = row.itemVoList?.find(i => i.showColumnCode === 'profit_rate')
        const roi = roiItem?.comparedValue != null ? parseFloat(roiItem.comparedValue) : null
        const uid = row.traderUid
        if (!found[originalId]) {
          found[originalId] = { uid, roi }
          console.log(`  ✅ [${dataCycle}d] ${originalId} -> uid=${uid} roi=${roi}`)
        }
      }
    }

    if (!nextFlag) break
    await sleep(150)
  }
  
  console.log(`  Scanned ${totalScanned} traders, found ${Object.keys(found).length} matches`)
  return found
}

async function fetchProfitRateForPeriod(page, traderUid, showDay, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const r = await page.evaluate(async ({ traderUid, showDay }) => {
      try {
        const resp = await fetch('/v1/trace/spot/view/queryProfitRate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ languageType: 0, triggerUserId: traderUid, showDay })
        })
        const text = await resp.text()
        if (text.startsWith('<')) return { htmlError: true }
        return { status: resp.status, data: JSON.parse(text) }
      } catch(e) { return { error: e.toString() } }
    }, { traderUid, showDay })

    if (r.error || r.htmlError) return null
    if (r.status === 429) { await sleep((attempt + 1) * 4000); continue }
    if (r.status !== 200) return null
    if (r.data?.code !== '200') return null
    
    const rows = r.data?.data?.rows
    if (!rows?.length) return null
    
    // ROI timeseries - use the last value as current ROI, or compute from first/last
    const lastVal = parseFloat(rows[rows.length - 1]?.amount)
    if (isNaN(lastVal)) return null
    return parseFloat(lastVal.toFixed(4))
  }
  return null
}

async function main() {
  console.log(`=== Bitget Spot 7d/30d ROI Enrichment v2 ===`)
  console.log(`DRY_RUN: ${DRY_RUN}`)

  // Get traders needing enrichment
  const { data: snaps7 } = await sb.from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'bitget_spot')
    .is('roi_7d', null)
  const { data: snaps30 } = await sb.from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'bitget_spot')
    .is('roi_30d', null)

  const null7 = new Set((snaps7 || []).map(s => s.source_trader_id))
  const null30 = new Set((snaps30 || []).map(s => s.source_trader_id))
  const allNullIds = new Set([...null7, ...null30])
  
  console.log(`roi_7d NULL: ${null7.size} traders`)
  console.log(`roi_30d NULL: ${null30.size} traders`)
  console.log(`Total unique: ${allNullIds.size}`)

  if (allNullIds.size === 0) {
    console.log('Nothing to enrich!'); process.exit(0)
  }

  // Build lookup structures
  const rawIdsSet = new Set()  // lowercase raw IDs (without spot_ prefix)
  const rawToOriginal = new Map()  // lowercase raw -> original source_trader_id
  for (const id of allNullIds) {
    const raw = id.replace(/^spot_/, '').toLowerCase()
    rawIdsSet.add(raw)
    rawToOriginal.set(raw, id)
  }

  // Start browser
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  await ctx.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2}', r => r.abort())
  const pg = await ctx.newPage()
  await pg.goto('https://www.bitget.com/copy-trading/spot', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('Session ready.\n')

  // Phase 1: Scan 7d leaderboard
  console.log('📊 Phase 1: Scanning 7d leaderboard...')
  const found7d = await scanLeaderboard(pg, 7, rawIdsSet, rawToOriginal)
  console.log('')

  // Phase 2: Scan 30d leaderboard (more traders)
  console.log('📊 Phase 2: Scanning 30d leaderboard...')
  const found30d = await scanLeaderboard(pg, 30, rawIdsSet, rawToOriginal)
  console.log('')

  // Phase 3: For traders found in any leaderboard but missing the other period,
  //           use their hex uid to call queryProfitRate
  // Build uid map from both scans
  const uidMap = {}  // source_trader_id -> uid
  for (const [id, info] of Object.entries(found7d)) { if (info.uid) uidMap[id] = info.uid }
  for (const [id, info] of Object.entries(found30d)) { if (info.uid) uidMap[id] = info.uid }

  console.log(`📊 Phase 3: Fetching missing periods for ${Object.keys(uidMap).length} traders with known UIDs...`)
  const extraData = {}  // source_trader_id -> { roi7d?, roi30d? }
  for (const [id, uid] of Object.entries(uidMap)) {
    const need7d = null7.has(id) && found7d[id]?.roi == null
    const need30d = null30.has(id) && found30d[id]?.roi == null
    if (!need7d && !need30d) continue

    process.stdout.write(`  ${id.slice(0, 20)}... `)
    if (need7d) {
      const roi = await fetchProfitRateForPeriod(pg, uid, 1)  // showDay=1 = 7d
      extraData[id] = { ...extraData[id], roi7d: roi }
      process.stdout.write(`7d=${roi} `)
      await sleep(300)
    }
    if (need30d) {
      const roi = await fetchProfitRateForPeriod(pg, uid, 3)  // showDay=3 = 30d
      extraData[id] = { ...extraData[id], roi30d: roi }
      process.stdout.write(`30d=${roi}`)
      await sleep(300)
    }
    process.stdout.write('\n')
    await sleep(500)
  }

  await browser.close()

  // Phase 4: Update DB
  console.log('\n📊 Phase 4: Updating DB...')
  let updated = 0, noData = 0, errors = 0

  for (const id of allNullIds) {
    const updates = {}
    
    // roi_7d
    if (null7.has(id)) {
      let roi7d = found7d[id]?.roi ?? extraData[id]?.roi7d ?? null
      if (roi7d != null) updates.roi_7d = roi7d
    }
    
    // roi_30d
    if (null30.has(id)) {
      let roi30d = found30d[id]?.roi ?? extraData[id]?.roi30d ?? null
      if (roi30d != null) updates.roi_30d = roi30d
    }

    if (!Object.keys(updates).length) {
      noData++
      continue
    }

    if (!DRY_RUN) {
      const { error } = await sb.from('trader_snapshots')
        .update(updates)
        .eq('source', 'bitget_spot')
        .eq('source_trader_id', id)
      if (error) {
        console.error(`  ❌ ${id}: ${error.message}`)
        errors++
      } else {
        console.log(`  ✅ ${id}: ${JSON.stringify(updates)}`)
        updated++
      }
    } else {
      console.log(`  [DRY] ${id}: ${JSON.stringify(updates)}`)
      updated++
    }
  }

  // Summary
  console.log(`\n${'='.repeat(50)}`)
  console.log(`Updated: ${updated}`)
  console.log(`No data: ${noData}`)
  console.log(`Errors:  ${errors}`)

  // Verify DB
  const { count: rem7 } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_spot').is('roi_7d', null)
  const { count: rem30 } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_spot').is('roi_30d', null)
  const { count: filled7 } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_spot').not('roi_7d', 'is', null)
  const { count: filled30 } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_spot').not('roi_30d', 'is', null)

  console.log(`\n📊 DB Verification (bitget_spot trader_snapshots):`)
  console.log(`   roi_7d  NULL remaining: ${rem7} | filled: ${filled7}`)
  console.log(`   roi_30d NULL remaining: ${rem30} | filled: ${filled30}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
