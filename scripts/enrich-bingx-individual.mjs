#!/usr/bin/env node
/**
 * BingX Individual Trader Enrichment via Playwright
 * Fetches detail pages for traders missing data that aren't in recommend API
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('🚀 BingX Individual Enrichment\n')

  // Get unique traders needing enrichment
  const { data: needRows } = await sb
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'bingx')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
  
  const uids = [...new Set((needRows || []).map(r => r.source_trader_id))]
    .filter(uid => !uid.startsWith('bingx_')) // skip synthetic IDs
  
  console.log(`${uids.length} unique traders need enrichment (${needRows.length} total rows)`)
  if (!uids.length) { console.log('Nothing to do!'); return }

  // Launch browser
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }, locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  // First navigate to BingX to get cookies/CF clearance
  const mainPage = await ctx.newPage()
  console.log('🌐 Getting CF clearance...')
  await mainPage.goto('https://bingx.com/en/copytrading/', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await sleep(10000)

  const enrichMap = new Map()
  let fetched = 0, errors = 0

  console.log(`\n📡 Fetching ${uids.length} trader details...`)
  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i]
    try {
      // Use the main page to make API calls (reuse CF cookies)
      const detail = await mainPage.evaluate(async (uid) => {
        const urls = [
          `https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}&timeType=3`,
          `https://bingx.com/api/strategy/api/v1/copy/trader/detail?uid=${uid}`,
        ]
        for (const url of urls) {
          try {
            const r = await fetch(url, { credentials: 'include' })
            if (!r.ok) continue
            const data = await r.json()
            if (data?.code === 0 && data?.data) return data.data
          } catch {}
        }
        
        // Try the recommend search with this uid
        try {
          const r = await fetch(`https://bingx.com/api/copytrading/v1/trader/search?keyword=${uid}`, { credentials: 'include' })
          const data = await r.json()
          if (data?.code === 0 && data?.data?.length > 0) return data.data[0]
        } catch {}
        
        return null
      }, uid)

      if (detail) {
        const wr = detail.winRate != null ? parseFloat(String(detail.winRate).replace('%', '')) : 
                   (detail.winRate90d != null ? parseFloat(detail.winRate90d) * (parseFloat(detail.winRate90d) <= 1 ? 100 : 1) : null)
        
        let mdd = null
        if (detail.maxDrawDown90d != null) {
          mdd = typeof detail.maxDrawDown90d === 'string' 
            ? parseFloat(detail.maxDrawDown90d.replace('%', ''))
            : parseFloat(detail.maxDrawDown90d)
          if (mdd > 0 && mdd <= 1) mdd *= 100
        } else if (detail.maxDrawdown != null) {
          mdd = parseFloat(String(detail.maxDrawdown).replace('%', ''))
          if (mdd > 0 && mdd <= 1) mdd *= 100
        } else if (detail.maximumDrawDown != null) {
          mdd = parseFloat(detail.maximumDrawDown)
          if (mdd > 0 && mdd <= 1) mdd *= 100
        }

        const tc = detail.totalTransactions != null ? parseInt(detail.totalTransactions) : null

        if (wr != null || mdd != null || tc != null) {
          enrichMap.set(uid, { wr, mdd, tc })
          fetched++
        }
      }
    } catch (e) {
      errors++
    }

    if ((i + 1) % 10 === 0) console.log(`  [${i + 1}/${uids.length}] fetched=${fetched} errors=${errors}`)
    await sleep(1500)
  }

  await browser.close()
  console.log(`\n📊 Got data for ${enrichMap.size}/${uids.length} traders`)

  // Update both tables
  for (const table of ['trader_snapshots', 'leaderboard_ranks']) {
    console.log(`\n📝 Updating ${table}...`)
    const { data: rows } = await sb
      .from(table)
      .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'bingx')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

    let updated = 0
    for (const row of (rows || [])) {
      const d = enrichMap.get(row.source_trader_id)
      if (!d) continue
      const updates = {}
      if (row.win_rate == null && d.wr != null && !isNaN(d.wr)) updates.win_rate = d.wr
      if (row.max_drawdown == null && d.mdd != null && !isNaN(d.mdd)) updates.max_drawdown = d.mdd
      if (row.trades_count == null && d.tc != null && !isNaN(d.tc)) updates.trades_count = d.tc
      if (!Object.keys(updates).length) continue
      const { error } = await sb.from(table).update(updates).eq('id', row.id)
      if (!error) updated++
    }
    console.log(`  Updated ${updated}/${(rows||[]).length}`)
  }

  // Verify
  console.log('\n📊 FINAL:')
  for (const table of ['trader_snapshots', 'leaderboard_ranks']) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx')
    const { count: noWR } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('win_rate', null)
    const { count: noMDD } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('max_drawdown', null)
    const { count: noTC } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('trades_count', null)
    console.log(`  ${table}: WR=${total-noWR}/${total} MDD=${total-noMDD}/${total} TC=${total-noTC}/${total}`)
  }
  console.log('\n✅ Done!')
}

main().catch(e => { console.error(e); process.exit(1) })
