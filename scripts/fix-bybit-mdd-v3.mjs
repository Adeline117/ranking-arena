#!/usr/bin/env node
/**
 * Fix bybit leaderboard_ranks max_drawdown - v3
 * 
 * Strategy for username-format source_trader_ids:
 *   1. Use Puppeteer to scan listing (WAF protected - needs browser)
 *   2. Match nickName→leaderUserId by normalizing: nick.toLowerCase().replace(/\s+/g,'_')
 *   3. Use leaderUserId to call leader-income via direct HTTPS (no WAF)
 *   4. Update DB
 * 
 * Optimizations over v2:
 *   - pageSize=100 (halves number of page fetches)
 *   - Stop scanning when all traders found
 *   - Use leaderUserId (not leaderMark) for income calls → more reliable
 *   - Scan most promising combos first (90D+ROI covers widest trader set)
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

function normalizeNick(nick) {
  return nick.toLowerCase().replace(/\s+/g, '_')
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
 * Scan Bybit listing via Puppeteer browser navigation to find leaderUserId for each trader
 * Returns Map<normalizedNick → { leaderUserId, leaderMark }>
 */
async function scanListing(page, needSet) {
  const found = new Map() // normalizedNick → { leaderUserId, leaderMark, nickName }
  
  const LIST_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list'
  const COMBOS = [
    { duration: 'DATA_DURATION_NINETY_DAY', sort: 'LEADER_SORT_FIELD_SORT_ROI' },
    { duration: 'DATA_DURATION_THIRTY_DAY', sort: 'LEADER_SORT_FIELD_SORT_ROI' },
    { duration: 'DATA_DURATION_SEVEN_DAY', sort: 'LEADER_SORT_FIELD_SORT_ROI' },
    { duration: 'DATA_DURATION_NINETY_DAY', sort: 'LEADER_SORT_FIELD_FOLLOWER_COUNT' },
    { duration: 'DATA_DURATION_THIRTY_DAY', sort: 'LEADER_SORT_FIELD_FOLLOWER_COUNT' },
    { duration: 'DATA_DURATION_SEVEN_DAY', sort: 'LEADER_SORT_FIELD_FOLLOWER_COUNT' },
    // Extra: try PNL sort
    { duration: 'DATA_DURATION_NINETY_DAY', sort: 'LEADER_SORT_FIELD_SORT_PNL' },
    { duration: 'DATA_DURATION_THIRTY_DAY', sort: 'LEADER_SORT_FIELD_SORT_PNL' },
    { duration: 'DATA_DURATION_SEVEN_DAY', sort: 'LEADER_SORT_FIELD_SORT_PNL' },
  ]
  const MAX_PAGES = 80

  async function navFetch(url) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
      if (resp?.status() !== 200) return null
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
      if (!text || text.startsWith('<') || text.length < 20) return null
      return JSON.parse(text)
    } catch { return null }
  }

  for (const { duration, sort } of COMBOS) {
    const remaining = [...needSet].filter(n => !found.has(n))
    if (!remaining.length) {
      console.log('  All traders found! Stopping scan.')
      break
    }
    
    console.log(`\n  [${duration.replace('DATA_DURATION_', '')} / ${sort.replace('LEADER_SORT_FIELD_', '')}] Still need ${remaining.length} traders`)

    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const url = `${LIST_URL}?pageNo=${pageNo}&pageSize=100&dataDuration=${duration}&sortField=${sort}`
      const json = await navFetch(url)
      
      if (!json || json.retCode !== 0) {
        if (pageNo === 1) console.log(`    Page 1 failed (retCode=${json?.retCode})`)
        else console.log(`    Stopped at page ${pageNo}`)
        break
      }

      const items = json.result?.leaderDetails || []
      if (!items.length) break

      let newFound = 0
      for (const item of items) {
        const nick = item.nickName || ''
        const norm = normalizeNick(nick)
        const uid = String(item.leaderUserId || '')
        const mark = item.leaderMark || ''

        if (needSet.has(norm) && !found.has(norm)) {
          found.set(norm, { leaderUserId: uid, leaderMark: mark, nickName: nick })
          newFound++
          console.log(`    ✓ Found ${norm} (uid=${uid})`)
        }
      }

      await sleep(150)

      const stillNeeded = [...needSet].filter(n => !found.has(n))
      if (!stillNeeded.length) break
      
      if (pageNo % 20 === 0) {
        console.log(`    Page ${pageNo}: found=${found.size}/${needSet.size}, remaining=${stillNeeded.length}`)
      }
    }
  }

  const notFound = [...needSet].filter(n => !found.has(n))
  console.log(`\nListing scan complete: found ${found.size}/${needSet.size}`)
  if (notFound.length) {
    console.log(`NOT found: ${notFound.join(', ')}`)
  }
  
  return found
}

