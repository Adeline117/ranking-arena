#!/usr/bin/env node
/**
 * Fix bybit_spot leaderboard_ranks max_drawdown (null rows)
 *
 * Root cause: previous scripts skipped DrawDownE4=0. Also the metricValues
 * approach skipped 0 values due to `metrics[1] ? ...` falsy check.
 *
 * Strategy:
 * 1. Puppeteer+stealth to bypass WAF (www.bybit.com/x-api/ is blocked to Node)
 * 2. Paginate dynamic-leader-list for 7D/30D/90D to collect uid→leaderMark mapping
 *    AND extract MDD from metricValues directly (for most traders)
 * 3. For traders not found in listing, try leader-income API with leaderMark
 * 4. KEY FIX: DrawDownE4=0 is treated as 0.0 (valid), not null
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

const LISTING_PATH = '/x-api/fapi/beehive/public/v1/common/dynamic-leader-list'
const PERIOD_MAP = {
  '7D':  'DATA_DURATION_SEVEN_DAY',
  '30D': 'DATA_DURATION_THIRTY_DAY',
  '90D': 'DATA_DURATION_NINETY_DAY',
}
const PERIOD_PREFIX = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }

/**
 * Parse percent string like "12.34%" or raw number like 1234 (E4 int)
 */
function parsePercent(s) {
  if (s == null) return null
  const str = String(s).replace(/,/g, '').trim()
  // If it looks like an E4 integer (no %)
  if (/^-?\d+$/.test(str)) {
    const n = parseInt(str)
    return isNaN(n) ? null : n / 100
  }
  const m = str.match(/^([+-]?\d+(?:\.\d+)?)%?$/)
  if (!m) return null
  return parseFloat(m[1])
}

/**
 * Extract MDD from leader-income result for a given season.
 * KEY FIX: 0 is valid (no drawdown in period), only null means missing.
 */
function extractMDDFromIncome(result, seasonId) {
  const pfx = PERIOD_PREFIX[seasonId]
  if (!pfx) return null
  const ddRaw = result[pfx + 'DrawDownE4']
  if (ddRaw == null || ddRaw === '') return null
  const ddE4 = parseInt(ddRaw)
  if (isNaN(ddE4)) return null
  return ddE4 / 100
}

async function evalFetch(page, url) {
  return page.evaluate(async (fetchUrl) => {
    try {
      const r = await fetch(fetchUrl)
      if (!r.ok) return { error: r.status }
      return await r.json()
    } catch (e) { return { error: e.message } }
  }, url)
}

