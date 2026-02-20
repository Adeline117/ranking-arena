#!/usr/bin/env node
/**
 * enrich-bitget-spot-final.mjs
 * 
 * Final pass - aggressive scan with retries for all page errors.
 * Also tries profile-page UID lookup for traders not found in leaderboard.
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
  const checks = [
    (row.userName || '').toLowerCase(),
    (row.displayName || '').toLowerCase(),
    (row.nickName || '').toLowerCase(),
  ]
  for (const val of checks) {
    if (rawIdsSet.has(val)) return rawToOriginal.get(val)
    if (val.startsWith('bguser-')) {
      const compact = 'bguser' + val.slice(7)
      if (rawIdsSet.has(compact)) return rawToOriginal.get(compact)
    }
  }
  return null
}

async function fetchPageWithRetry(pg, pageNo, dataCycle, sortRule, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const r = await pg.evaluate(async ({ pageNo, dataCycle, sortRule }) => {
        const resp = await fetch('/v1/trace/spot/public/uta/traderView', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageNo, pageSize: 50, sortRule, sortFlag: 0, dataCycle, fullStatus: 1, languageType: 0 })
        })
        if (!resp.ok) return { httpError: resp.status }
        const text = await resp.text()
        return { text }
      }, { pageNo, dataCycle, sortRule })
      
      if (r.httpError) { await sleep(2000); continue }
      if (!r.text || r.text.startsWith('<')) { await sleep(1500); continue }
      
      const data = JSON.parse(r.text)
      return data
    } catch(e) {
      await sleep(1500 * (attempt + 1))
    }
  }
  return null
}

async function scanLeaderboardFull(pg, dataCycle, sortRule, rawIdsSet, rawToOriginal, label) {
  const found = {}
  let totalScanned = 0

  for (let page_no = 1; page_no <= 200; page_no++) {
    const data = await fetchPageWithRetry(pg, page_no, dataCycle, sortRule)
    if (!data) continue

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
    await sleep(100)
  }

  console.log(`  ${label}: scanned ${totalScanned}, found ${Object.keys(found).length}`)
  return found
}

// Try to get uid + any data via profile page navigation  
async function getUidFromProfilePage(ctx, traderId) {
  const rawId = traderId.replace(/^spot_/, '')
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2}', r => r.abort())
  
  let uid = null
  let roi7d = null
  let roi30d = null
  
  // Capture all responses
  const handler = async resp => {
    const url = resp.url()
    try {
      if (url.includes('queryProfitRate') || url.includes('traderDetailPage')) {
        const body = await resp.text()
        if (!body.startsWith('{')) return
        const data = JSON.parse(body)
        if (data.code === '200' && data.data) {
          if (url.includes('queryProfitRate')) {
            const rows = data.data.rows
            if (rows?.length) {
              const lastVal = parseFloat(rows[rows.length-1]?.amount)
              if (!isNaN(lastVal)) roi7d = parseFloat(lastVal.toFixed(4))
            }
          }
          if (url.includes('traderDetailPage') && data.data.traderDataVo) {
            const traderData = data.data.traderDataVo
            uid = traderData.traderId || traderData.traderUid || traderData.userId
          }
        }
      }
    } catch {}
  }
  page.on('response', handler)

  // Try multiple URL formats
  const urlsToTry = [
    `https://www.bitget.com/copy-trading/trader/${rawId}/spot`,
    `https://www.bitget.com/copy-trading/spot-trader/${rawId}`,
  ]

  for (const url of urlsToTry) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await sleep(3000)
      if (uid || roi7d) break
    } catch {}
  }

  page.removeListener('response', handler)
  await page.close()
  return { uid, roi7d, roi30d }
}

async function fetchProfitRateWithUid(pg, uid, showDay) {
  const r = await pg.evaluate(async ({ uid, showDay }) => {
    try {
      const resp = await fetch('/v1/trace/spot/view/queryProfitRate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languageType: 0, triggerUserId: uid, showDay })
      })
      const text = await resp.text()
      if (text.startsWith('<')) return null
      return JSON.parse(text)
    } catch { return null }
  }, { uid, showDay })

  if (!r || r.code !== '200') return null
  const rows = r.data?.rows
  if (!rows?.length) return null
  const val = parseFloat(rows[rows.length-1]?.amount)
  return isNaN(val) ? null : parseFloat(val.toFixed(4))
}

async function main() {
  const { data: d7 } = await sb.from('trader_snapshots').select('source_trader_id').eq('source','bitget_spot').is('roi_7d',null)
  const { data: d30 } = await sb.from('trader_snapshots').select('source_trader_id').eq('source','bitget_spot').is('roi_30d',null)
  const null7 = new Set((d7||[]).map(r=>r.source_trader_id))
  const null30 = new Set((d30||[]).map(r=>r.source_trader_id))
  const allNull = new Set([...null7, ...null30])

  console.log(`Remaining: roi_7d=${null7.size} unique, roi_30d=${null30.size} unique`)
  console.log(`roi_7d:  ${[...null7].join(', ')}`)
  console.log(`roi_30d: ${[...null30].join(', ')}`)

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

  // Comprehensive scan - retry all pages properly
  const allFound = {}

  const scans = [
    { dataCycle: 30, sortRule: 2, label: '30d/ROI' },
    { dataCycle: 7,  sortRule: 2, label: '7d/ROI' },
    { dataCycle: 90, sortRule: 2, label: '90d/ROI' },
    { dataCycle: 30, sortRule: 5, label: '30d/Profits' },
    { dataCycle: 180, sortRule: 2, label: '180d/ROI' },
    { dataCycle: 30, sortRule: 9, label: '30d/AUM' },
    { dataCycle: 30, sortRule: 10, label: '30d/CopierPnL' },
  ]

  for (const s of scans) {
    const stillNeeded = new Set([...allNull].filter(id => !allFound[id]?.uid))
    if (stillNeeded.size === 0) break
    
    const stillRaw = new Set([...stillNeeded].map(id => id.replace(/^spot_/, '').toLowerCase()))
    const stillMap = new Map([...rawToOriginal].filter(([k]) => stillRaw.has(k)))

    console.log(`\n📊 Scanning ${s.label} for ${stillNeeded.size} traders...`)
    const found = await scanLeaderboardFull(pg, s.dataCycle, s.sortRule, stillRaw, stillMap, s.label)
    
    for (const [id, info] of Object.entries(found)) {
      if (!allFound[id]) allFound[id] = { uid: info.uid }
      if (s.dataCycle === 7  && null7.has(id)  && info.roi != null) allFound[id].roi7d = info.roi
      if (s.dataCycle === 30 && null30.has(id) && info.roi != null) allFound[id].roi30d = info.roi
    }
    await sleep(500)
  }

  // Profile page uid lookup for traders not found
  const notFoundIds = [...allNull].filter(id => !allFound[id]?.uid)
  if (notFoundIds.length > 0) {
    console.log(`\n📊 Trying profile page lookup for ${notFoundIds.length} traders...`)
    for (const id of notFoundIds) {
      process.stdout.write(`  ${id}... `)
      const result = await getUidFromProfilePage(ctx, id)
      if (result.uid || result.roi7d) {
        allFound[id] = { uid: result.uid, roi7d: result.roi7d, roi30d: result.roi30d }
        console.log(`uid=${result.uid} roi7d=${result.roi7d}`)
      } else {
        console.log('no data')
      }
      await sleep(1000)
    }
  }

  // Phase 3: Call queryProfitRate for traders with uid but missing periods
  const needApiCall = [...Object.entries(allFound)].filter(([id, info]) => {
    return info.uid && ((null7.has(id) && info.roi7d == null) || (null30.has(id) && info.roi30d == null))
  })

  if (needApiCall.length > 0) {
    console.log(`\n📊 Calling queryProfitRate for ${needApiCall.length} traders...`)
    for (const [id, info] of needApiCall) {
      process.stdout.write(`  ${id}... `)
      if (null7.has(id) && info.roi7d == null) {
        const roi = await fetchProfitRateWithUid(pg, info.uid, 1)
        allFound[id].roi7d = roi
        process.stdout.write(`7d=${roi} `)
        await sleep(400)
      }
      if (null30.has(id) && info.roi30d == null) {
        const roi = await fetchProfitRateWithUid(pg, info.uid, 3)
        allFound[id].roi30d = roi
        process.stdout.write(`30d=${roi}`)
        await sleep(400)
      }
      process.stdout.write('\n')
    }
  }

  await browser.close()

  // DB updates
  console.log(`\n📊 Updating DB...`)
  let updated = 0, noData = 0, errors = 0

  for (const id of allNull) {
    const info = allFound[id]
    const updates = {}
    if (null7.has(id) && info?.roi7d != null) updates.roi_7d = info.roi7d
    if (null30.has(id) && info?.roi30d != null) updates.roi_30d = info.roi30d

    if (!Object.keys(updates).length) {
      noData++
      console.log(`  ⚠️  ${id}: no data found anywhere`)
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