async function main() {
  console.log('=== Fix bybit max_drawdown v3 ===')
  const startTime = Date.now()

  // Load all null MDD rows
  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('leaderboard_ranks')
      .select('id, source_trader_id, season_id')
      .eq('source', 'bybit')
      .is('max_drawdown', null)
      .range(from, from + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`Total bybit null-MDD rows: ${allRows.length}`)
  if (!allRows.length) { console.log('Nothing to do!'); return }

  // Group by trader (normalized source_trader_id)
  const byTrader = new Map()
  for (const r of allRows) {
    const key = r.source_trader_id
    if (!byTrader.has(key)) byTrader.set(key, [])
    byTrader.get(key).push(r)
  }

  // Separate numeric vs username
  const numericTraders = [...byTrader.keys()].filter(id => /^\d+$/.test(id))
  const usernameTraders = [...byTrader.keys()].filter(id => !/^\d+$/.test(id))
  console.log(`Numeric ID traders: ${numericTraders.length}`)
  console.log(`Username traders: ${usernameTraders.length}`)

  let totalUpdated = 0

  // === Phase 1: Numeric IDs (direct HTTPS, no browser) ===
  if (numericTraders.length > 0) {
    console.log('\n=== Phase 1: Numeric leaderUserId ===')
    for (const traderId of numericTraders) {
      const result = await fetchByUserId(traderId)
      if (!result) { console.log(`  ✗ No data for userId=${traderId}`); await sleep(400); continue }
      for (const row of byTrader.get(traderId) || []) {
        const mdd = extractMDD(result, row.season_id)
        if (mdd === null) continue
        const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: mdd }).eq('id', row.id)
        if (!error) { console.log(`  ✓ userId=${traderId} season=${row.season_id} mdd=${mdd}`); totalUpdated++ }
      }
      await sleep(300)
    }
  }

  // === Phase 2: Username traders via listing scan ===
  if (usernameTraders.length > 0) {
    console.log('\n=== Phase 2: Username traders (Puppeteer listing scan) ===')
    console.log(`Need to find ${usernameTraders.length} traders`)

    const needSet = new Set(usernameTraders)

    console.log('Launching browser...')
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
             '--disable-blink-features=AutomationControlled']
    })
    const page = await browser.newPage()
    await page.setUserAgent(UA)
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

    // Get initial cookies
    console.log('Visiting bybit.com...')
    try {
      await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await sleep(4000)
      console.log('Initial page loaded')
    } catch (e) {
      console.log('Warning:', e.message?.substring(0, 80))
    }

    const found = await scanListing(page, needSet)
    await browser.close()
    console.log(`Browser closed. Elapsed: ${Math.round((Date.now() - startTime)/1000)}s`)

    // Fetch income data for found traders
    console.log(`\n=== Fetching leader-income for ${found.size} resolved traders ===`)
    let phase2Updated = 0, phase2NoData = 0, phase2Err = 0

    for (const [norm, { leaderUserId, leaderMark, nickName }] of found.entries()) {
      const rows = byTrader.get(norm) || []
      
      // Try leaderUserId first (more reliable), fallback to leaderMark
      let result = null
      if (leaderUserId && leaderUserId !== '0') {
        result = await fetchByUserId(leaderUserId)
      }
      if (!result && leaderMark) {
        result = await fetchByMark(leaderMark)
      }
      
      if (!result) {
        phase2Err++
        console.log(`  ✗ No income data for ${norm} (uid=${leaderUserId})`)
        await sleep(400)
        continue
      }

      for (const row of rows) {
        const mdd = extractMDD(result, row.season_id)
        if (mdd === null) {
          phase2NoData++
          continue
        }
        const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: mdd }).eq('id', row.id)
        if (!error) {
          phase2Updated++
          totalUpdated++
          console.log(`  ✓ ${norm} season=${row.season_id} mdd=${mdd}`)
        } else {
          console.log(`  ⚠ DB error for id=${row.id}: ${error.message}`)
        }
      }
      await sleep(250)
    }

    console.log(`Phase 2: updated=${phase2Updated} noData=${phase2NoData} apiErr=${phase2Err} notFound=${needSet.size - found.size}`)
  }

  // Final count
  const { count } = await sb.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bybit')
    .is('max_drawdown', null)

  const elapsed = Math.round((Date.now() - startTime) / 1000)
  console.log(`\n=== DONE ===`)
  console.log(`Total updated: ${totalUpdated}`)
  console.log(`Remaining bybit null MDD rows: ${count}`)
  console.log(`Elapsed: ${elapsed}s`)
}

main().catch(e => { console.error(e); process.exit(1) })
