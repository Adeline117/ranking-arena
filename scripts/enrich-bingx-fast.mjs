#!/usr/bin/env node
/**
 * BingX Fast Enrichment - recommend API via Playwright
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseEnrichData(stat) {
  // winRate can be "100.00%" string or winRate90d can be 0-1 float
  let wr = null
  if (stat.winRate90d != null && stat.winRate90d !== '--') {
    wr = parseFloat(stat.winRate90d)
    if (wr > 0 && wr <= 1) wr *= 100
  } else if (stat.winRate != null) {
    wr = parseFloat(String(stat.winRate).replace('%', ''))
  }

  // maxDrawdown - try 90d first, then generic
  let mdd = null
  if (stat.maxDrawDown90d != null) {
    mdd = typeof stat.maxDrawDown90d === 'string' 
      ? parseFloat(stat.maxDrawDown90d.replace('%', ''))
      : parseFloat(stat.maxDrawDown90d)
    if (mdd > 0 && mdd <= 1) mdd *= 100
  } else if (stat.maximumDrawDown != null) {
    mdd = parseFloat(stat.maximumDrawDown)
    if (mdd > 0 && mdd <= 1) mdd *= 100
  }

  const tc = stat.totalTransactions != null ? parseInt(stat.totalTransactions) : null
  
  // PNL - try 90d cumulative first
  let pnl = null
  if (stat.cumulativeProfitLoss90d != null) pnl = parseFloat(stat.cumulativeProfitLoss90d)
  
  // Sharpe ratio
  let sharpe = null
  if (stat.sharpe90d != null && stat.sharpe90d !== '--') sharpe = parseFloat(stat.sharpe90d)

  // Avg hold time in hours (API gives minutes as string)
  let avgHoldHrs = null
  if (stat.avgHoldTime != null) {
    const mins = parseFloat(stat.avgHoldTime)
    if (!isNaN(mins)) avgHoldHrs = Math.round(mins / 60 * 10) / 10
  }

  // Followers
  let followers = null
  if (stat.strFollowerNum != null) followers = parseInt(String(stat.strFollowerNum).replace(/,/g, ''))

  return { wr, mdd, tc, pnl, sharpe, avgHoldHrs, followers }
}

async function main() {
  console.log('🚀 BingX Fast Enrichment\n')

  // ── Before state ──
  console.log('📊 BEFORE:')
  for (const table of ['trader_snapshots', 'leaderboard_ranks']) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx')
    const { count: noWR } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('win_rate', null)
    const { count: noMDD } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('max_drawdown', null)
    const { count: noTC } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('trades_count', null)
    console.log(`  ${table}: WR null=${noWR}, MDD null=${noMDD}, TC null=${noTC} (total=${total})`)
  }

  // ── Launch browser ──
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }, locale: 'en-US',
  })
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); window.chrome = { runtime: {} } })
  const page = await ctx.newPage()
  let headers = null
  page.on('request', r => {
    if (!headers && r.url().includes('recommend') && r.method() === 'POST')
      headers = Object.fromEntries(Object.entries(r.headers()).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)))
  })

  console.log('\n🌐 Opening BingX...')
  await page.goto('https://bingx.com/en/copytrading/', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await sleep(12000)
  if (!headers) { for (let i = 0; i < 5; i++) { await page.evaluate(() => window.scrollBy(0, 500)); await sleep(2000) } }
  if (!headers) { console.error('❌ No headers'); await browser.close(); process.exit(1) }
  console.log('  ✅ Headers captured')

  // ── Paginate recommend API ──
  const enrichMap = new Map()
  console.log('\n📡 Paginating recommend API...')
  
  for (let pageId = 0; pageId < 30; pageId++) {
    try {
      const result = await page.evaluate(async ({ pageId, headers }) => {
        const r = await fetch(
          `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=${pageId}&pageSize=50`,
          { method: 'POST', headers }
        )
        return await r.json()
      }, { pageId, headers })

      if (result?.code !== 0) { console.log(`  Page ${pageId}: code=${result?.code}`); break }
      
      const items = result?.data?.result || []
      if (!items.length) { console.log(`  Page ${pageId}: empty`); break }

      for (const item of items) {
        const uid = String(item.trader?.uid || '')
        if (!uid) continue
        enrichMap.set(uid, parseEnrichData(item.rankStat || {}))
      }

      console.log(`  Page ${pageId}: +${items.length} (total: ${enrichMap.size}/${result?.data?.total || '?'})`)
      await sleep(700)
    } catch (e) {
      console.log(`  Page ${pageId} error: ${e.message}`)
      break
    }
  }

  await browser.close()
  console.log(`\n📊 Collected: ${enrichMap.size} traders`)

  // Log sample data
  const sample = [...enrichMap.entries()].slice(0, 3)
  for (const [uid, d] of sample) {
    console.log(`  ${uid}: WR=${d.wr}, MDD=${d.mdd}, TC=${d.tc}, PNL=${d.pnl?.toFixed(2)}`)
  }

  if (enrichMap.size === 0) { console.error('❌ No data'); process.exit(1) }

  // ── Update DB ──
  for (const table of ['trader_snapshots', 'leaderboard_ranks']) {
    console.log(`\n📝 Updating ${table}...`)
    
    // Fetch ALL bingx rows (not just null ones) to maximize matches
    let allRows = []
    let offset = 0
    while (true) {
      const { data, error } = await sb
        .from(table)
        .select('id, source_trader_id, win_rate, max_drawdown, trades_count, pnl, followers')
        .eq('source', 'bingx')
        .range(offset, offset + 999)
      if (error) { console.error(`  Error:`, error.message); break }
      if (!data?.length) break
      allRows.push(...data)
      if (data.length < 1000) break
      offset += 1000
    }
    
    let updated = 0, matched = 0
    for (const row of allRows) {
      const d = enrichMap.get(row.source_trader_id)
      if (!d) continue
      matched++
      
      const updates = {}
      if (row.win_rate == null && d.wr != null && !isNaN(d.wr)) updates.win_rate = d.wr
      if (row.max_drawdown == null && d.mdd != null && !isNaN(d.mdd)) updates.max_drawdown = d.mdd
      if (row.trades_count == null && d.tc != null && !isNaN(d.tc)) updates.trades_count = d.tc
      if (row.pnl == null && d.pnl != null && !isNaN(d.pnl)) updates.pnl = d.pnl
      if (row.followers == null && d.followers != null && !isNaN(d.followers)) updates.followers = d.followers
      
      if (!Object.keys(updates).length) continue
      const { error: ue } = await sb.from(table).update(updates).eq('id', row.id)
      if (!ue) updated++
    }
    console.log(`  ${allRows.length} total rows, ${matched} matched API data, ${updated} updated`)
  }

  // ── After ──
  console.log('\n📊 AFTER:')
  for (const table of ['trader_snapshots', 'leaderboard_ranks']) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx')
    const { count: noWR } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('win_rate', null)
    const { count: noMDD } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('max_drawdown', null)
    const { count: noTC } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('trades_count', null)
    console.log(`  ${table}: WR null=${noWR}, MDD null=${noMDD}, TC null=${noTC} (total=${total})`)
  }
  
  console.log('\n✅ Done!')
}

main().catch(e => { console.error(e); process.exit(1) })
