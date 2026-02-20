#!/usr/bin/env node
/**
 * fix-leaderboard-ranks-wr-mdd.mjs
 * 
 * Phase 1: Fill NULL win_rate/max_drawdown in leaderboard_ranks from trader_snapshots
 * Phase 2: For remaining NULLs, fetch from Bitget API (cycleData endpoint via direct HTTP)
 * 
 * Usage: node fix-leaderboard-ranks-wr-mdd.mjs [--dry-run] [--limit=N] [--phase=1|2|all]
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import https from 'https'
import http from 'http'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '9999')
const PHASE = args.find(a => a.startsWith('--phase='))?.split('=')[1] || 'all'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const parseNum = v => { if (v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n }

// ─── HTTP fetch helper ────────────────────────────────────────────────────────
function httpPost(urlStr, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const body = JSON.stringify(payload)
    const lib = url.protocol === 'https:' ? https : http
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.bitget.com',
        'Referer': 'https://www.bitget.com/copy-trading/futures',
        ...headers,
      },
      timeout: 15000,
    }
    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }) }
        catch (e) { resolve({ status: res.statusCode, raw: data, parseErr: e.message }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

function httpGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const lib = url.protocol === 'https:' ? https : http
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
      timeout: 15000,
    }
    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }) }
        catch (e) { resolve({ status: res.statusCode, raw: data, parseErr: e.message }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

// ─── Bitget API methods ──────────────────────────────────────────────────────

// Method 1: cycleData POST (the main one)
async function fetchCycleData(triggerUserId, cycleTime = 30) {
  try {
    const res = await httpPost('https://www.bitget.com/v1/trigger/trace/public/cycleData', {
      languageType: 0,
      triggerUserId,
      cycleTime,
    })
    if (res.parseErr) return { error: `parse: ${res.parseErr}`, status: res.status }
    const d = res.data
    if (!d || d.code !== '00000') return { error: `code=${d?.code} ${d?.msg}` }
    const stats = d.data?.statisticsDTO
    if (!stats) return { error: 'no statisticsDTO' }
    return {
      winRate: parseNum(stats.winningRate),
      maxDD: parseNum(stats.maxRetracement),
      source: 'cycleData',
    }
  } catch (e) {
    return { error: e.message }
  }
}

// Method 2: profitSummaryList
async function fetchProfitSummaryList(traderId) {
  try {
    const res = await httpPost('https://www.bitget.com/v1/copy/mix/trader/profitSummaryList', {
      traderId,
      productType: 'USDT-FUTURES',
      pageNo: 1,
      pageSize: 1,
    })
    if (res.parseErr) return { error: `parse: ${res.parseErr}` }
    const d = res.data
    if (!d || d.code !== '00000') return { error: `code=${d?.code} ${d?.msg}` }
    const items = d.data?.items || d.data || []
    if (!Array.isArray(items) || items.length === 0) return { error: 'no items' }
    const item = items[0]
    return {
      winRate: parseNum(item.winRate || item.win_rate || item.winningRate),
      maxDD: parseNum(item.maxDrawdown || item.max_drawdown || item.maxRetracement),
      source: 'profitSummaryList',
    }
  } catch (e) {
    return { error: e.message }
  }
}

// Method 3: v2 profit-history-summarys GET
async function fetchProfitHistorySummary(traderId) {
  try {
    const params = new URLSearchParams({
      traderId,
      productType: 'USDT-FUTURES',
      pageNo: '1',
      pageSize: '5',
    })
    const res = await httpGet(
      `https://api.bitget.com/api/v2/copy/mix-trader/profit-history-summarys?${params}`
    )
    if (res.parseErr) return { error: `parse: ${res.parseErr}` }
    const d = res.data
    if (!d || d.code !== '00000') return { error: `code=${d?.code} ${d?.msg}` }
    const items = d.data?.result || d.data?.items || d.data || []
    if (!Array.isArray(items) || items.length === 0) return { error: 'no items' }
    const item = items[0]
    return {
      winRate: parseNum(item.winRate || item.winRatio),
      maxDD: parseNum(item.maxDrawdown || item.maxRetracementRate),
      source: 'profitHistorySummary',
    }
  } catch (e) {
    return { error: e.message }
  }
}

// Method 4: copy trade detail API
async function fetchTraderDetail(traderId) {
  try {
    const params = new URLSearchParams({
      traderId,
      productType: 'USDT-FUTURES',
    })
    const res = await httpGet(
      `https://api.bitget.com/api/v2/copy/mix-trader/detail?${params}`
    )
    if (res.parseErr) return { error: `parse: ${res.parseErr}` }
    const d = res.data
    if (!d || d.code !== '00000') return { error: `code=${d?.code} ${d?.msg}` }
    const data = d.data || {}
    return {
      winRate: parseNum(data.winRate || data.winRatio),
      maxDD: parseNum(data.maxDrawdown || data.maxRetracementRate),
      source: 'traderDetail',
    }
  } catch (e) {
    return { error: e.message }
  }
}

// Method 5: cycleData with different cycle times
async function fetchCycleDataAllTimes(traderId) {
  for (const ct of [30, 7, 90]) {
    const r = await fetchCycleData(traderId, ct)
    if (!r.error && (r.winRate !== null || r.maxDD !== null)) {
      return r
    }
    await sleep(200)
  }
  return { error: 'all cycle times failed', winRate: null, maxDD: null }
}

// ─── Phase 1: Fill from trader_snapshots ─────────────────────────────────────
async function phase1() {
  console.log('\n📋 Phase 1: Fill from trader_snapshots\n')
  
  // Get all NULL rows from leaderboard_ranks
  let nullRows = []
  let offset = 0
  while (true) {
    const { data, error } = await sb.from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown')
      .eq('source', 'bitget_futures')
      .or('win_rate.is.null,max_drawdown.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    nullRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  
  console.log(`Found ${nullRows.length} NULL rows in leaderboard_ranks`)
  
  const ids = [...new Set(nullRows.map(r => r.source_trader_id))]
  console.log(`Unique traders: ${ids.length}`)
  
  // Get trader_snapshots data — try to get best data per trader
  const snapMap = {}
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200)
    const { data: snaps } = await sb.from('trader_snapshots')
      .select('source_trader_id, win_rate, max_drawdown, season_id')
      .eq('source', 'bitget_futures')
      .in('source_trader_id', batch)
    
    for (const s of (snaps || [])) {
      const tid = s.source_trader_id
      if (!snapMap[tid]) snapMap[tid] = {}
      // Store by season
      if (!snapMap[tid][s.season_id] || (snapMap[tid][s.season_id].win_rate === null && s.win_rate !== null)) {
        snapMap[tid][s.season_id] = s
      }
      // Also track best any-season
      if (!snapMap[tid]._best || (snapMap[tid]._best.win_rate === null && s.win_rate !== null)) {
        snapMap[tid]._best = s
      }
    }
  }
  
  let updated = 0, skipped = 0, total = nullRows.length
  
  for (const lr of nullRows) {
    const tid = lr.source_trader_id
    const snaps = snapMap[tid]
    if (!snaps) { skipped++; continue }
    
    // Prefer same season, fallback to _best
    const snap = snaps[lr.season_id] || snaps._best
    if (!snap) { skipped++; continue }
    
    const update = {}
    if (lr.win_rate === null && snap.win_rate !== null) update.win_rate = snap.win_rate
    if (lr.max_drawdown === null && snap.max_drawdown !== null) update.max_drawdown = snap.max_drawdown
    
    if (Object.keys(update).length === 0) { skipped++; continue }
    
    if (!DRY_RUN) {
      const { error } = await sb.from('leaderboard_ranks')
        .update(update)
        .eq('id', lr.id)
      if (error) {
        console.error(`  ❌ ${tid} (id=${lr.id}): ${error.message}`)
        skipped++
      } else {
        updated++
        if (updated % 50 === 0) process.stdout.write(`  ✅ Updated ${updated}/${total}...\n`)
      }
    } else {
      console.log(`  [DRY] ${tid} season=${lr.season_id}: wr=${update.win_rate ?? '-'} mdd=${update.max_drawdown ?? '-'}`)
      updated++
    }
  }
  
  console.log(`\nPhase 1 done: updated=${updated}, skipped=${skipped}`)
  return updated
}

// ─── Phase 2: Fetch remaining from Bitget API ──────────────────────────────
async function phase2() {
  console.log('\n🌐 Phase 2: Fetch from Bitget API\n')
  
  // Get still-NULL rows
  let nullRows = []
  let offset = 0
  while (true) {
    const { data, error } = await sb.from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown')
      .eq('source', 'bitget_futures')
      .or('win_rate.is.null,max_drawdown.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    nullRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  
  // Deduplicate by trader (process each unique trader once)
  const seenTraders = new Map()
  for (const lr of nullRows) {
    const tid = lr.source_trader_id
    if (!seenTraders.has(tid)) {
      seenTraders.set(tid, { tid, rows: [], needWR: false, needMDD: false })
    }
    const e = seenTraders.get(tid)
    e.rows.push(lr)
    if (lr.win_rate === null) e.needWR = true
    if (lr.max_drawdown === null) e.needMDD = true
  }
  
  const traders = [...seenTraders.values()].slice(0, LIMIT)
  console.log(`Processing ${traders.length} unique traders`)
  
  // Test first trader to see which method works
  if (traders.length > 0) {
    console.log('\n🔬 Testing API methods on first trader:', traders[0].tid)
    const testId = traders[0].tid
    
    const r1 = await fetchCycleData(testId, 30)
    console.log('  Method 1 (cycleData 30d):', JSON.stringify(r1))
    
    const r2 = await fetchProfitSummaryList(testId)
    console.log('  Method 2 (profitSummaryList):', JSON.stringify(r2))
    
    const r3 = await fetchProfitHistorySummary(testId)
    console.log('  Method 3 (profitHistorySummary):', JSON.stringify(r3))
    
    const r4 = await fetchTraderDetail(testId)
    console.log('  Method 4 (traderDetail):', JSON.stringify(r4))
    console.log('')
  }
  
  let updated = 0, noData = 0, errors = 0
  
  for (let i = 0; i < traders.length; i++) {
    const { tid, rows, needWR, needMDD } = traders[i]
    
    process.stdout.write(`  [${i + 1}/${traders.length}] ${tid.slice(0, 16)}... `)
    
    // Try methods in order
    let result = null
    
    // Method 1: cycleData
    result = await fetchCycleDataAllTimes(tid)
    if (result.error) {
      await sleep(300)
      // Method 2: profitSummaryList
      result = await fetchProfitSummaryList(tid)
    }
    if (result.error) {
      await sleep(300)
      // Method 3: profitHistorySummary
      result = await fetchProfitHistorySummary(tid)
    }
    if (result.error) {
      await sleep(300)
      // Method 4: traderDetail
      result = await fetchTraderDetail(tid)
    }
    
    if (result.error || (result.winRate === null && result.maxDD === null)) {
      process.stdout.write(`⚠️  ${result.error || 'no data'}\n`)
      noData++
      await sleep(200)
      continue
    }
    
    process.stdout.write(`wr=${result.winRate ?? '-'} mdd=${result.maxDD ?? '-'} [${result.source}] `)
    
    // Update all rows for this trader
    const updatePayload = {}
    if (needWR && result.winRate !== null) updatePayload.win_rate = result.winRate
    if (needMDD && result.maxDD !== null) updatePayload.max_drawdown = result.maxDD
    
    if (Object.keys(updatePayload).length === 0) {
      process.stdout.write(`skip (no needed fields)\n`)
      noData++
      await sleep(200)
      continue
    }
    
    if (!DRY_RUN) {
      // Update all rows for this trader that need it
      for (const lr of rows) {
        const rowUpdate = {}
        if (lr.win_rate === null && updatePayload.win_rate !== undefined) rowUpdate.win_rate = updatePayload.win_rate
        if (lr.max_drawdown === null && updatePayload.max_drawdown !== undefined) rowUpdate.max_drawdown = updatePayload.max_drawdown
        if (Object.keys(rowUpdate).length === 0) continue
        
        const { error } = await sb.from('leaderboard_ranks')
          .update(rowUpdate)
          .eq('id', lr.id)
        if (error) {
          process.stdout.write(`❌ ${error.message}\n`)
          errors++
        }
      }
      process.stdout.write(`✅\n`)
      updated++
    } else {
      process.stdout.write(`[dry]\n`)
      updated++
    }
    
    await sleep(300 + Math.random() * 200)
  }
  
  console.log(`\nPhase 2 done: updated=${updated}, noData=${noData}, errors=${errors}`)
  return updated
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔧 Fix leaderboard_ranks win_rate/max_drawdown for bitget_futures')
  console.log(`   DRY_RUN=${DRY_RUN}, LIMIT=${LIMIT}, PHASE=${PHASE}`)
  
  // Initial counts
  const [{ count: wrNullBefore }, { count: mddNullBefore }] = await Promise.all([
    sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('win_rate', null),
    sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('max_drawdown', null),
  ])
  console.log(`\n📊 BEFORE: win_rate NULL=${wrNullBefore}, max_drawdown NULL=${mddNullBefore}`)
  
  if (PHASE === '1' || PHASE === 'all') await phase1()
  if (PHASE === '2' || PHASE === 'all') await phase2()
  
  // Final counts
  const [{ count: wrNullAfter }, { count: mddNullAfter }] = await Promise.all([
    sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('win_rate', null),
    sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('max_drawdown', null),
  ])
  
  console.log(`\n${'='.repeat(60)}`)
  console.log('📊 FINAL RESULTS:')
  console.log(`   win_rate  NULL: ${wrNullBefore} → ${wrNullAfter}  (filled ${wrNullBefore - wrNullAfter})`)
  console.log(`   max_drawdown NULL: ${mddNullBefore} → ${mddNullAfter}  (filled ${mddNullBefore - mddNullAfter})`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
