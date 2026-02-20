#!/usr/bin/env node
/**
 * Fix bybit max_drawdown v5 - handle remaining 12 rows
 * 
 * Improved strategy:
 * 1. Re-navigate to copyTrade page between each batch to keep /x-api/ working
 * 2. Use rank-list endpoint as alternative
 * 3. More aggressive matching: fuzzy/partial for short handles (2-3 chars)
 * 4. Print what we see in listings near each trader's expected rank for debug
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import https from 'https'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const PERIOD_PREFIX = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }

function extractMDD(result, seasonId) {
  const pfx = PERIOD_PREFIX[seasonId]
  if (!pfx) return null
  const ddRaw = result?.[pfx + 'DrawDownE4']
  if (ddRaw == null || ddRaw === '') return null
  const ddE4 = parseInt(ddRaw)
  if (isNaN(ddE4)) return null
  return ddE4 / 100
}

function normalize(s) {
  if (!s) return ''
  return s.trim().toLowerCase().replace(/[^a-z0-9\u0400-\u04ff]+/g, '_').replace(/^_+|_+$/g, '')
}

function httpsGet(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Connection': 'close' },
      timeout: timeoutMs,
    }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

async function fetchLeaderIncome(leaderUserId, leaderMark) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const param = leaderUserId && leaderUserId !== '0'
        ? `leaderUserId=${encodeURIComponent(leaderUserId)}`
        : `leaderMark=${encodeURIComponent(leaderMark)}`
      const { status, body } = await httpsGet(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?${param}`
      )
      if (status === 429) { await sleep(3000 * (attempt + 1)); continue }
      if (status !== 200 || body.startsWith('<')) return null
      const json = JSON.parse(body)
      if (json.retCode !== 0) return null
      return json.result
    } catch (e) {
      if (attempt < 2) await sleep(800)
    }
  }
  return null
}

/**
 * Fetch a page via browser evaluate (using /x-api/ proxy)
 */
async function fetchViaProxy(page, pageNo, dataDuration, sortField) {
  const url = `/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=100&dataDuration=${dataDuration}&sortField=${sortField}`
  try {
    return await page.evaluate(async (url) => {
      const res = await fetch(url, { 
        method: 'GET', 
        headers: { 'Accept': 'application/json' },
        credentials: 'include'
      })
      if (!res.ok) return null
      return res.json()
    }, url)
  } catch (e) {
    return null
  }
}

/**
 * Fetch via direct API URL using page.goto
 */
async function fetchViaDirect(page, pageNo, dataDuration, sortField) {
  const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=100&dataDuration=${dataDuration}&sortField=${sortField}`
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    if (!resp || resp.status() !== 200) return null
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
    if (!text || text.startsWith('<')) return null
    const json = JSON.parse(text)
    return json
  } catch (e) {
    return null
  }
}

/**
 * Try rank-list endpoint which may list traders differently
 */
async function fetchRankList(page, pageNo, period) {
  // period: 7, 30, 90
  const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/rank-list?period=${period}&pageNo=${pageNo}&pageSize=100`
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    if (!resp || resp.status() !== 200) return null
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
    if (!text || text.startsWith('<')) return null
    return JSON.parse(text)
  } catch (e) {
    return null
  }
}

