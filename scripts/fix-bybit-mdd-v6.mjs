#!/usr/bin/env node
/**
 * Fix bybit max_drawdown v6 - call leader-income directly via browser
 * 
 * Key insight: The api2.bybit.com API is WAF-protected against direct Node.js calls.
 * But source_trader_id IS the leaderMark, so we can call leader-income?leaderMark=X
 * directly from within a Puppeteer browser context (bypasses WAF).
 *
 * If leaderMark returns no data, scan the leaderboard to find the leaderUserId
 * and try again via leaderUserId.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
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

/**
 * Call leader-income API via browser fetch (bypasses WAF)
 */
async function browserFetchLeaderIncome(page, param) {
  // param: "leaderMark=xxx" or "leaderUserId=xxx"
  const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?${param}`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await page.evaluate(async (url) => {
        try {
          const res = await fetch(url, { 
            headers: { 'Accept': 'application/json' },
            credentials: 'include'
          })
          if (!res.ok) return { error: 'http_' + res.status }
          const j = await res.json()
          return j
        } catch (e) {
          return { error: e.message }
        }
      }, url)
      
      if (result?.error) {
        if (result.error.includes('429') || result.error === 'http_429') {
          await sleep(3000 * (attempt + 1))
          continue
        }
        return null
      }
      if (result?.retCode !== 0) return null
      return result.result
    } catch (e) {
      if (attempt < 2) await sleep(1000)
    }
  }
  return null
}

/**
 * Fetch listing page via browser proxy
 */
async function browserFetchListingPage(page, pageNo, dataDuration, sortField) {
  const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=100&dataDuration=${dataDuration}&sortField=${sortField}`
  try {
    const result = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'include' })
        if (!res.ok) return null
        return res.json()
      } catch (e) { return null }
    }, url)
    return result
  } catch (e) {
    return null
  }
}

function normalize(s) {
  if (!s) return ''
  return s.trim().toLowerCase().replace(/[^a-z0-9\u0400-\u04ff]+/g, '_').replace(/^_+|_+$/g, '')
}

