#!/usr/bin/env node
/**
 * Fix bybit max_drawdown v4 - target remaining 26 rows
 * 
 * Uses page.evaluate() fetch (browser-side) to bypass WAF completely.
 * Scans deeper (200 pages) + tries multiple handle normalizations.
 * Falls back to leader-income by leaderMark when we find the trader.
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

// Multiple normalization strategies to match handles
function getCandidateNorms(handle) {
  if (!handle) return []
  const h = handle.trim()
  const norms = new Set()
  // Basic: lowercase + spaces→underscore
  norms.add(h.toLowerCase().replace(/\s+/g, '_'))
  // Remove special chars (., `, ", ', `)
  norms.add(h.toLowerCase().replace(/[.\`"'"]/g, '').replace(/\s+/g, '_'))
  // Replace all non-alphanumeric with underscore
  norms.add(h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
  // Just lowercase
  norms.add(h.toLowerCase())
  return [...norms].filter(n => n.length > 0)
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

async function fetchByUserId(userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { status, body } = await httpsGet(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderUserId=${encodeURIComponent(userId)}`
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

async function fetchByMark(leaderMark) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { status, body } = await httpsGet(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(leaderMark)}`
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
 * Fetch listing page from within browser context (avoids WAF)
 */
async function fetchListingPage(page, pageNo, dataDuration, sortField) {
  const url = `/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=100&dataDuration=${dataDuration}&sortField=${sortField}`
  try {
    const result = await page.evaluate(async (url) => {
      const res = await fetch(url, { 
        method: 'GET', 
        headers: { 'Accept': 'application/json' },
        credentials: 'include'
      })
      if (!res.ok) return null
      return res.json()
    }, url)
    return result
  } catch (e) {
    return null
  }
}

async function main() {
  console.log('=== Fix bybit max_drawdown v4 (remaining traders) ===')
  const startTime = Date.now()

  // Load all null MDD rows
  const { data: allRows, error } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, handle')
    .eq('source', 'bybit')
    .is('max_drawdown', null)
    .limit(200)

  if (error) { console.error('DB error:', error.message); process.exit(1) }
  console.log(`Null-MDD rows: ${allRows.length}`)
  if (!allRows.length) { console.log('Nothing to do!'); return }

  // Group by trader
  const byTrader = new Map()  // source_trader_id → rows[]
  const handleMap = new Map() // source_trader_id → handle
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
    handleMap.set(r.source_trader_id, r.handle)
  }

  const traders = [...byTrader.keys()]
  console.log(`Unique traders: ${traders.length}`)
  console.log('Traders:', traders)

  // Build a comprehensive match map: normalized_handle → source_trader_id
  // Multiple normalizations per handle
  const normToId = new Map()
  for (const tid of traders) {
    const handle = handleMap.get(tid) || ''
    // Primary: just use source_trader_id as-is (it IS the normalized form)
    normToId.set(tid, tid)
    // Also try normalizing the handle
    for (const norm of getCandidateNorms(handle)) {
      if (!normToId.has(norm)) normToId.set(norm, tid)
    }
  }
  
  const needSet = new Set(traders)
  const found = new Map() // source_trader_id → { leaderUserId, leaderMark }

  console.log('\nLaunching browser...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled']
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

  // Visit copy trading page to get full session
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

  outerLoop: for (const duration of DURATIONS) {
    for (const sort of SORTS) {
      const remaining = [...needSet].filter(n => !found.has(n))
      if (!remaining.length) break outerLoop
      
      console.log(`\n[${duration.replace('DATA_DURATION_','')} / ${sort.replace('LEADER_SORT_FIELD_','')}] need ${remaining.length}`)

      for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
        const json = await fetchListingPage(page, pageNo, duration, sort)
        
        if (!json || json.retCode !== 0) {
          // Try fallback with page.goto
          const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=100&dataDuration=${duration}&sortField=${sort}`
          try {
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
            if (resp?.status() === 200) {
              const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
              if (text && !text.startsWith('<')) {
                const json2 = JSON.parse(text)
                if (json2?.retCode === 0 && json2.result?.leaderDetails?.length) {
                  // re-process
                  processItems(json2.result.leaderDetails, needSet, found, normToId)
                  // Re-navigate to copyTrade for subsequent /x-api/ calls
                  await page.goto('https://www.bybit.com/copyTrade/traderRanking', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
                  await sleep(2000)
                }
              }
            }
          } catch (e2) {
            // ignore
          }
          if (pageNo > 5) { console.log(`  Stopped at page ${pageNo}`); break }
          continue
        }

        const items = json.result?.leaderDetails || []
        if (!items.length) {
          console.log(`  No more items at page ${pageNo}`)
          break
        }

        processItems(items, needSet, found, normToId)
        await sleep(100)

        const stillNeeded = [...needSet].filter(n => !found.has(n))
        if (!stillNeeded.length) break

        if (pageNo % 50 === 0) {
          console.log(`  Page ${pageNo}: found=${found.size}/${needSet.size}, still need ${stillNeeded.length}`)
        }
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

  // Update DB for found traders
  let totalUpdated = 0, noData = 0, apiErr = 0

  for (const [tid, { leaderUserId, leaderMark }] of found.entries()) {
    const rows = byTrader.get(tid) || []
    
    let result = null
    if (leaderUserId && leaderUserId !== '0') {
      result = await fetchByUserId(leaderUserId)
    }
    if (!result && leaderMark) {
      result = await fetchByMark(leaderMark)
    }
    
    if (!result) {
      apiErr++
      console.log(`  ✗ No income data for ${tid} (uid=${leaderUserId})`)
      await sleep(300)
      continue
    }

    for (const row of rows) {
      const mdd = extractMDD(result, row.season_id)
      if (mdd === null) { noData++; continue }
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
  console.log(`Updated: ${totalUpdated} | noData: ${noData} | apiErr: ${apiErr} | notFound in listing: ${notFound.length}`)
  console.log(`Remaining bybit null MDD rows: ${count}`)
  console.log(`Elapsed: ${elapsed}s`)
}

function processItems(items, needSet, found, normToId) {
  for (const item of items) {
    const nick = item.nickName || ''
    const uid = String(item.leaderUserId || '')
    const mark = item.leaderMark || ''
    
    // Try various normalizations of this listing item's nick
    const candidates = [
      nick.toLowerCase().replace(/\s+/g, '_'),          // standard
      nick.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''), // alphanum only
      nick.toLowerCase(),                                 // just lowercase
      nick.toLowerCase().replace(/[.\`"']/g, '').replace(/\s+/g, '_'), // remove special chars
    ]
    
    for (const norm of candidates) {
      const tid = normToId.get(norm)
      if (tid && needSet.has(tid) && !found.has(tid)) {
        found.set(tid, { leaderUserId: uid, leaderMark: mark, nickName: nick })
        console.log(`  ✓ Found ${tid} as "${nick}" (uid=${uid})`)
        break
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