async function ensureOnCopyTrade(page) {
  const url = page.url()
  if (!url.includes('bybit.com/copyTrade')) {
    try {
      await page.goto('https://www.bybit.com/copyTrade/traderRanking', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await sleep(3000)
    } catch (e) {
      console.log('  Warning: could not navigate to copyTrade:', e.message?.slice(0, 60))
    }
  }
}

async function main() {
  console.log('=== Fix bybit max_drawdown v5 (remaining traders) ===')
  const startTime = Date.now()

  const { data: allRows, error } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, handle, rank, roi')
    .eq('source', 'bybit')
    .is('max_drawdown', null)
    .limit(200)

  if (error) { console.error('DB error:', error.message); process.exit(1) }
  console.log(`Null-MDD rows: ${allRows.length}`)
  if (!allRows.length) { console.log('Nothing to do!'); return }

  const byTrader = new Map()
  const handleMap = new Map()
  const rankMap = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
    handleMap.set(r.source_trader_id, r.handle)
    rankMap.set(r.source_trader_id, r.rank)
  }

  const traders = [...byTrader.keys()]
  console.log(`Unique traders: ${traders.length}`)
  for (const t of traders) {
    console.log(`  ${t} (${handleMap.get(t)}) rank=${rankMap.get(t)}`)
  }

  // Build match map  
  const normToId = new Map()
  for (const tid of traders) {
    const handle = handleMap.get(tid) || ''
    normToId.set(tid, tid)
    normToId.set(normalize(tid), tid)
    normToId.set(tid.toLowerCase(), tid)
    // Also add handle variations
    normToId.set(normalize(handle), tid)
    normToId.set(handle.toLowerCase().trim(), tid)
    normToId.set('handle:' + handle.toLowerCase().trim(), tid)
    // For handles starting with /, strip it
    if (handle.startsWith('/')) {
      normToId.set(handle.slice(1).toLowerCase(), tid)
      normToId.set(normalize(handle.slice(1)), tid)
    }
    // alpha-only
    normToId.set(handle.toLowerCase().replace(/[^a-z0-9]/g, ''), tid)
  }
  
  const needSet = new Set(traders)
  const found = new Map()

  console.log('\nLaunching browser...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
    timeout: 60000,
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
  
  // Set timeout for navigation
  page.setDefaultNavigationTimeout(30000)

  console.log('Visiting bybit.com copyTrade...')
  try {
    await page.goto('https://www.bybit.com/copyTrade/traderRanking', { waitUntil: 'domcontentloaded', timeout: 40000 })
    await sleep(5000)
    console.log('Page loaded')
  } catch (e) {
    console.log('Warning:', e.message?.substring(0, 80))
  }

  const DURATIONS = [
    'DATA_DURATION_NINETY_DAY',
    'DATA_DURATION_THIRTY_DAY', 
    'DATA_DURATION_SEVEN_DAY',
  ]
  const SORTS = [
    'LEADER_SORT_FIELD_SORT_ROI',
    'LEADER_SORT_FIELD_FOLLOWER_COUNT',
    'LEADER_SORT_FIELD_SORT_PNL',
  ]
  const MAX_PAGES = 200

  // Phase 1: Use /x-api/ proxy (staying on copyTrade page) 
  console.log('\n=== PHASE 1: Proxy-based scan ===')
  
  outerLoop1: for (const duration of DURATIONS) {
    for (const sort of SORTS) {
      const remaining = [...needSet].filter(n => !found.has(n))
      if (!remaining.length) break outerLoop1
      
      console.log(`\n[${duration.replace('DATA_DURATION_','')} / ${sort.replace('LEADER_SORT_FIELD_','')}] need ${remaining.length}`)
      
      // Make sure we're on copyTrade page for /x-api/ to work
      await ensureOnCopyTrade(page)
      
      let proxyFails = 0
      for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
        const json = await fetchViaProxy(page, pageNo, duration, sort)
        
        if (!json || json.retCode !== 0) {
          proxyFails++
          if (proxyFails >= 5) {
            console.log(`  Proxy failed at page ${pageNo}, re-navigating`)
            await ensureOnCopyTrade(page)
            proxyFails = 0
            await sleep(2000)
            const json2 = await fetchViaProxy(page, pageNo, duration, sort)
            if (!json2 || json2.retCode !== 0) {
              console.log(`  Still failing, breaking`)
              break
            }
            const items2 = json2.result?.leaderDetails || []
            processItems(items2, needSet, found, normToId, handleMap)
            await sleep(150)
            continue
          }
          await sleep(500)
          continue
        }
        proxyFails = 0

        const items = json.result?.leaderDetails || []
        if (!items.length) {
          console.log(`  No more items at page ${pageNo}`)
          break
        }

        processItems(items, needSet, found, normToId, handleMap)
        await sleep(120)

        const stillNeeded = [...needSet].filter(n => !found.has(n))
        if (!stillNeeded.length) break

        if (pageNo % 50 === 0) {
          console.log(`  Page ${pageNo}: found=${found.size}/${needSet.size}, still need ${stillNeeded.length}`)
        }
      }
    }
  }

  console.log(`\nAfter Phase 1: found ${found.size}/${needSet.size}`)
  
  // Phase 2: Try rank-list endpoint for remaining
  const remaining2 = [...needSet].filter(n => !found.has(n))
  if (remaining2.length) {
    console.log(`\n=== PHASE 2: rank-list endpoint for ${remaining2.length} remaining ===`)
    
    for (const period of [90, 30, 7]) {
      const rem = [...needSet].filter(n => !found.has(n))
      if (!rem.length) break
      console.log(`\n[rank-list period=${period}D] need ${rem.length}`)
      
      for (let pageNo = 1; pageNo <= 100; pageNo++) {
        const json = await fetchRankList(page, pageNo, period)
        if (!json || json.retCode !== 0) {
          console.log(`  rank-list stopped at page ${pageNo}`)
          break
        }
        const items = json.result?.list || json.result?.leaderDetails || json.result?.rankList || []
        if (!items.length) { console.log(`  Empty at page ${pageNo}`); break }
        
        // Log structure on first page
        if (pageNo === 1) {
          console.log(`  First item keys: ${Object.keys(items[0]).join(', ')}`)
          console.log(`  Sample: ${JSON.stringify(items[0]).slice(0, 200)}`)
        }
        
        processItems(items, needSet, found, normToId, handleMap)
        await sleep(200)
        
        const stillNeeded = [...needSet].filter(n => !found.has(n))
        if (!stillNeeded.length) break
        if (pageNo % 20 === 0) console.log(`  Page ${pageNo}: found=${found.size}`)
      }
    }
    
    // After navigating with direct URLs, go back for proxy
    await ensureOnCopyTrade(page)
  }
  
  // Phase 3: Direct URL scan with page.goto for remaining
  const remaining3 = [...needSet].filter(n => !found.has(n))
  if (remaining3.length) {
    console.log(`\n=== PHASE 3: Direct API scan for ${remaining3.length} remaining ===`)
    
    outerLoop3: for (const duration of DURATIONS) {
      for (const sort of SORTS) {
        const rem = [...needSet].filter(n => !found.has(n))
        if (!rem.length) break outerLoop3
        console.log(`\n[Direct ${duration.replace('DATA_DURATION_','')} / ${sort.replace('LEADER_SORT_FIELD_','')}] need ${rem.length}`)
        
        for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
          const json = await fetchViaDirect(page, pageNo, duration, sort)
          if (!json || json.retCode !== 0) {
            console.log(`  Direct API failed at page ${pageNo}`)
            break
          }
          const items = json.result?.leaderDetails || []
          if (!items.length) { console.log(`  Empty at page ${pageNo}`); break }
          
          processItems(items, needSet, found, normToId, handleMap)
          await sleep(200)
          
          const stillNeeded = [...needSet].filter(n => !found.has(n))
          if (!stillNeeded.length) break
          if (pageNo % 50 === 0) console.log(`  Page ${pageNo}: found=${found.size}`)
        }
        
        // Re-navigate to copyTrade for next proxy round
        await ensureOnCopyTrade(page)
      }
    }
  }

  console.log(`\nBrowser scan done. Found ${found.size}/${needSet.size} traders`)
  
  const notFound = [...needSet].filter(n => !found.has(n))
  if (notFound.length) {
    console.log('NOT found:', notFound.map(n => `${n}(${handleMap.get(n)||'?'})`).join(', '))
  }

  await browser.close()
  console.log(`Browser closed. Elapsed: ${Math.round((Date.now()-startTime)/1000)}s`)

  // Update DB
  let totalUpdated = 0, noData = 0, apiErr = 0

  for (const [tid, { leaderUserId, leaderMark, nickName }] of found.entries()) {
    const rows = byTrader.get(tid) || []
    
    const result = await fetchLeaderIncome(leaderUserId, leaderMark)
    if (!result) {
      apiErr++
      console.log(`  ✗ No income data for ${tid} (uid=${leaderUserId}, nick="${nickName}")`)
      await sleep(300)
      continue
    }

    for (const row of rows) {
      const mdd = extractMDD(result, row.season_id)
      if (mdd === null) { noData++; console.log(`  ✗ No MDD for ${tid} season=${row.season_id}`); continue }
      const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: mdd }).eq('id', row.id)
      if (!error) {
        totalUpdated++
        console.log(`  ✓ ${tid} season=${row.season_id} mdd=${mdd}`)
      }
    }
    await sleep(200)
  }

  // Final count
  const { count } = await sb.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bybit')
    .is('max_drawdown', null)

  const elapsed = Math.round((Date.now() - startTime) / 1000)
  console.log(`\n=== DONE ===`)
  console.log(`Updated: ${totalUpdated} | noData: ${noData} | apiErr: ${apiErr} | notFound: ${notFound.length}`)
  console.log(`Remaining bybit null MDD rows: ${count}`)
  console.log(`Elapsed: ${elapsed}s`)
}