async function ensureOnBybit(page) {
  const url = page.url()
  if (!url.includes('bybit.com') || url.includes('api2.bybit.com')) {
    try {
      await page.goto('https://www.bybit.com/copyTrade/traderRanking', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await sleep(3000)
    } catch (e) {
      console.log('  Warning re-navigate:', e.message?.slice(0, 60))
    }
  }
}

async function main() {
  console.log('=== Fix bybit max_drawdown v6 ===')
  const startTime = Date.now()

  const { data: allRows, error } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, handle, rank')
    .eq('source', 'bybit')
    .is('max_drawdown', null)
    .limit(200)

  if (error) { console.error('DB error:', error.message); process.exit(1) }
  console.log(`Null-MDD rows: ${allRows.length}`)
  if (!allRows.length) { console.log('Nothing to do!'); return }

  const byTrader = new Map()
  const handleMap = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
    handleMap.set(r.source_trader_id, r.handle)
  }

  const traders = [...byTrader.keys()]
  console.log(`Unique traders: ${traders.length} - ${traders.join(', ')}`)

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
  page.setDefaultNavigationTimeout(30000)

  console.log('Visiting bybit.com to establish session...')
  try {
    await page.goto('https://www.bybit.com/copyTrade/traderRanking', { waitUntil: 'domcontentloaded', timeout: 40000 })
    await sleep(5000)
    console.log('Page loaded:', await page.title().catch(() => '?'))
  } catch (e) {
    console.log('Warning:', e.message?.substring(0, 80))
  }

  // PHASE 1: Try leader-income API directly with leaderMark = source_trader_id
  console.log('\n=== PHASE 1: Direct leader-income by leaderMark ===')
  
  const phase1Results = new Map() // tid → { result, rows }
  const phase1Failed = []
  
  for (const tid of traders) {
    const rows = byTrader.get(tid) || []
    const handle = handleMap.get(tid) || tid
    
    console.log(`\n[${tid} / "${handle}"]`)
    
    // Try several leaderMark candidates
    const markCandidates = [
      tid,                            // normalized: architect, cn, ru, etc.
      handle,                         // original handle: Architect, CN, RU
      handle.toLowerCase(),           // cn, ru
      // For handles with special chars
      tid.replace(/^_+/, ''),         // strip leading underscores: _250 → 250
      tid.replace(/^_+|_+$/g, ''),    // strip all leading/trailing _
    ]
    
    let result = null
    let usedMark = null
    
    for (const mark of [...new Set(markCandidates)]) {
      if (!mark) continue
      const r = await browserFetchLeaderIncome(page, `leaderMark=${encodeURIComponent(mark)}`)
      if (r) {
        result = r
        usedMark = mark
        console.log(`  ✓ leaderMark="${mark}" → got data`)
        break
      } else {
        console.log(`  ✗ leaderMark="${mark}" → no data`)
      }
      await sleep(300)
    }
    
    if (!result) {
      phase1Failed.push(tid)
    } else {
      phase1Results.set(tid, { result, rows })
    }
    
    await sleep(500)
  }
  
  console.log(`\nPhase 1: ${phase1Results.size} succeeded, ${phase1Failed.length} failed`)
  if (phase1Failed.length) {
    console.log('Failed:', phase1Failed.join(', '))
  }
  
  // PHASE 2: For failed ones, scan leaderboard to find leaderUserId
  let phase2Results = new Map()
  
  if (phase1Failed.length) {
    console.log(`\n=== PHASE 2: Scan leaderboard for ${phase1Failed.length} traders ===`)
    
    const needSet = new Set(phase1Failed)
    const found = new Map() // tid → { leaderUserId, leaderMark, nickName }
    
    // Build normToId map
    const normToId = new Map()
    for (const tid of phase1Failed) {
      const handle = handleMap.get(tid) || ''
      normToId.set(tid, tid)
      normToId.set(normalize(tid), tid)
      normToId.set(tid.toLowerCase(), tid)
      normToId.set(normalize(handle), tid)
      normToId.set(handle.toLowerCase().trim(), tid)
      if (handle.startsWith('/')) {
        normToId.set(handle.slice(1).toLowerCase(), tid)
        normToId.set(normalize(handle.slice(1)), tid)
      }
      normToId.set(handle.toLowerCase().replace(/[^a-z0-9]/g, ''), tid)
      normToId.set(tid.replace(/^_+/, ''), tid) // strip leading underscores
    }
    
    // Make sure we're on bybit.com
    await ensureOnBybit(page)
    
    const DURATIONS = ['DATA_DURATION_NINETY_DAY', 'DATA_DURATION_THIRTY_DAY', 'DATA_DURATION_SEVEN_DAY']
    const SORTS = ['LEADER_SORT_FIELD_SORT_ROI', 'LEADER_SORT_FIELD_FOLLOWER_COUNT', 'LEADER_SORT_FIELD_SORT_PNL']
    
    outer: for (const duration of DURATIONS) {
      for (const sort of SORTS) {
        const rem = [...needSet].filter(n => !found.has(n))
        if (!rem.length) break outer
        
        console.log(`\n[${duration.replace('DATA_DURATION_','')} / ${sort.replace('LEADER_SORT_FIELD_','')}] need ${rem.length}`)
        
        // Make sure session is good
        await ensureOnBybit(page)
        
        for (let pageNo = 1; pageNo <= 200; pageNo++) {
          const json = await browserFetchListingPage(page, pageNo, duration, sort)
          
          if (!json || json.retCode !== 0) {
            if (pageNo <= 2) {
              // Re-init session and retry
              await ensureOnBybit(page)
              await sleep(2000)
              const json2 = await browserFetchListingPage(page, pageNo, duration, sort)
              if (!json2 || json2.retCode !== 0) { console.log(`  API failed at page ${pageNo}`); break }
              processItems(json2.result?.leaderDetails || [], needSet, found, normToId, handleMap)
              continue
            }
            console.log(`  API failed at page ${pageNo}`)
            break
          }
          
          const items = json.result?.leaderDetails || []
          if (!items.length) { console.log(`  Empty at page ${pageNo}`); break }
          
          processItems(items, needSet, found, normToId, handleMap)
          await sleep(100)
          
          const stillNeed = [...needSet].filter(n => !found.has(n))
          if (!stillNeed.length) break
          if (pageNo % 50 === 0) console.log(`  Page ${pageNo}: found=${found.size}/${needSet.size}`)
        }
      }
    }
    
    console.log(`\nScan done. Found ${found.size}/${needSet.size}`)
    const notFound = [...needSet].filter(n => !found.has(n))
    if (notFound.length) {
      console.log('NOT found in listing:', notFound.map(n => `${n}(${handleMap.get(n)||'?'})`).join(', '))
    }
    
    // Now fetch leader-income by userId for found traders
    for (const [tid, { leaderUserId, leaderMark, nickName }] of found.entries()) {
      const rows = byTrader.get(tid) || []
      console.log(`\nFetching income for ${tid} (uid=${leaderUserId}, nick="${nickName}")`)
      
      let result = null
      if (leaderUserId && leaderUserId !== '0') {
        result = await browserFetchLeaderIncome(page, `leaderUserId=${encodeURIComponent(leaderUserId)}`)
      }
      if (!result && leaderMark) {
        result = await browserFetchLeaderIncome(page, `leaderMark=${encodeURIComponent(leaderMark)}`)
      }
      
      if (result) {
        phase2Results.set(tid, { result, rows })
        console.log(`  ✓ Got income data`)
      } else {
        console.log(`  ✗ No income data`)
      }
      await sleep(400)
    }
  }

  await browser.close()
  console.log(`\nBrowser closed. Elapsed: ${Math.round((Date.now()-startTime)/1000)}s`)

  // Update DB
  let totalUpdated = 0, noData = 0
  
  const allResults = new Map([...phase1Results, ...phase2Results])
  
  for (const [tid, { result, rows }] of allResults.entries()) {
    for (const row of rows) {
      const mdd = extractMDD(result, row.season_id)
      if (mdd === null) {
        noData++
        // Check what's actually in the result for debug
        const pfx = PERIOD_PREFIX[row.season_id]
        const ddRaw = pfx ? result?.[pfx + 'DrawDownE4'] : undefined
        console.log(`  ✗ ${tid} season=${row.season_id} ddRaw=${ddRaw} (no MDD extracted)`)
        continue
      }
      const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: mdd }).eq('id', row.id)
      if (!error) {
        totalUpdated++
        console.log(`  ✓ ${tid} season=${row.season_id} mdd=${mdd}`)
      } else {
        console.log(`  ✗ DB update failed for ${tid}:`, error.message)
      }
    }
  }

  // Final count
  const { count } = await sb.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bybit')
    .is('max_drawdown', null)

  const elapsed = Math.round((Date.now() - startTime) / 1000)
  console.log(`\n=== DONE ===`)
  console.log(`Updated: ${totalUpdated} | noData: ${noData}`)
  console.log(`Remaining bybit null MDD rows: ${count}`)
  console.log(`Elapsed: ${elapsed}s`)
  
  return count
}

