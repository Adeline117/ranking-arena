#!/usr/bin/env node
/**
 * BingX MDD Fix v4
 *
 * Key insight: BingX uses signed/time-bound request tokens so manual page.evaluate 
 * fetch calls fail with code=100005. Instead we navigate to individual trader 
 * detail pages and intercept the natural API responses.
 *
 * Strategy:
 * 1. Load BingX copytrading page, intercept all traders from initial responses
 * 2. For each missing UID → navigate to tradeDetail/{uid}, intercept API
 * 3. For bingx_spot → navigate to spot page, then spotTradeDetail/{uid}
 * 4. Update DB with real values only
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { writeFileSync, appendFileSync } from 'fs'
import { execSync } from 'child_process'

config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')
const LOG_FILE = '/tmp/fix-bingx-mdd-v4.log'

function log(...args) {
  const msg = args.join(' ')
  console.log(msg)
  appendFileSync(LOG_FILE, msg + '\n')
}
writeFileSync(LOG_FILE, `=== BingX MDD Fix v4 === ${new Date().toISOString()}\n`)

// ─── Parsers ─────────────────────────────────────────────────────────────────
function parseWR(v) {
  if (v == null || v === '--' || v === '') return null
  const f = parseFloat(String(v).replace('%', '').trim())
  if (isNaN(f)) return null
  if (f > 0 && f <= 1) return Math.round(f * 10000) / 100
  return Math.round(f * 100) / 100
}

function parseMDD(v) {
  if (v == null || v === '--' || v === '') return null
  const s = String(v).replace('%', '').trim()
  const f = parseFloat(s.replace('-', ''))
  if (isNaN(f)) return null
  const abs = Math.abs(f)
  if (abs === 0) return null
  if (abs <= 1) return Math.round(abs * 10000) / 100
  return Math.round(abs * 100) / 100
}

function calcMddFromChart(chart) {
  if (!Array.isArray(chart) || chart.length < 2) return null
  const equities = chart.map(p => {
    const rate = parseFloat(p.cumulativePnlRate ?? p.pnlRate ?? p.rate ?? p.value ?? 0)
    return 1 + (isNaN(rate) ? 0 : rate)
  })
  let peak = equities[0], maxDD = 0
  for (const eq of equities) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = (peak - eq) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  return maxDD > 0.0001 ? Math.round(maxDD * 10000) / 100 : null
}

function extractStats(obj) {
  if (!obj) return {}
  
  const wr = parseWR(
    obj.winRate90d ?? obj.winRate ?? obj.win_rate ?? obj.winRate30d ?? obj.winRate180d
  )
  
  const mddCandidates = [
    obj.maxDrawDown90d, obj.maxDrawdown90d, obj.maximumDrawDown90d,
    obj.maxDrawDown, obj.maxDrawdown, obj.maximumDrawDown,
    obj.maxDrawDown30d, obj.maxDrawDown7d, obj.maxDrawDown180d,
    obj.mdd, obj.drawdown, obj.maxDD,
  ]
  let mdd = null
  for (const c of mddCandidates) {
    const m = parseMDD(c)
    if (m != null) { mdd = m; break }
  }
  if (mdd == null) {
    const chartData = obj.chart || obj.pnlChart || obj.equityChart || obj.chartData || obj.historyList
    mdd = calcMddFromChart(chartData)
  }
  
  const tc = obj.totalTransactions != null ? parseInt(obj.totalTransactions) :
             obj.totalOrders != null ? parseInt(obj.totalOrders) :
             obj.tradeCnt != null ? parseInt(obj.tradeCnt) : null
  return { wr, mdd, tc }
}

// Deep-search for MDD in any JSON object
function deepSearchMDD(obj, depth = 0) {
  if (!obj || depth > 6 || typeof obj !== 'object') return null
  const { mdd } = extractStats(obj)
  if (mdd != null) return mdd
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      const m = calcMddFromChart(val)
      if (m != null) return m
      for (const item of val) {
        const m2 = deepSearchMDD(item, depth + 1)
        if (m2 != null) return m2
      }
    } else if (val && typeof val === 'object') {
      const m = deepSearchMDD(val, depth + 1)
      if (m != null) return m
    }
  }
  return null
}

function processListItem(item, map) {
  if (!item) return
  const trader = item.trader || item.traderInfo || {}
  const uid = String(trader.uid || trader.uniqueId || trader.traderId || item.uid || item.traderId || '')
  const nick = trader.nickName || trader.nickname || trader.traderName || trader.name || item.nickName || ''

  const stat = item.rankStat || item.stat || item.traderStat || {}
  const { wr, mdd, tc } = extractStats(stat)
  if (wr == null && mdd == null) return

  const entry = { uid, nick, wr, mdd, tc }
  if (uid && uid !== '0') map.set(uid, entry)
  if (nick) {
    const slug = nick.toLowerCase().trim()
      .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    if (slug) map.set(slug, entry)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('\n🚀 BingX MDD Fix v4')
  if (DRY_RUN) log('   [DRY RUN]')
  log('')

  // Fetch rows needing update
  const { data: bingxRows } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bingx')
    .is('max_drawdown', null)
  
  const { data: spotRows } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bingx_spot')
    .or('max_drawdown.is.null,win_rate.is.null')

  const bingxUIDs = [...new Set((bingxRows || []).map(r => r.source_trader_id))]
  log(`bingx MDD null: ${bingxRows.length} rows, ${bingxUIDs.length} unique UIDs`)
  log(`bingx_spot null: ${spotRows.length} rows, ${[...new Set(spotRows.map(r => r.source_trader_id))].length} unique IDs`)

  // ── Launch browser ───────────────────────────────────────────────────────────
  log('\n🎭 Launching Playwright (headless)...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox',
           '--disable-blink-features=AutomationControlled',
           '--disable-web-security', '--disable-features=IsolateOrigins']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} }
  })

  const futuresMap = new Map() // uid/nick-slug → { uid, nick, wr, mdd, tc }
  const spotMap = new Map()

  // Helper to set up response interception on a page
  function setupInterception(page, map, type = 'futures') {
    page.on('response', async resp => {
      const url = resp.url()
      if (!url.includes('bingx') && !url.includes('qq-os.com') && !url.includes('copytrading')) return
      const ct = resp.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      try {
        const json = await resp.json().catch(() => null)
        if (!json) return

        // List responses
        const items = json?.data?.result || json?.data?.list || json?.data?.records ||
                      json?.data?.traders || (Array.isArray(json?.data) ? json.data : [])
        for (const item of items) {
          processListItem(item, map)
        }

        // Single trader detail response
        const d = json?.data
        if (d && typeof d === 'object' && !Array.isArray(d) && !d.result && !d.list) {
          const trader = d.trader || d.traderInfo || {}
          const uid = String(trader.uid || trader.uniqueId || d.uid || d.traderId || '')
          const nick = trader.nickName || trader.nickname || d.nickName || ''
          const stat = d.rankStat || d.stat || d.traderStat || d.statInfo || d
          const { wr, mdd, tc } = extractStats(stat)
          
          // Also try deep search if still no MDD
          const deepMdd = mdd ?? deepSearchMDD(d)
          
          if (uid && uid !== '0' && (wr != null || deepMdd != null)) {
            const entry = { uid, nick, wr, mdd: deepMdd, tc }
            map.set(uid, entry)
            if (nick) {
              const slug = nick.toLowerCase().trim()
                .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
              if (slug) map.set(slug, entry)
            }
          }
        }
      } catch {}
    })
  }

  // ── Phase 1: Futures main page (natural page load + scroll) ───────────────
  log('\n📡 Phase 1: BingX Futures copytrading page...')
  const mainPage = await ctx.newPage()
  setupInterception(mainPage, futuresMap, 'futures')

  await mainPage.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => log('  ⚠ Page load timeout, continuing'))
  await sleep(5000)
  log(`  After load: ${futuresMap.size} traders collected`)

  // Scroll to trigger more natural loads
  for (let i = 0; i < 8; i++) {
    await mainPage.evaluate(() => window.scrollBy(0, 1000))
    await sleep(1500)
  }
  log(`  After scroll: ${futuresMap.size} traders collected`)

  // Try clicking sort tabs to get different trader sets
  for (const tabText of ['By PnL', 'By Win Rate', 'By Followers', 'Followed', '7D', '30D', '90D', '180D', 'All']) {
    try {
      const el = mainPage.locator(`text="${tabText}"`).first()
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click().catch(() => {})
        await sleep(2500)
        log(`  Tab "${tabText}": ${futuresMap.size} traders`)
      }
    } catch {}
  }

  // Check missing after main page
  let missingBingx = bingxUIDs.filter(uid => !futuresMap.has(uid) || futuresMap.get(uid)?.mdd == null)
  log(`\n  Missing after main page: ${missingBingx.length}/${bingxUIDs.length}`)
  if (missingBingx.length > 0 && missingBingx.length <= 10) {
    log(`  Missing UIDs: ${missingBingx.join(', ')}`)
  }

  // ── Phase 2: Individual trader detail pages ────────────────────────────────
  log(`\n🔍 Phase 2: Visiting ${missingBingx.length} individual trader detail pages...`)

  for (let i = 0; i < missingBingx.length; i++) {
    const uid = missingBingx[i]
    const handle = bingxRows.find(r => r.source_trader_id === uid)?.handle || uid

    log(`  [${i + 1}/${missingBingx.length}] UID ${uid} ("${handle}")`)

    const detailPage = await ctx.newPage()
    setupInterception(detailPage, futuresMap, 'futures')

    let resolved = false
    // Wait for MDD to appear in map
    const checkInterval = setInterval(() => {
      const d = futuresMap.get(uid)
      if (d?.mdd != null) resolved = true
    }, 500)

    const detailUrl = `https://bingx.com/en/copytrading/tradeDetail/${uid}`
    await detailPage.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
    await sleep(3000)

    // If not found yet, try scrolling/clicking tabs on detail page
    if (!resolved && !futuresMap.get(uid)?.mdd) {
      // Check for time period selector tabs
      for (const tab of ['90D', '30D', '7D', '180D']) {
        try {
          const el = detailPage.locator(`text="${tab}"`).first()
          if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
            await el.click().catch(() => {})
            await sleep(1500)
          }
        } catch {}
      }
      await sleep(1500)
    }

    clearInterval(checkInterval)

    const d = futuresMap.get(uid)
    if (d?.mdd != null) {
      log(`    ✅ MDD=${d.mdd} WR=${d.wr}`)
    } else {
      log(`    ✗ No MDD found`)
    }

    await detailPage.close()
    await sleep(500)
  }

  // ── Phase 3: BingX Spot ───────────────────────────────────────────────────
  log('\n\n📡 Phase 3: BingX Spot copy trading page...')
  const spotPage = await ctx.newPage()
  setupInterception(spotPage, spotMap, 'spot')

  await spotPage.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => log('  ⚠ Spot page timeout'))
  await sleep(5000)
  log(`  After load: ${spotMap.size} spot traders`)

  // Scroll to load more
  for (let i = 0; i < 8; i++) {
    await spotPage.evaluate(() => window.scrollBy(0, 1000))
    await sleep(1500)
  }
  log(`  After scroll: ${spotMap.size} spot traders`)

  // Click tabs
  for (const tabText of ['By PnL', 'By Win Rate', 'By Followers', '7D', '30D', '90D', '180D']) {
    try {
      const el = spotPage.locator(`text="${tabText}"`).first()
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
        await el.click().catch(() => {})
        await sleep(2500)
        log(`  Tab "${tabText}": ${spotMap.size} spot traders`)
      }
    } catch {}
  }

  // Find still missing spot traders
  const missingSpot = spotRows.filter(r => {
    const tid = r.source_trader_id
    const slug = (r.handle || '').toLowerCase().trim()
      .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    const d = spotMap.get(tid) || spotMap.get(slug)
    return !d || (r.max_drawdown == null && d.mdd == null)
  })
  const uniqueMissingSpot = [...new Map(missingSpot.map(r => [r.source_trader_id, r])).values()]
  log(`\n  Still missing MDD: ${uniqueMissingSpot.length} spot traders`)

  // ── Phase 4: Individual spot trader detail pages ───────────────────────────
  if (uniqueMissingSpot.length > 0) {
    log(`\n🔍 Phase 4: Visiting ${uniqueMissingSpot.length} spot trader detail pages...`)

    for (let i = 0; i < uniqueMissingSpot.length; i++) {
      const row = uniqueMissingSpot[i]
      const tid = row.source_trader_id
      const slug = (row.handle || '').toLowerCase().trim()
        .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)

      log(`  [${i + 1}/${uniqueMissingSpot.length}] "${row.handle}" (id: ${tid})`)

      const detailPage = await ctx.newPage()
      setupInterception(detailPage, spotMap, 'spot')

      // Try different spot detail URL formats
      const urls = [
        `https://bingx.com/en/CopyTrading/spotTradeDetail/${tid}`,
        `https://bingx.com/en/copytrading/spotTradeDetail/${tid}`,
        `https://bingx.com/en/CopyTrading/detail/${tid}`,
      ]

      for (const url of urls) {
        const d = spotMap.get(tid) || spotMap.get(slug)
        if (d?.mdd != null) break
        await detailPage.goto(url, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {})
        await sleep(2500)
        // Try clicking time period tabs
        for (const tab of ['90D', '30D', '7D']) {
          try {
            const el = detailPage.locator(`text="${tab}"`).first()
            if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
              await el.click().catch(() => {})
              await sleep(1200)
            }
          } catch {}
        }
      }

      const d = spotMap.get(tid) || spotMap.get(slug)
      if (d?.mdd != null) {
        log(`    ✅ MDD=${d.mdd} WR=${d.wr}`)
      } else {
        log(`    ✗ No MDD found`)
      }

      await detailPage.close()
      await sleep(500)
    }
  }

  await browser.close()
  log('\n✅ Browser closed')
  log(`  futuresMap: ${futuresMap.size} entries`)
  log(`  spotMap: ${spotMap.size} entries`)

  // Check what we found for bingx
  const foundBingx = bingxUIDs.filter(uid => futuresMap.get(uid)?.mdd != null)
  log(`  bingx MDD found: ${foundBingx.length}/${bingxUIDs.length}`)
  for (const uid of foundBingx) {
    const d = futuresMap.get(uid)
    log(`    ${uid}: MDD=${d.mdd} WR=${d.wr}`)
  }

  // Check spot
  const foundSpot = spotRows.filter(r => {
    const tid = r.source_trader_id
    const slug = (r.handle || '').toLowerCase().trim()
      .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    return spotMap.get(tid)?.mdd != null || spotMap.get(slug)?.mdd != null
  })
  log(`  bingx_spot MDD found: ${foundSpot.length}/${spotRows.filter(r => r.max_drawdown == null).length}`)

  // ── Update DB ─────────────────────────────────────────────────────────────
  log('\n📝 Updating database...')

  // --- bingx futures leaderboard_ranks ---
  let bingxUpdated = 0
  for (const row of (bingxRows || [])) {
    const d = futuresMap.get(row.source_trader_id)
    if (!d) continue
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue
    if (DRY_RUN) {
      log(`  [DRY] bingx "${row.handle}": ${JSON.stringify(updates)}`)
      bingxUpdated++
    } else {
      const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) { bingxUpdated++; log(`  ✓ bingx "${row.handle}": MDD=${updates.max_drawdown}`) }
      else log(`  ✗ Error "${row.handle}": ${error.message}`)
    }
  }
  log(`  bingx leaderboard_ranks: ${bingxUpdated} updated`)

  // --- bingx trader_snapshots ---
  const { data: snapBingx } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, max_drawdown')
    .eq('source', 'bingx')
    .is('max_drawdown', null)
  let snapBingxUpdated = 0
  for (const row of (snapBingx || [])) {
    const d = futuresMap.get(row.source_trader_id)
    if (!d?.mdd) continue
    if (!DRY_RUN) {
      const { error } = await sb.from('trader_snapshots').update({ max_drawdown: d.mdd }).eq('id', row.id)
      if (!error) snapBingxUpdated++
    } else snapBingxUpdated++
  }
  log(`  bingx trader_snapshots: ${snapBingxUpdated} updated`)

  // Git commit bingx
  if (!DRY_RUN && bingxUpdated > 0) {
    try {
      execSync('git -C /Users/adelinewen/ranking-arena add -A && git -C /Users/adelinewen/ranking-arena commit -m "fix: enrich bingx futures MDD via Playwright v4" || true', { stdio: 'pipe' })
      log('  📦 git commit: bingx done')
    } catch (e) { log('  ⚠ git error:', String(e.message).slice(0, 100)) }
  }

  // --- bingx_spot leaderboard_ranks ---
  let spotUpdated = 0
  for (const row of (spotRows || [])) {
    const tid = row.source_trader_id
    const slug = (row.handle || '').toLowerCase().trim()
      .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    const d = spotMap.get(tid) || spotMap.get(slug)
    if (!d) continue
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue
    if (DRY_RUN) {
      log(`  [DRY] spot "${row.handle}": ${JSON.stringify(updates)}`)
      spotUpdated++
    } else {
      const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) { spotUpdated++; log(`  ✓ spot "${row.handle}": MDD=${updates.max_drawdown}`) }
      else log(`  ✗ Error spot "${row.handle}": ${error.message}`)
    }
  }
  log(`  bingx_spot leaderboard_ranks: ${spotUpdated} updated`)

  // --- bingx_spot trader_snapshots ---
  const { data: snapSpot } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, handle, max_drawdown, win_rate')
    .eq('source', 'bingx_spot')
    .or('max_drawdown.is.null,win_rate.is.null')
  let snapSpotUpdated = 0
  for (const row of (snapSpot || [])) {
    const tid = row.source_trader_id
    const slug = (row.handle || '').toLowerCase().trim()
      .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    const d = spotMap.get(tid) || spotMap.get(slug)
    if (!d) continue
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue
    if (!DRY_RUN) {
      const { error } = await sb.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) snapSpotUpdated++
    } else snapSpotUpdated++
  }
  log(`  bingx_spot trader_snapshots: ${snapSpotUpdated} updated`)

  // Git commit bingx_spot
  if (!DRY_RUN && spotUpdated > 0) {
    try {
      execSync('git -C /Users/adelinewen/ranking-arena add -A && git -C /Users/adelinewen/ranking-arena commit -m "fix: enrich bingx_spot MDD/WR via Playwright v4" || true', { stdio: 'pipe' })
      log('  📦 git commit: bingx_spot done')
    } catch (e) { log('  ⚠ git error:', String(e.message).slice(0, 100)) }
  }

  // ── Final verification ────────────────────────────────────────────────────
  log('\n📊 Final null counts:')
  for (const source of ['bingx', 'bingx_spot']) {
    for (const tbl of ['leaderboard_ranks', 'trader_snapshots']) {
      const { count: total } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source)
      const { count: mddNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source).is('max_drawdown', null)
      const { count: wrNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source).is('win_rate', null)
      log(`  ${tbl} '${source}': total=${total} mdd_null=${mddNull} wr_null=${wrNull}`)
    }
  }
  log('\n✅ Done!')
}

main().catch(e => { log('FATAL:', e.message, '\n', e.stack); process.exit(1) })