function processItems(items, needSet, found, normToId, handleMap) {
  for (const item of items) {
    const nick = item.nickName || item.traderName || item.name || ''
    const uid = String(item.leaderUserId || item.userId || item.uid || '')
    const mark = item.leaderMark || ''
    
    const match = tryMatchItem(nick, needSet, found, normToId)
    if (match) {
      found.set(match.tid, { leaderUserId: uid, leaderMark: mark, nickName: nick })
      const handle = handleMap.get(match.tid) || '?'
      console.log(`  ✓ Found ${match.tid}("${handle}") as "${nick}" uid=${uid} [${match.strategy}]`)
    }
  }
}

function tryMatchItem(nickName, needSet, found, normToId) {
  if (!nickName) return null
  const nick = nickName.trim()
  
  const candidates = [
    normalize(nick),
    nick.toLowerCase().trim(),
    nick.toLowerCase().replace(/[^a-z0-9]/g, ''),
    nick.toLowerCase().replace(/[.\`"''"]/g, '').replace(/\s+/g, '_').replace(/^_+|_+$/g, ''),
    nick.toLowerCase().replace(/\s+/g, '_'),
    'handle:' + nick.toLowerCase().trim(),
    nick.replace(/^\//, '').toLowerCase(),
  ]
  
  for (const c of candidates) {
    const tid = normToId.get(c)
    if (tid && needSet.has(tid) && !found.has(tid)) {
      return { tid, strategy: c }
    }
  }
  return null
}

main().catch(e => { console.error(e); process.exit(1) })
