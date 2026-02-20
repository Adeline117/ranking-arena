#!/usr/bin/env node
/**
 * Gate.io leaderboard_ranks WR/MDD enricher v2
 * 
 * API discovered: https://www.gate.com/apiw/v2/copy/leader/list
 * - No auth needed beyond browser session cookies
 * - Returns win_rate (0-1) and max_drawdown (0-1) per trader
 * - Strategy: paginate through ALL list pages, plus CTA list, plus detail pages for misses
 */
import { chromium } from 'playwright'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'
const BASE = 'https://www.gate.com'

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Gate.io — WR/MDD Enricher v2`)
  console.log(`${'='.repeat(60)}`)

  // Fetch all rows needing enrichment
  const { data: allRows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
    .eq('source', SOURCE)
    .or('win_rate.is.null,max_drawdown.is.null')

  if (error) { console.error('DB error:', error.message); process.exit(1) }
  console.log(`Need enrichment: ${allRows.length} rows`)
  if (!allRows.length) { console.log('Nothing to do'); return }

  // Build lookup
  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const traderIds = [...byTrader.keys()]
  const numericIds = new Set(traderIds.filter(t => /^\d+$/.test(t)))
  const ctaIds = new Set(traderIds.filter(t => !(/^\d+$/.test(t))))
  console.log(`Unique traders: ${traderIds.length} (numeric: ${numericIds.size}, cta: ${ctaIds.size})`)

  // Launch browser
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  })

  // Navigate once to establish session
  console.log('\nEstablishing session...')
  const page = await context.newPage()
  await page.goto(`${BASE}/copytrading`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)

  // Helper: fetch JSON from the Gate.io API via in-page fetch (bypasses CORS)
  async function apiFetch(url) {
    return page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' })
        if (!r.ok) return null
        return await r.json()
      } catch { return null }
    }, url)
  }

  // Collect all trader data: leaderId -> { cycle -> { wr, mdd, tc } }
  const traderData = new Map() // leaderId (string) -> { '7D': {wr,mdd,tc}, '30D': ..., '90D': ... }

  function processTrader(t, season) {
    const id = String(t.leader_id || t.id || '')
    if (!id || id === '0') return

    let wr = t.win_rate != null ? parseFloat(t.win_rate) : null
    let mdd = t.max_drawdown != null ? Math.abs(parseFloat(t.max_drawdown)) : null
    let tc = t.order_count != null ? parseInt(t.order_count) : null

    // Normalize: values 0-1 → multiply by 100 for percentage
    if (wr != null && wr <= 1) wr = wr * 100
    if (mdd != null && mdd <= 1) mdd = mdd * 100

    if (!traderData.has(id)) traderData.set(id, {})
    const entry = traderData.get(id)
    if (!entry[season] || (wr != null && entry[season].wr == null)) {
      entry[season] = { wr, mdd, tc }
    }

    // Username mapping for cta_ IDs
    const name = t.user_name || t.userName || t.nickname || ''
    if (name) {
      const ctaKey = `cta_${name.toLowerCase()}`
      if (ctaIds.has(ctaKey)) {
        if (!traderData.has(ctaKey)) traderData.set(ctaKey, {})
        const ctaEntry = traderData.get(ctaKey)
        if (!ctaEntry[season] || (wr != null && ctaEntry[season].wr == null)) {
          ctaEntry[season] = { wr, mdd, tc }
        }
      }
    }
  }

  // ── Phase 1: Paginate through leader/list for all cycles ──
  console.log('\n── Phase 1: Paginating leader/list ──')
  const cycleMap = { week: '7D', month: '30D', quarter: '90D' }
  
  for (const [cycle, season] of Object.entries(cycleMap)) {
    let page_num = 1
    let total_found = 0
    while (true) {
      const url = `${BASE}/apiw/v2/copy/leader/list?page=${page_num}&page_size=100&cycle=${cycle}&status=running&order_by=profit_rate&sort_by=desc`
      const j = await apiFetch(url)
      if (!j || j.code !== 0 || !j.data?.list) break
      const list = j.data.list
      if (!list.length) break
      for (const t of list) processTrader(t, season)
      total_found += list.length
      if (list.length < 100) break
      page_num++
      await sleep(300)
    }
    console.log(`  ${cycle} (${season}): ${total_found} traders, pages=${page_num}`)
  }
  console.log(`After Phase 1: ${traderData.size} traders collected`)

  // Check coverage
  let covered = [...traderIds].filter(id => traderData.has(id)).length
  console.log(`Coverage: ${covered}/${traderIds.length}`)

  // ── Phase 2: CTA trader list (for cta_ IDs) ──
  if (ctaIds.size > 0) {
    console.log('\n── Phase 2: CTA trader list ──')
    const ctaSortFields = ['NINETY_PROFIT_RATE_SORT', 'THIRTY_PROFIT_RATE_SORT', 'SEVEN_PROFIT_RATE_SORT', 'WIN_RATE_SORT']
    for (const sortField of ctaSortFields) {
      let page_num = 1
      let total_found = 0
      while (true) {
        const url = `${BASE}/apiw/v2/copy/leader/query_cta_trader?page_num=${page_num}&page_size=100&sort_field=${sortField}`
        const j = await apiFetch(url)
        if (!j || !j.data) break
        const list = j.data.list || j.data || []
        if (!Array.isArray(list) || !list.length) break
        for (const t of list) {
          const id = String(t.leader_id || t.id || '')
          const name = t.user_name || t.userName || t.nickname || ''
          if (name) {
            const ctaKey = `cta_${name.toLowerCase()}`
            // Process for all seasons
            for (const season of ['7D', '30D', '90D']) processTrader({ ...t, user_name: name }, season)
          }
          if (id) for (const season of ['7D', '30D', '90D']) processTrader(t, season)
        }
        total_found += list.length
        if (list.length < 100) break
        page_num++
        await sleep(300)
      }
      console.log(`  ${sortField}: ${total_found} traders`)
    }
    covered = [...traderIds].filter(id => traderData.has(id)).length
    console.log(`After Phase 2: ${covered}/${traderIds.length} covered`)
  }

  // ── Phase 3: Try searching by trader_name for specific missing numeric IDs ──
  const missingNumeric = [...numericIds].filter(id => !traderData.has(id))
  console.log(`\n── Phase 3: Search for ${missingNumeric.length} missing numeric traders ──`)
  
  for (const traderId of missingNumeric) {
    // Try the "stopped" traders list
    const url = `${BASE}/apiw/v2/copy/leader/list?page=1&page_size=100&trader_name=${traderId}&status=`
    const j = await apiFetch(url)
    if (j?.data?.list?.length) {
      for (const t of j.data.list) {
        if (String(t.leader_id) === traderId) {
          for (const season of ['7D', '30D', '90D']) processTrader(t, season)
          console.log(`  Found by name search: ${traderId}`)
          break
        }
      }
    }
    await sleep(200)
  }

  // Also try without status filter (includes all traders including stopped)
  const stillMissing = [...numericIds].filter(id => !traderData.has(id))
  if (stillMissing.length > 0) {
    console.log(`Still missing ${stillMissing.length}, trying all-status paginate...`)
    for (const [cycle, season] of Object.entries(cycleMap)) {
      let page_num = 1
      while (true) {
        const url = `${BASE}/apiw/v2/copy/leader/list?page=${page_num}&page_size=100&cycle=${cycle}&order_by=profit_rate&sort_by=desc`
        const j = await apiFetch(url)
        if (!j || j.code !== 0 || !j.data?.list) break
        const list = j.data.list
        if (!list.length) break
        for (const t of list) processTrader(t, season)
        if (list.length < 100) break
        page_num++
        await sleep(300)
        // Stop after 50 pages (5000 traders) per cycle
        if (page_num > 50) break
      }
    }
    const nowCovered = [...numericIds].filter(id => traderData.has(id)).length
    console.log(`After extended paginate: ${nowCovered}/${numericIds.size} numeric covered`)
  }

  // ── Phase 4: Individual detail pages for traders still missing ──
  const finalMissing = traderIds.filter(id => {
    const d = traderData.get(id)
    return !d || Object.keys(d).length === 0
  })
  
  console.log(`\n── Phase 4: Individual pages for ${finalMissing.length} traders ──`)
  
  for (let i = 0; i < finalMissing.length; i++) {
    const traderId = finalMissing[i]
    const username = traderId.replace(/^cta_/, '')
    if (i % 5 === 0) console.log(`  ${i + 1}/${finalMissing.length}: ${traderId}`)

    const detailPage = await context.newPage()
    let stats = null

    detailPage.on('response', async (res) => {
      const url = res.url()
      if (res.status() !== 200) return
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        if (!url.includes('apiw') && !url.includes('copy')) return
        const j = await res.json()
        if (j?.code !== 0 || !j?.data) return
        
        // Check if it's a list response containing our trader
        const list = j.data?.list
        if (Array.isArray(list)) {
          for (const t of list) {
            if (String(t.leader_id) === traderId || (t.user_name && `cta_${t.user_name.toLowerCase()}` === traderId)) {
              const wr = t.win_rate != null ? parseFloat(t.win_rate) : null
              const mdd = t.max_drawdown != null ? Math.abs(parseFloat(t.max_drawdown)) : null
              const tc = t.order_count != null ? parseInt(t.order_count) : null
              stats = {
                wr: wr != null && wr <= 1 ? wr * 100 : wr,
                mdd: mdd != null && mdd <= 1 ? mdd * 100 : mdd,
                tc
              }
            }
          }
        }
      } catch {}
    })

    try {
      await detailPage.goto(`${BASE}/copytrading/trader/${username}`, {
        waitUntil: 'domcontentloaded', timeout: 15000
      }).catch(() => {})
      await sleep(4000)
    } catch {}
    await detailPage.close()

    if (stats) {
      if (!traderData.has(traderId)) traderData.set(traderId, {})
      const entry = traderData.get(traderId)
      for (const s of ['7D', '30D', '90D']) {
        if (!entry[s]) entry[s] = { wr: stats.wr, mdd: stats.mdd, tc: stats.tc }
      }
    }
    await sleep(500)
  }

  await browser.close()
  
  covered = [...traderIds].filter(id => traderData.has(id)).length
  console.log(`\nTotal collected: ${traderData.size} traders, coverage: ${covered}/${traderIds.length}`)

  // ── Update DB ──
  console.log('\n── Updating DB ──')
  let updated = 0, skipped = 0

  for (const [traderId, seasons] of traderData) {
    const rows = byTrader.get(traderId)
    if (!rows) continue

    for (const row of rows) {
      const season = row.season_id
      // Use exact season match, then fallback to 30D, then any
      const data = seasons[season] || seasons['30D'] || Object.values(seasons)[0]
      if (!data) { skipped++; continue }

      const updates = {}
      if (row.win_rate == null && data.wr != null && !isNaN(data.wr)) {
        updates.win_rate = parseFloat(data.wr.toFixed(2))
      }
      if (row.max_drawdown == null && data.mdd != null && !isNaN(data.mdd)) {
        updates.max_drawdown = parseFloat(data.mdd.toFixed(2))
      }
      if (row.trades_count == null && data.tc != null && !isNaN(data.tc)) {
        updates.trades_count = data.tc
      }

      if (Object.keys(updates).length === 0) { skipped++; continue }

      const { error: upErr } = await supabase
        .from('leaderboard_ranks')
        .update(updates)
        .eq('id', row.id)

      if (!upErr) {
        updated++
        console.log(`  ✓ ${traderId} ${season}: wr=${updates.win_rate ?? '-'} mdd=${updates.max_drawdown ?? '-'}`)
      } else {
        console.error(`  ✗ ${traderId}: ${upErr.message}`)
      }
    }
  }

  console.log(`\n✅ Updated: ${updated}, Skipped: ${skipped}`)

  // Final verification
  const { count: total } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  console.log(`\nFinal DB state: total=${total} wr_null=${wrNull} mdd_null=${mddNull}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