async function main() {
  console.log('=== Fix bybit_spot max_drawdown (null rows) ===')

  // Load rows needing enrichment
  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, max_drawdown')
      .eq('source', 'bybit_spot')
      .is('max_drawdown', null)
      .range(from, from + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`Total bybit_spot rows with null max_drawdown: ${allRows.length}`)

  const needUids = new Set(allRows.map(r => r.source_trader_id))
  console.log(`Unique trader IDs needed: ${needUids.size}`)

  // Group rows by traderId for easy lookup
  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }

  // --- Launch Puppeteer ---
  console.log('Launching browser...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
  let page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  // Visit bybit.com first to get session cookies
  console.log('Visiting bybit.com for cookies...')
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)
    console.log('Page loaded')
  } catch (e) {
    console.log('Warning page load:', e.message?.substring(0, 80))
  }

  // --- Step 1: Paginate listing to collect uid→leaderMark AND listing MDD ---
  // enrichMap: uid|seasonId → { mdd, mark }
  const enrichMap = new Map()
  const uidToMark = new Map()

  console.log('\n📡 Step 1: Paginating listing API for leaderMark + MDD...')
  for (const [seasonId, duration] of Object.entries(PERIOD_MAP)) {
    console.log(`  Season ${seasonId}...`)
    let totalPages = 0, found = 0
    for (let pageNo = 1; pageNo <= 30; pageNo++) {
      const url = `${LISTING_PATH}?pageNo=${pageNo}&pageSize=50&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`
      const result = await page.evaluate(async (apiUrl) => {
        try { const r = await fetch(apiUrl); return await r.json() } catch (e) { return { error: e.message } }
      }, url)

      if (result?.error || result?.retCode !== 0) {
        console.log(`    Page ${pageNo}: error - ${result?.retMsg || result?.error}`)
        break
      }

      const items = result?.result?.leaderDetails || []
      if (!items.length) { console.log(`    Page ${pageNo}: empty, stopping`); break }
      totalPages++

      for (const item of items) {
        const uid = String(item.leaderUserId || '')
        if (!uid) continue
        const mark = item.leaderMark

        if (mark) uidToMark.set(uid, mark)

        // Extract MDD from metricValues: [ROI, MDD, followerProfit, WinRate, PLRatio, Sharpe]
        // metricValues[1] is the drawdown — could be "0%" or "12.34%" etc.
        const metrics = item.metricValues || []
        let mdd = null
        if (metrics[1] != null) {
          // parsePercent handles both "0%", "12.34%", empty string
          const parsed = parsePercent(metrics[1])
          // 0 is valid! Only null means truly missing
          mdd = parsed !== null ? Math.abs(parsed) : null
        }

        const key = `${uid}|${seasonId}`
        if (!enrichMap.has(key) && mdd !== null) {
          enrichMap.set(key, { mdd, uid, seasonId, mark })
          if (needUids.has(uid)) found++
        }
      }

      await sleep(600)
    }
    console.log(`    ${seasonId}: ${totalPages} pages, ${found} needed traders found in listing`)
  }

  console.log(`\nListing done: ${enrichMap.size} entries, ${uidToMark.size} uid→mark mappings`)

  // Traders still missing after listing scan
  const missingUids = [...needUids].filter(uid => {
    // Check if ALL seasons for this trader are covered
    return !Object.keys(PERIOD_MAP).every(s => enrichMap.has(`${uid}|${s}`))
  })
  console.log(`Traders not fully covered by listing: ${missingUids.length}`)

  // --- Step 2: Per-trader API for uncovered traders ---
  if (missingUids.length > 0) {
    console.log('\n📡 Step 2: Fetching per-trader leader-income for uncovered traders...')
    let fetched = 0, perTraderErr = 0

    // Refresh page before step 2
    try {
      await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await sleep(3000)
    } catch {}

    for (let i = 0; i < missingUids.length; i++) {
      const uid = missingUids[i]
      const mark = uidToMark.get(uid)

      if (!mark) {
        // No leaderMark found for this trader - can't call per-trader API
        continue
      }

      // Refresh browser every 100 traders to keep session fresh
      if (i > 0 && i % 100 === 0) {
        try {
          await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 20000 })
          await sleep(2000)
        } catch {}
      }

      try {
        const apiUrl = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(mark)}`
        const response = await Promise.race([
          evalFetch(page, apiUrl),
          sleep(12000).then(() => ({ error: 'timeout' }))
        ])

        if (response?.error || response?.retCode !== 0) {
          perTraderErr++
          await sleep(500)
          continue
        }

        const result = response.result
        fetched++

        // Store into enrichMap for each season
        for (const seasonId of Object.keys(PERIOD_MAP)) {
          const key = `${uid}|${seasonId}`
          if (!enrichMap.has(key)) {
            const mdd = extractMDDFromIncome(result, seasonId)
            if (mdd !== null) {
              enrichMap.set(key, { mdd, uid, seasonId, mark })
            }
          }
        }
      } catch (e) {
        perTraderErr++
      }

      await sleep(400)
      if ((i + 1) % 50 === 0) {
        console.log(`  [${i + 1}/${missingUids.length}] fetched=${fetched} err=${perTraderErr}`)
      }
    }
    console.log(`Step 2 done: fetched=${fetched} errors=${perTraderErr}`)
  }

  await browser.close()
  console.log('\nBrowser closed')

  // --- Step 3: Update DB ---
  console.log('\n📝 Step 3: Updating DB...')
  let updated = 0, noData = 0, zeroMDD = 0

  for (const row of allRows) {
    const key = `${row.source_trader_id}|${row.season_id}`
    const d = enrichMap.get(key)

    if (!d || d.mdd === null) {
      noData++
      continue
    }

    if (d.mdd === 0) zeroMDD++

    const { error } = await sb.from('leaderboard_ranks')
      .update({ max_drawdown: d.mdd })
      .eq('id', row.id)
    if (error) {
      console.log(`  ⚠ update id=${row.id}: ${error.message}`)
    } else {
      updated++
    }
  }

  console.log(`Updated: ${updated}`)
  console.log(`No data found: ${noData}`)
  console.log(`Rows set to 0% drawdown: ${zeroMDD}`)

  // Verify
  const { count } = await sb.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bybit_spot')
    .is('max_drawdown', null)
  console.log(`\nRemaining bybit_spot null MDD rows: ${count}`)
  console.log('=== Done ===')
}

main().catch(e => { console.error(e); process.exit(1) })
