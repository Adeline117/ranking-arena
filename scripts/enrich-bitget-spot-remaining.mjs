#!/usr/bin/env node
/**
 * enrich-bitget-spot-remaining.mjs
 * 
 * Final pass for traders not found in the ROI-sorted leaderboard.
 * Scans other sort orders + longer cycles + direct profile page approach.
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

function matchesTrader(row, rawIdsSet, rawToOriginal) {
  const userName = (row.userName || '').toLowerCase()
  const displayName = (row.displayName || '').toLowerCase()
  if (rawIdsSet.has(userName)) return rawToOriginal.get(userName)
  if (rawIdsSet.has(displayName)) return rawToOriginal.get(displayName)
  // BGUSER- format
  if (userName.startsWith('bguser-')) {
    const compact = 'bguser' + userName.slice(7)
    if (rawIdsSet.has(compact)) return rawToOriginal.get(compact)
  }
  if (displayName.startsWith('bguser-')) {
    const compact = 'bguser' + displayName.slice(7)
    if (rawIdsSet.has(compact)) return rawToOriginal.get(compact)
  }
  return null
}

async function scanLeaderboardVariant(pg, dataCycle, sortRule, rawIdsSet, rawToOriginal, label) {
  const found = {}
  let totalScanned = 0
  
  for (let page_no = 1; page_no <= 200; page_no++) {
    let r
    try {
      r = await pg.evaluate(async ({ page_no, dataCycle, sortRule }) => {
        const resp = await fetch('/v1/trace/spot/public/uta/traderView', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageNo: page_no, pageSize: 50, sortRule, sortFlag: 0, dataCycle, fullStatus: 1, languageType: 0 })
        })
        const text = await resp.text()
        return { status: resp.status, text }
      }, { page_no, dataCycle, sortRule })
    } catch(e) {
      await sleep(1000); continue
    }

    if (!r.text || r.text.startsWith('<')) { await sleep(500); continue }
    
    let data
    try { data = JSON.parse(r.text) } catch { await sleep(500); continue }

    const rows = data?.data?.rows
    const nextFlag = data?.data?.nextFlag
    if (!rows?.length) break

    totalScanned += rows.length

    for (const row of rows) {
      const originalId = matchesTrader(row, rawIdsSet, rawToOriginal)
      if (originalId && !found[originalId]) {
        const roiItem = row.itemVoList?.find(i => i.showColumnCode === 'profit_rate')
        const roi = roiItem?.comparedValue != null ? parseFloat(roiItem.comparedValue) : null
        found[originalId] = { uid: row.traderUid, roi }
        console.log(`  ✅ [${label}] ${originalId} -> uid=${row.traderUid} roi=${roi}`)
      }
    }

    if (!nextFlag) break
    await sleep(150)
  }

  console.log(`  ${label}: scanned ${totalScanned} traders, found ${Object.keys(found).length} new matches`)
  return found
}

// Try calling queryProfitRate with hex uid
async function fetchProfitRateWithUid(pg, uid, showDay) {
  const r = await pg.evaluate(async ({ uid, showDay }) => {
    try {
      const resp = await fetch('/v1/trace/spot/view/queryProfitRate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languageType: 0, triggerUserId: uid, showDay })
      })
      const text = await resp.text()
      if (text.startsWith('<')) return { htmlError: true }
      return { status: resp.status, data: JSON.parse(text) }
    } catch(e) { return { error: e.toString() } }
  }, { uid, showDay })

  if (r.error || r.htmlError || r.status !== 200) return null
  if (r.data?.code !== '200') return null
  const rows = r.data?.data?.rows
  if (!rows?.length) return null
  const val = parseFloat(rows[rows.length - 1]?.amount)
  return isNaN(val) ? null : parseFloat(val.toFixed(4))
}

async function main() {
  // Get remaining null traders
  const { data: d7 } = await sb.from('trader_snapshots').select('source_trader_id').eq('source','bitget_spot').is('roi_7d',null)
  const { data: d30 } = await sb.from('trader_snapshots').select('source_trader_id').eq('source','bitget_spot').is('roi_30d',null)
  const null7 = new Set([...(d7||[]).map(r=>r.source_trader_id)])
  const null30 = new Set([...(d30||[]).map(r=>r.source_trader_id)])
  const allNull = new Set([...null7, ...null30])

  console.log(`Remaining null: roi_7d=${null7.size} unique, roi_30d=${null30.size} unique`)
  console.log('roi_7d traders:', [...null7].join(', '))
  console.log('roi_30d traders:', [...null30].join(', '))

  if (allNull.size === 0) { console.log('Nothing to do!'); process.exit(0) }

  const rawIdsSet = new Set()
  const rawToOriginal = new Map()
  for (const id of allNull) {
    const raw = id.replace(/^spot_/, '').toLowerCase()
    rawIdsSet.add(raw)
    rawToOriginal.set(raw, id)
  }

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

  // Scan multiple sort orders and data cycles
  const variants = [
    { dataCycle: 30, sortRule: 5,  label: '30d/Profits' },
    { dataCycle: 30, sortRule: 9,  label: '30d/AUM' },
    { dataCycle: 30, sortRule: 10, label: '30d/CopierPnL' },
    { dataCycle: 90, sortRule: 2,  label: '90d/ROI' },
    { dataCycle: 90, sortRule: 5,  label: '90d/Profits' },
    { dataCycle: 180, sortRule: 2, label: '180d/ROI' },
    { dataCycle: 7,  sortRule: 5,  label: '7d/Profits' },
    { dataCycle: 7,  sortRule: 9,  label: '7d/AUM' },
  ]

  const allFound = {}  // source_trader_id -> { uid, roi7d?, roi30d? }

  for (const v of variants) {
    if (Object.keys(allFound).length >= allNull.size) break
    
    console.log(`\n📊 Scanning ${v.label}...`)
    // Only search for traders we haven't found yet
    const stillNeeded = new Set([...allNull].filter(id => !allFound[id]?.uid))
    if (stillNeeded.size === 0) break

    const stillRawIds = new Set([...stillNeeded].map(id => id.replace(/^spot_/, '').toLowerCase()))
    const stillMap = new Map([...rawToOriginal].filter(([k]) => stillRawIds.has(k)))

    const found = await scanLeaderboardVariant(pg, v.dataCycle, v.sortRule, stillRawIds, stillMap, v.label)
    
    for (const [id, info] of Object.entries(found)) {
      if (!allFound[id]) allFound[id] = { uid: info.uid }
      // Store ROI for the relevant period based on dataCycle
      if (v.dataCycle === 7 && null7.has(id)) allFound[id].roi7d = info.roi
      if (v.dataCycle === 30 && null30.has(id)) allFound[id].roi30d = info.roi
    }
    await sleep(500)
  }

  // For traders found with uid but still missing periods, call queryProfitRate
  console.log(`\n📊 Phase 3: Calling queryProfitRate for traders with uid...`)
  for (const [id, info] of Object.entries(allFound)) {
    if (!info.uid) continue
    
    const need7d = null7.has(id) && info.roi7d == null
    const need30d = null30.has(id) && info.roi30d == null
    if (!need7d && !need30d) continue

    process.stdout.write(`  ${id}... `)
    if (need7d) {
      const roi = await fetchProfitRateWithUid(pg, info.uid, 1)  // showDay=1 = 7d
      allFound[id].roi7d = roi
      process.stdout.write(`7d=${roi} `)
      await sleep(400)
    }
    if (need30d) {
      const roi = await fetchProfitRateWithUid(pg, info.uid, 3)  // showDay=3 = 30d  
      allFound[id].roi30d = roi
      process.stdout.write(`30d=${roi}`)
      await sleep(400)
    }
    process.stdout.write('\n')
  }

  await browser.close()

  // Update DB
  console.log(`\n📊 Updating DB...`)
  let updated = 0, noData = 0, errors = 0

  for (const id of allNull) {
    const info = allFound[id]
    const updates = {}
    if (null7.has(id) && info?.roi7d != null) updates.roi_7d = info.roi7d
    if (null30.has(id) && info?.roi30d != null) updates.roi_30d = info.roi30d

    if (!Object.keys(updates).length) {
      noData++
      console.log(`  ⚠️  ${id}: no data found`)
      continue
    }

    if (!DRY_RUN) {
      const { error } = await sb.from('trader_snapshots')
        .update(updates).eq('source', 'bitget_spot').eq('source_trader_id', id)
      if (error) { console.error(`  ❌ ${id}: ${error.message}`); errors++ }
      else { console.log(`  ✅ ${id}: ${JSON.stringify(updates)}`); updated++ }
    } else {
      console.log(`  [DRY] ${id}: ${JSON.stringify(updates)}`); updated++
    }
  }

  // Verify
  const { count: rem7 } = await sb.from('trader_snapshots').select('*',{count:'exact',head:true}).eq('source','bitget_spot').is('roi_7d',null)
  const { count: rem30 } = await sb.from('trader_snapshots').select('*',{count:'exact',head:true}).eq('source','bitget_spot').is('roi_30d',null)
  const { count: filled7 } = await sb.from('trader_snapshots').select('*',{count:'exact',head:true}).eq('source','bitget_spot').not('roi_7d','is',null)
  const { count: filled30 } = await sb.from('trader_snapshots').select('*',{count:'exact',head:true}).eq('source','bitget_spot').not('roi_30d','is',null)

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Updated: ${updated} | No data: ${noData} | Errors: ${errors}`)
  console.log(`\n📊 DB Verification (bitget_spot):`)
  console.log(`   roi_7d  NULL remaining: ${rem7} | filled: ${filled7}`)
  console.log(`   roi_30d NULL remaining: ${rem30} | filled: ${filled30}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
