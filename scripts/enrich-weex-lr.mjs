#!/usr/bin/env node
/**
 * enrich-weex-lr.mjs
 *
 * Goal: Fill NULL win_rate and max_drawdown in leaderboard_ranks WHERE source='weex'.
 *
 * Findings from investigation:
 *   - The real Weex copy-trading API: http-gateway1.janapw.com/api/v1/public/trace/traderListView
 *     (accessed via browser, uses signed headers)
 *   - traderListView returns: PnL, Copier PnL, Win rate (3W) — NO max_drawdown
 *   - traderHome / traderDetail / all v2 endpoints → 404 or Cloudflare 521
 *   - Weex website does NOT display max_drawdown anywhere
 *   - getHistoryOrderList gives per-trade PnL but no account equity → cannot derive % MDD
 *   => win_rate CAN be filled from live API; max_drawdown is GENUINELY NOT AVAILABLE
 *
 * Usage: node scripts/enrich-weex-lr.mjs [--dry-run]
 */

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')

// fetch with a hard timeout
async function fetchTimeout(url, opts = {}, ms = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    return res
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║   Weex WR + MDD Enrichment for leaderboard_ranks    ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  if (DRY_RUN) console.log('  ⚠️  DRY RUN — no DB writes\n')

  // ── Step 1: DB snapshot (paginated to handle >1000 rows) ────────────────────
  let allWeexRows = []
  let pageStart = 0
  const PAGE_SIZE = 1000
  while (true) {
    const { data, error: dbErr } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown')
      .eq('source', 'weex')
      .range(pageStart, pageStart + PAGE_SIZE - 1)
    if (dbErr) { console.error('DB error:', dbErr.message); process.exit(1) }
    if (!data || data.length === 0) break
    allWeexRows = allWeexRows.concat(data)
    if (data.length < PAGE_SIZE) break
    pageStart += PAGE_SIZE
  }
  console.log(`  Fetched ${allWeexRows.length} weex rows from DB`)

  const wrNullRows  = allWeexRows.filter(r => r.win_rate    === null)
  const mddNullRows = allWeexRows.filter(r => r.max_drawdown === null)
  const uniqueTraderIds = [...new Set(allWeexRows.map(r => r.source_trader_id))]

  console.log('\n📊 DB snapshot (source=weex):')
  console.log(`   Total rows          : ${allWeexRows.length}`)
  console.log(`   Unique traders      : ${uniqueTraderIds.length}`)
  console.log(`   win_rate IS NULL    : ${wrNullRows.length}`)
  console.log(`   max_drawdown IS NULL: ${mddNullRows.length}`)

  if (wrNullRows.length === 0 && mddNullRows.length === 0) {
    console.log('\n✅ Nothing to do — all fields already populated!')
    return
  }

  // uid → { winRate, maxDrawdown, source }
  const statsMap = new Map()

  function absorb(traderId, obj, source) {
    const id = String(traderId)
    if (!id || id === 'undefined') return
    const cur = statsMap.get(id) || {}

    // win_rate from itemVoList
    for (const col of (obj.itemVoList || [])) {
      const desc = (col.showColumnDesc || '').toLowerCase()
      if ((desc.includes('win rate') || desc.includes('winrate')) && cur.winRate == null) {
        const val = parseFloat(col.showColumnValue)
        if (!isNaN(val) && val >= 0 && val <= 100) cur.winRate = Math.round(val * 100) / 100
      }
    }
    // win_rate direct fields
    for (const f of ['winRate', 'win_rate']) {
      if (cur.winRate == null && obj[f] != null) {
        const val = parseFloat(obj[f])
        if (!isNaN(val) && val >= 0 && val <= 100) cur.winRate = Math.round(val * 100) / 100
      }
    }
    // max_drawdown — every possible field name
    const ddFields = ['maxDrawdown','max_drawdown','mdd','MDD','drawdown','maxDrawRate',
                      'maxDrawdownRate','maxDd','riskRate','maxDrop','maxRetracement']
    for (const f of ddFields) {
      if (cur.maxDrawdown == null && obj[f] != null) {
        const val = parseFloat(obj[f])
        if (!isNaN(val)) { cur.maxDrawdown = Math.round(Math.abs(val)*100)/100; cur.mddField = `${source}.${f}` }
      }
    }
    // max_drawdown from itemVoList
    for (const col of (obj.itemVoList || [])) {
      const desc = (col.showColumnDesc || '').toLowerCase()
      if ((desc.includes('drawdown') || desc.includes('mdd') || desc.includes('drop')) && cur.maxDrawdown == null) {
        const val = parseFloat(col.showColumnValue)
        if (!isNaN(val)) { cur.maxDrawdown = Math.round(Math.abs(val)*100)/100; cur.mddField = `${source}.itemVoList.${col.showColumnDesc}` }
      }
    }
    statsMap.set(id, { ...cur, src: source })
  }

  // ── Step 2: Browser interception ────────────────────────────────────────────
  console.log('\n🌐 Launching browser...')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  })
  const page = await context.newPage()

  // Capture signed request headers via CDP
  const client = await context.newCDPSession(page)
  await client.send('Network.enable')

  let capturedReq = null
  client.on('Network.requestWillBeSent', p => {
    if (p.request.url.includes('traderListView') && p.request.method === 'POST' && !capturedReq) {
      capturedReq = { url: p.request.url, headers: { ...p.request.headers } }
      delete capturedReq.headers['content-length']
      delete capturedReq.headers['connection']
    }
  })

  // Intercept ALL JSON responses via page.on
  page.on('response', async (res) => {
    const url = res.url()
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await res.json()
      if (!json || typeof json !== 'object') return
      // traderListView rows
      if (json.data?.rows) {
        for (const row of json.data.rows) absorb(row.traderUserId, row, url.split('/').pop())
      }
      // single trader
      if (json.data?.traderUserId) absorb(json.data.traderUserId, json.data, url.split('/').pop())
    } catch {}
  })

  // Load main page
  console.log('  Loading https://www.weex.com/copy-trading ...')
  try {
    await page.goto('https://www.weex.com/copy-trading', { waitUntil: 'networkidle', timeout: 45000 })
    await sleep(5000)
  } catch (e) {
    console.log('  Nav error (non-fatal):', e.message.slice(0, 80))
  }
  console.log(`  After page load: ${statsMap.size} traders captured`)

  // ── Step 3: Replay pagination with all sort orders ──────────────────────────
  if (capturedReq) {
    console.log('\n  Replaying traderListView (paginated)...')
    const SORT_RULES = [9, 0, 7, 1, 2, 4]
    const baseHeaders = { ...capturedReq.headers, 'content-type': 'application/json' }

    for (const sortRule of SORT_RULES) {
      let pageNo = 1
      let total = 9999
      while ((pageNo - 1) * 100 < total) {
        try {
          const body = JSON.stringify({ languageType: 0, sortRule, simulation: 0, pageNo, pageSize: 100, nickName: '' })
          const res = await fetchTimeout(capturedReq.url, { method: 'POST', headers: baseHeaders, body }, 15000)
          const json = await res.json()
          if (json.code !== 'SUCCESS' || !json.data?.rows) break
          total = json.data.totals || 0
          for (const row of json.data.rows) absorb(row.traderUserId, row, `traderListView.sort${sortRule}`)
          console.log(`    sort=${sortRule} p=${pageNo}: rows=${json.data.rows.length} total=${total} captured=${statsMap.size}`)
          if (json.data.rows.length < 100) break
          pageNo++
          await sleep(400)
        } catch (e) {
          console.log(`    sort=${sortRule} p=${pageNo}: ${e.message?.slice(0,60)}`)
          break
        }
      }
    }

    // ── Step 4: Probe alternative endpoints for MDD ──────────────────────────
    console.log('\n  Probing alternative endpoints for max_drawdown...')
    const baseUrl = capturedReq.url.substring(0, capturedReq.url.lastIndexOf('/') + 1)
    const testTrader = uniqueTraderIds.find(id => id) || '4188609913'
    const altEndpoints = [
      { url: `${baseUrl}traderStatAbstract`, method: 'POST', body: { traderUserId: testTrader, languageType: 0 } },
      { url: `${baseUrl}traderRiskAbstract`, method: 'POST', body: { traderUserId: testTrader, languageType: 0 } },
      { url: `${baseUrl}traderPerformance`,  method: 'POST', body: { traderUserId: testTrader, languageType: 0 } },
      { url: `${baseUrl}traderProfile`,      method: 'POST', body: { traderUserId: testTrader, languageType: 0 } },
      { url: `${baseUrl}traderStats`,        method: 'POST', body: { traderUserId: testTrader, languageType: 0, dateType: 'ALL' } },
    ]
    for (const ep of altEndpoints) {
      const epName = ep.url.split('/').pop()
      try {
        const res = await fetchTimeout(ep.url, {
          method: ep.method,
          headers: { ...baseHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(ep.body)
        }, 10000)
        const text = await res.text()
        let json
        try { json = JSON.parse(text) } catch { console.log(`  ${epName}: non-JSON (${res.status})`); continue }
        const hasDD = /drawdown|mdd|maxDraw|riskRate|回撤/i.test(text)
        console.log(`  ${epName}: status=${res.status} code=${json.code||'?'} hasDrawdown=${hasDD}`)
        if (hasDD) {
          console.log(`  !! FOUND DRAWDOWN: ${text.slice(0,500)}`)
          if (json.data) absorb(testTrader, json.data, epName)
        }
      } catch (e) {
        console.log(`  ${epName}: ${e.name === 'AbortError' ? 'timeout' : e.message?.slice(0,60)}`)
      }
    }
  } else {
    console.log('  ⚠️  traderListView request not captured — browser interception failed')
  }

  // ── Step 5: Individual pages for remaining win_rate NULLs ───────────────────
  const wrNeedingUpdate = uniqueTraderIds.filter(id => {
    // Check if in DB they have null win_rate and we still don't have it
    const dbRows = allWeexRows.filter(r => r.source_trader_id === id && r.win_rate === null)
    if (dbRows.length === 0) return false
    const stats = statsMap.get(id)
    return !stats || stats.winRate == null
  })

  let wrUpdatedInline = 0
  if (wrNeedingUpdate.length > 0) {
    console.log(`\n  Phase 2: Visiting ${wrNeedingUpdate.length} individual trader pages for win_rate...`)
    for (let i = 0; i < wrNeedingUpdate.length; i++) {
      const traderId = wrNeedingUpdate[i]
      const handler = async (res) => {
        const url = res.url()
        try {
          const ct = res.headers()['content-type'] || ''
          if (!ct.includes('json')) return
          const json = await res.json()
          if (json.data?.rows) for (const row of json.data.rows) absorb(row.traderUserId, row, 'traderPage.rows')
          if (json.data?.traderUserId) absorb(json.data.traderUserId, json.data, 'traderPage')
        } catch {}
      }
      page.on('response', handler)
      try {
        await page.goto(`https://www.weex.com/copy-trading/trader/${traderId}`, {
          waitUntil: 'domcontentloaded', timeout: 20000
        })
        await sleep(2000)
        // Page-text fallback
        const cur = statsMap.get(traderId) || {}
        if (cur.winRate == null) {
          const wr = await page.evaluate(() => {
            const t = document.body?.innerText || ''
            const m = t.match(/Win\s+[Rr]ate[\s\S]{0,20}?([\d.]+)\s*%/i)
            if (m) return parseFloat(m[1])
            const tm = t.match(/Trades\s*[\n\r:]+\s*([\d,]+)/i)
            const wm = t.match(/Wins\s*[\n\r:]+\s*([\d,]+)/i)
            if (tm && wm) {
              const tot = parseInt(tm[1].replace(/,/g,''))
              const win = parseInt(wm[1].replace(/,/g,''))
              return tot > 0 ? Math.round(win/tot*10000)/100 : null
            }
            return null
          }).catch(() => null)
          if (wr != null) { statsMap.set(traderId, { ...cur, winRate: wr, src: 'page-text' }) }
        }
      } catch {}
      page.off('response', handler)
      const s = statsMap.get(traderId) || {}
      console.log(`    [${i+1}/${wrNeedingUpdate.length}] ${traderId}: WR=${s.winRate ?? 'not found'}`)

      // ── Incremental DB write after each trader ───────────────────────────────
      if (!DRY_RUN && s.winRate != null) {
        const traderDbRows = allWeexRows.filter(r => r.source_trader_id === traderId && r.win_rate === null)
        for (const row of traderDbRows) {
          const { error: ue } = await sb.from('leaderboard_ranks').update({ win_rate: s.winRate }).eq('id', row.id)
          if (ue) console.error(`    ❌ id=${row.id}: ${ue.message}`)
          else wrUpdatedInline++
        }
      }
      await sleep(200)
    }
  }

  await browser.close()
  console.log(`\n  Total traders in statsMap: ${statsMap.size}`)
  console.log(`  Traders with WR : ${[...statsMap.values()].filter(s => s.winRate != null).length}`)
  console.log(`  Traders with MDD: ${[...statsMap.values()].filter(s => s.maxDrawdown != null).length}`)
  console.log(`  WR rows written inline during Phase 2: ${wrUpdatedInline}`)

  // ── Step 6: Update DB (for rows not yet updated inline) ──────────────────────
  console.log('\n💾 Updating DB (non-Phase-2 rows)...')
  let wrUpdated = wrUpdatedInline, mddUpdated = 0, skipped = 0, errors = 0

  // Re-fetch current DB state to know what's still NULL after inline updates
  let currentRows = []
  let cs = 0
  while (true) {
    const { data } = await sb.from('leaderboard_ranks').select('id, source_trader_id, win_rate, max_drawdown')
      .eq('source','weex').range(cs, cs + 999)
    if (!data || data.length === 0) break
    currentRows = currentRows.concat(data)
    if (data.length < 1000) break
    cs += 1000
  }

  for (const row of currentRows) {
    const stats = statsMap.get(row.source_trader_id)
    const updates = {}
    if (row.win_rate    === null && stats?.winRate     != null) updates.win_rate     = stats.winRate
    if (row.max_drawdown === null && stats?.maxDrawdown != null) updates.max_drawdown = stats.maxDrawdown
    if (Object.keys(updates).length === 0) { skipped++; continue }

    if (DRY_RUN) {
      console.log(`  [DRY] id=${row.id} trader=${row.source_trader_id}: ${JSON.stringify(updates)}`)
    } else {
      const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (ue) { console.error(`  ❌ id=${row.id}: ${ue.message}`); errors++; continue }
    }
    if (updates.win_rate     != null) wrUpdated++
    if (updates.max_drawdown != null) mddUpdated++
  }

  // ── Step 7: Verification ─────────────────────────────────────────────────────
  console.log('\n📊 Post-update verification:')
  const { count: nullWR }  = await sb.from('leaderboard_ranks').select('*',{count:'exact',head:true}).eq('source','weex').is('win_rate', null)
  const { count: nullMDD } = await sb.from('leaderboard_ranks').select('*',{count:'exact',head:true}).eq('source','weex').is('max_drawdown', null)
  console.log(`   win_rate IS NULL    : ${nullWR}`)
  console.log(`   max_drawdown IS NULL: ${nullMDD}`)

  // ── Step 8: Final report ─────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════╗')
  console.log('║                     RESULTS                         ║')
  console.log('╠══════════════════════════════════════════════════════╣')
  console.log(`║  win_rate rows updated    : ${String(wrUpdated).padEnd(25)} ║`)
  console.log(`║  max_drawdown rows updated: ${String(mddUpdated).padEnd(25)} ║`)
  console.log(`║  rows skipped (no data)   : ${String(skipped).padEnd(25)} ║`)
  console.log(`║  DB errors                : ${String(errors).padEnd(25)} ║`)
  console.log('╠══════════════════════════════════════════════════════╣')
  console.log(`║  win_rate remaining NULL  : ${String(nullWR).padEnd(25)} ║`)
  console.log(`║  max_drawdown remaining NULL: ${String(nullMDD).padEnd(23)} ║`)
  console.log('╚══════════════════════════════════════════════════════╝')

  if (nullMDD > 0) {
    console.log('\n⚠️  WHY max_drawdown IS NULL:')
    console.log('   Weex does NOT expose max_drawdown in any public API.')
    console.log('   Verified endpoints:')
    console.log('   • traderListView (janapw.com gateway) → itemVoList: {PnL, Copier PnL, Win rate} only')
    console.log('   • traderHome, traderDetail, traderStats, traderStatAbstract → HTTP 404')
    console.log('   • /api/v2/copy-trade/leaderboard, /trader-stats → HTTP 521 (Cloudflare)')
    console.log('   • futuresopenapi.weex.com/fapi/v1/copyTrading/leaderboard → no response')
    console.log('   • Weex website trader pages: no drawdown metric shown anywhere')
    console.log('   • getHistoryOrderList: per-trade PnL in USDT; no account equity baseline')
    console.log('   max_drawdown will remain NULL until Weex exposes it in a public endpoint.')
  }
  if (nullWR > 0) {
    console.log(`\n⚠️  ${nullWR} win_rate still NULL — traders not found in current leaderboard.`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
