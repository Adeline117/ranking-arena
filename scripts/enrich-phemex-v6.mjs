#!/usr/bin/env node
/**
 * Phemex Enrichment v6 - Visit individual trader profile pages via Playwright
 * Extracts win_rate, max_drawdown, trades_count from intercepted API responses
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('🚀 Phemex Enrichment v6 - Individual trader profiles\n')

  // Get all phemex rows needing enrichment
  let allRows = []
  let offset = 0
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'phemex')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  console.log(`Total rows needing enrichment: ${allRows.length}`)

  // Dedupe by source_trader_id
  const traderMap = new Map()
  for (const row of allRows) {
    if (!traderMap.has(row.source_trader_id)) traderMap.set(row.source_trader_id, [])
    traderMap.get(row.source_trader_id).push(row)
  }
  const traderIds = [...traderMap.keys()]
  console.log(`Unique traders: ${traderIds.length}\n`)

  // First try: intercept list API to get bulk data
  const enrichMap = new Map()

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })

  // Phase 1: Scrape list pages for bulk data
  console.log('=== Phase 1: List page scraping ===')
  const listPage = await ctx.newPage()
  
  listPage.on('response', async (resp) => {
    if (resp.status() !== 200) return
    const url = resp.url()
    if (!url.includes('recommend') && !url.includes('trader')) return
    try {
      const data = await resp.json()
      const rows = data?.data?.rows || (Array.isArray(data?.data) ? data.data : null)
      if (!rows) return
      for (const r of rows) {
        const uid = String(r.userId || r.uid || '')
        if (!uid || enrichMap.has(uid)) continue

        let wr = null
        for (const f of ['tradeWinRate180d','tradeWinRate90d','tradeWinRate30d','tradeWinRate7d','winRate']) {
          if (r[f] != null && r[f] !== '') {
            const v = parseFloat(r[f])
            if (!isNaN(v)) { wr = Math.round(v * 10000) / 100; break }
          }
        }

        let mdd = null
        for (const f of ['mdd30d','mdd90d','mdd180d','mdd7d','maxDrawdown']) {
          if (r[f] != null && r[f] !== '') {
            const v = parseFloat(r[f])
            if (!isNaN(v)) { mdd = Math.round(Math.abs(v) * 10000) / 100; break }
          }
        }

        let tc = null
        for (const f of ['totalCount','tradeCount','totalTrades']) {
          if (r[f] != null) {
            const v = parseInt(r[f])
            if (!isNaN(v)) { tc = v; break }
          }
        }

        enrichMap.set(uid, { wr, mdd, tc })
      }
    } catch {}
  })

  try {
    await listPage.goto('https://phemex.com/copy-trading/list', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(3000)
  } catch (e) {
    console.log('List page load error:', e.message?.slice(0, 60))
  }

  // Navigate through periods and sort options
  const periods = ['30D', '90D', '180D', '7D']
  const sorts = ['30D ROI', '30D PNL', 'AUM', '30D Copiers', 'Win Rate']
  
  for (const period of periods) {
    try {
      await listPage.getByText(period, { exact: true }).first().click({ timeout: 3000 })
      await sleep(2000)
    } catch {}
    for (const sort of sorts) {
      try {
        await listPage.getByText(sort, { exact: false }).first().click({ timeout: 2000 })
        await sleep(2000)
      } catch {}
    }
  }

  // Try tabs
  for (const tab of ['All Traders', 'Top Traders', 'Star Traders', 'Popular']) {
    try {
      await listPage.getByText(tab, { exact: true }).first().click({ timeout: 3000 })
      await sleep(3000)
      // Scroll and paginate
      for (let i = 0; i < 15; i++) {
        await listPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1500)
      }
      // Try next page buttons
      for (let i = 0; i < 30; i++) {
        try {
          const clicked = await listPage.evaluate(() => {
            const btns = document.querySelectorAll('button, li, a, [class*="next"]')
            for (const el of btns) {
              const t = el.textContent?.trim()
              const cn = el.className || ''
              if ((t === '›' || t === '>' || cn.includes('next')) && !el.disabled) {
                el.click(); return true
              }
            }
            return false
          })
          if (!clicked) break
          await sleep(2000)
        } catch { break }
      }
    } catch {}
  }

  console.log(`Phase 1 collected: ${enrichMap.size} traders from list pages`)
  await listPage.close()

  // Phase 2: Visit individual profile pages for remaining traders
  const remaining = traderIds.filter(id => !enrichMap.has(id))
  console.log(`\n=== Phase 2: Individual profiles for ${remaining.length} remaining traders ===`)

  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2}', route => route.abort())

  let enriched2 = 0, noData = 0
  for (let i = 0; i < remaining.length; i++) {
    const uid = remaining[i]
    let captured = null

    const handler = async (resp) => {
      if (resp.status() !== 200) return
      const url = resp.url()
      try {
        if (url.includes('detail') || url.includes('trading') || url.includes('performance') || url.includes('portfolio')) {
          const d = await resp.json()
          if (d?.data || d?.code === 0) captured = d
        }
      } catch {}
    }

    page.on('response', handler)
    try {
      await page.goto(`https://phemex.com/copy-trading/trader/${uid}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      for (let w = 0; w < 15; w++) {
        if (captured) break
        await sleep(500)
      }
    } catch {}
    page.removeListener('response', handler)

    if (captured?.data) {
      const d = captured.data
      let wr = null, mdd = null, tc = null

      // Try various field names
      for (const f of ['winRate','tradeWinRate','tradeWinRate180d','tradeWinRate90d','tradeWinRate30d']) {
        if (d[f] != null) { const v = parseFloat(d[f]); if (!isNaN(v)) { wr = Math.round(v * 10000) / 100; break } }
      }
      for (const f of ['maxDrawdown','mdd','mdd30d','mdd90d','maxRetracement']) {
        if (d[f] != null) { const v = parseFloat(d[f]); if (!isNaN(v)) { mdd = Math.round(Math.abs(v) * 10000) / 100; break } }
      }
      for (const f of ['totalCount','tradeCount','totalTrades','tradeTimes']) {
        if (d[f] != null) { const v = parseInt(d[f]); if (!isNaN(v)) { tc = v; break } }
      }

      if (wr != null || mdd != null || tc != null) {
        enrichMap.set(uid, { wr, mdd, tc })
        enriched2++
      } else {
        noData++
      }
    } else {
      noData++
    }

    if ((i + 1) % 20 === 0) {
      console.log(`  [${i+1}/${remaining.length}] enriched=${enriched2} noData=${noData}`)
    }

    await sleep(2000)

    // If first 20 all fail, the approach isn't working
    if (i >= 20 && enriched2 === 0) {
      console.log('⛔ First 20 all failed, stopping individual profiles')
      break
    }
  }

  console.log(`Phase 2: enriched=${enriched2} noData=${noData}`)
  await browser.close()

  // Update DB
  console.log(`\n📝 Updating DB with ${enrichMap.size} traders...`)
  let totalUpdated = 0

  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    let rows = []
    let off = 0
    while (true) {
      const { data } = await sb.from(table)
        .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
        .eq('source', 'phemex')
        .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
        .range(off, off + 999)
      if (!data?.length) break
      rows.push(...data)
      if (data.length < 1000) break
      off += 1000
    }

    let updated = 0
    for (const row of rows) {
      const d = enrichMap.get(row.source_trader_id)
      if (!d) continue
      const u = {}
      if (row.win_rate == null && d.wr != null) u.win_rate = d.wr
      if (row.max_drawdown == null && d.mdd != null) u.max_drawdown = d.mdd
      if (row.trades_count == null && d.tc != null) u.trades_count = d.tc
      if (Object.keys(u).length) {
        await sb.from(table).update(u).eq('id', row.id)
        updated++
      }
    }
    console.log(`  ${table}: updated ${updated}/${rows.length}`)
    totalUpdated += updated
  }

  // Verify
  console.log('\n📊 Verification:')
  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'phemex')
    const { count: wrN } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('win_rate', null)
    const { count: mddN } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('max_drawdown', null)
    const { count: tcN } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('trades_count', null)
    console.log(`  ${table}: total=${total} wr_null=${wrN} mdd_null=${mddN} tc_null=${tcN}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
