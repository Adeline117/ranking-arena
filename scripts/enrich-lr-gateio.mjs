#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks for Gate.io
 * Uses Playwright to intercept Gate.io copy trading API
 * Gate.io blocks direct API access, requires browser
 * Fields: win_rate, max_drawdown, trades_count
 */
import { chromium } from 'playwright'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'
const CYCLE_MAP = { 'week': '7D', 'month': '30D', 'quarter': '90D' }

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Gate.io — Enrich leaderboard_ranks`)
  console.log(`${'='.repeat(60)}`)

  // Get all rows needing enrichment
  let allRows = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', SOURCE)
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`Need enrichment: ${allRows.length} rows`)
  if (!allRows.length) return

  // Build lookup: source_trader_id|season -> [rows]
  const lookup = new Map()
  for (const r of allRows) {
    const key = `${r.source_trader_id}|${r.season_id}`
    if (!lookup.has(key)) lookup.set(key, [])
    lookup.get(key).push(r)
  }

  // Unique trader IDs that need individual detail pages
  const needDetail = new Set(allRows.map(r => r.source_trader_id))
  
  // Try launching browser
  let browser
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  } catch {
    browser = await chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:7890' }, args: ['--no-sandbox'] })
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  const traderData = new Map() // leaderId -> { season -> { wr, mdd, tc } }

  // Strategy 1: Intercept leaderboard list API for bulk data
  const page = await context.newPage()
  
  page.on('response', async (res) => {
    const url = res.url()
    if (!url.includes('/copy/leader/list') && !url.includes('/copy_trading')) return
    try {
      const j = await res.json()
      if (j?.code !== 0 || !j?.data) return
      const list = j.data.list || j.data.rows || (Array.isArray(j.data) ? j.data : [])
      if (!Array.isArray(list)) return
      
      const cycleMatch = url.match(/cycle=(\w+)/)
      const cycle = cycleMatch ? cycleMatch[1] : 'month'
      const season = CYCLE_MAP[cycle] || '30D'

      for (const t of list) {
        const id = String(t.leader_id || t.id || t.user_id || '')
        if (!id) continue
        
        if (!traderData.has(id)) traderData.set(id, {})
        const entry = traderData.get(id)
        
        let wr = t.win_rate ?? t.winRate
        let mdd = t.max_drawdown ?? t.maxDrawdown ?? t.max_retrace
        let tc = t.order_count ?? t.trade_count ?? t.total_count
        
        if (wr != null) { wr = parseFloat(wr); if (wr > 0 && wr <= 1) wr *= 100 }
        if (mdd != null) { mdd = Math.abs(parseFloat(mdd)); if (mdd > 0 && mdd <= 1) mdd *= 100 }
        if (tc != null) tc = parseInt(tc)
        
        entry[season] = { wr, mdd, tc }
      }
    } catch {}
  })

  // Also intercept responses that have user_name/nickname for matching text IDs
  const textIdMap = new Map() // username -> leader_id
  
  const origHandler = page.listeners('response').find(() => true)
  page.on('response', async (res) => {
    const url = res.url()
    if (!url.includes('/copy/leader/list') && !url.includes('/copy_trading')) return
    try {
      const j = await res.json()
      if (j?.code !== 0 || !j?.data) return
      const list = j.data.list || []
      for (const t of list) {
        const id = String(t.leader_id || '')
        const name = t.user_name || t.nickname || ''
        if (id && name) {
          textIdMap.set(name.toLowerCase(), id)
          textIdMap.set(`cta_${name.toLowerCase()}`, id)
        }
      }
    } catch {}
  })

  // Navigate using gate.com URL pattern with different sort/cycle combos
  const cycles = ['week', 'month', 'quarter']
  const orderBys = ['profit_rate', 'profit', 'aum', 'max_drawdown', 'win_rate', 'sharp_ratio']

  for (const cycle of cycles) {
    console.log(`\nScraping ${cycle} leaderboard...`)
    for (const orderBy of orderBys) {
      for (let pg = 1; pg <= 15; pg++) {
        try {
          const url = `https://www.gate.com/copytrading?order_by=${orderBy}&sort_by=desc&cycle=${cycle}&page=${pg}`
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
          await sleep(4000)
          
          const prevCount = traderData.size
          await sleep(2000)
          if (traderData.size === prevCount && pg > 1) break
        } catch { break }
      }
    }
    console.log(`  Collected ${traderData.size} traders so far`)
  }

  // Strategy 2: For traders not found in list, try individual detail pages
  const foundIds = new Set(traderData.keys())
  const missingIds = [...needDetail].filter(id => !foundIds.has(id))
  console.log(`\nFound in list: ${foundIds.size}, Missing: ${missingIds.length}`)

  // Try individual detail pages for missing traders (limit to avoid ban)
  const detailLimit = Math.min(missingIds.length, 200)
  for (let i = 0; i < detailLimit; i++) {
    const traderId = missingIds[i]
    if ((i + 1) % 20 === 0) console.log(`  Detail page ${i + 1}/${detailLimit}`)
    
    try {
      const detailPage = await context.newPage()
      let captured = false
      
      detailPage.on('response', async (res) => {
        const url = res.url()
        if (!url.includes(traderId) && !url.includes('leader/detail') && !url.includes('trader/detail')) return
        try {
          const j = await res.json()
          const d = j?.data || j
          if (!d) return
          
          let wr = d.win_rate ?? d.winRate
          let mdd = d.max_drawdown ?? d.maxDrawdown
          let tc = d.order_count ?? d.trade_count ?? d.total_count
          
          if (wr != null) { wr = parseFloat(wr); if (wr > 0 && wr <= 1) wr *= 100 }
          if (mdd != null) { mdd = Math.abs(parseFloat(mdd)); if (mdd > 0 && mdd <= 1) mdd *= 100 }
          if (tc != null) tc = parseInt(tc)
          
          if (!traderData.has(traderId)) traderData.set(traderId, {})
          const entry = traderData.get(traderId)
          // Apply to all seasons
          for (const s of ['7D', '30D', '90D']) {
            if (!entry[s]) entry[s] = { wr, mdd, tc }
          }
          captured = true
        } catch {}
      })

      await detailPage.goto(`https://www.gate.io/copytrading/trader/${traderId}`, {
        waitUntil: 'domcontentloaded', timeout: 15000
      }).catch(() => {})
      await sleep(3000)
      await detailPage.close()
    } catch {}
    
    await sleep(1000)
  }

  await browser.close()
  console.log(`\nTotal traders with data: ${traderData.size}`)

  // Match and update - handle both numeric and text IDs
  let updated = 0
  for (const [traderId, seasons] of traderData) {
    for (const [season, data] of Object.entries(seasons)) {
      // Try direct match
      let key = `${traderId}|${season}`
      let rows = lookup.get(key)
      if (!rows) continue

      for (const row of rows) {
        const updates = {}
        if (row.win_rate == null && data.wr != null && !isNaN(data.wr)) updates.win_rate = parseFloat(data.wr.toFixed(2))
        if (row.max_drawdown == null && data.mdd != null && !isNaN(data.mdd)) updates.max_drawdown = parseFloat(data.mdd.toFixed(2))
        if (row.trades_count == null && data.tc != null && !isNaN(data.tc)) updates.trades_count = data.tc

        if (Object.keys(updates).length === 0) continue
        const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
        if (!error) updated++
      }
    }
  }

  console.log(`\n✅ Gate.io: ${updated} updated`)

  // Verify
  const { count: total } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  const { count: tcNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('trades_count', null)
  console.log(`After: total=${total} wr_null=${wrNull} mdd_null=${mddNull} tc_null=${tcNull}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