function processItems(items, needSet, found, normToId, handleMap) {
  for (const item of items) {
    const nick = item.nickName || ''
    const uid = String(item.leaderUserId || '')
    const mark = item.leaderMark || ''
    
    const match = tryMatch(nick, needSet, found, normToId)
    if (match) {
      found.set(match.tid, { leaderUserId: uid, leaderMark: mark, nickName: nick })
      const handle = handleMap?.get(match.tid) || '?'
      console.log(`    ✓ Match: ${match.tid}("${handle}") as "${nick}" uid=${uid} [${match.strategy}]`)
    }
  }
}

function tryMatch(nickName, needSet, found, normToId) {
  if (!nickName) return null
  const nick = nickName.trim()
  
  const candidates = [
    normalize(nick),
    nick.toLowerCase().trim(),
    nick.toLowerCase().replace(/[^a-z0-9]/g, ''),
    nick.toLowerCase().replace(/[.\`"''"]/g, '').replace(/\s+/g, '_').replace(/^_+|_+$/g, ''),
    nick.toLowerCase().replace(/\s+/g, '_'),
    nick.replace(/^\//, '').toLowerCase(),
    nick.replace(/^\//, '').toLowerCase().replace(/\s+/g, '_'),
  ]
  
  for (const c of candidates) {
    if (!c) continue
    const tid = normToId.get(c)
    if (tid && needSet.has(tid) && !found.has(tid)) {
      return { tid, strategy: c }
    }
  }
  return null
}

main().catch(e => { console.error(e); process.exit(1) })
