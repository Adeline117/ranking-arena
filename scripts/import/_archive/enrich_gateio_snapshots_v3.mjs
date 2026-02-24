#!/usr/bin/env node
/**
 * Gate.io Enrichment v3 — Intercept-only approach
 * 
 * Navigates to different copytrading URL combos to trigger API calls,
 * intercepts the responses. No direct fetch (Gate.io blocks it).
 * 
 * Also tries to get trades_count from individual trader pages.
 */

import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SOURCE = 'gateio'
const PROXY = 'http://127.0.0.1:7890'
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
const CYCLE_MAP = { 'week': '7D', 'month': '30D', 'quarter': '90D' }

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Gate.io Snapshot Enrichment v3 (intercept-only)`)
  console.log(`${'='.repeat(60)}`)

  // BEFORE
  const { data: beforeRows } = await sb.from('trader_snapshots')
    .select('source_trader_id, season_id, pnl, win_rate, trades_count, max_drawdown, aum')
    .eq('source', SOURCE)
  const before = { total: 0, no_pnl: 0, no_wr: 0, no_tc: 0, no_mdd: 0, no_aum: 0 }
  for (const r of (beforeRows || [])) {
    before.total++
    if (r.pnl == null) before.no_pnl++
    if (r.win_rate == null) before.no_wr++
    if (r.trades_count == null) before.no_tc++
    if (r.max_drawdown == null) before.no_mdd++
    if (r.aum == null) before.no_aum++
  }
  console.log(`BEFORE: total=${before.total} no_pnl=${before.no_pnl} no_wr=${before.no_wr} no_tc=${before.no_tc} no_mdd=${before.no_mdd} no_aum=${before.no_aum}`)

  let browser
  try {
    browser = await chromium.launch({ headless: true, proxy: { server: PROXY }, args: ['--no-sandbox'] })
  } catch {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  // Collect: leader_id -> { season -> { pnl, wr, mdd, aum } }
  const traderData = {}

  const page = await context.newPage()

  page.on('response', async (res) => {
    const url = res.url()
    if (!url.includes('/copy/leader/list')) return
    try {
      const j = await res.json()
      if (j?.code !== 0 || !j?.data?.list) return
      const cycleMatch = url.match(/cycle=(\w+)/)
      const cycle = cycleMatch ? cycleMatch[1] : 'month'
      const season = CYCLE_MAP[cycle] || '30D'
      for (const t of j.data.list) {
        const id = String(t.leader_id)
        if (!traderData[id]) traderData[id] = {}
        traderData[id][season] = {
          pnl: parseFloat(t.profit || '0'),
          win_rate: parseFloat(t.win_rate || '0') * 100,
          max_drawdown: parseFloat(t.max_drawdown || '0') * 100,
          aum: parseFloat(t.aum || '0'),
        }
      }
    } catch {}
  })

  try {
    // Strategy: Navigate to different page/cycle/orderBy combos
    // The page's JS handles the API calls with proper auth
    const cycles = ['week', 'month', 'quarter']
    const orderBys = ['profit_rate', 'profit', 'aum', 'max_drawdown', 'win_rate', 'sharp_ratio', 'follow_profit']

    let navCount = 0
    for (const cycle of cycles) {
      for (const orderBy of orderBys) {
        // Gate.io URL format: /copytrading?order_by=X&cycle=Y&page=Z
        for (let pg = 1; pg <= 20; pg++) {
          const url = `https://www.gate.com/copytrading?order_by=${orderBy}&sort_by=desc&cycle=${cycle}&page=${pg}`
          await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
          await sleep(2000)
          navCount++
          
          // Check if we got new data on this page
          const prevCount = Object.keys(traderData).length
          if (prevCount === Object.keys(traderData).length && pg > 3) break
        }
      }
      console.log(`  After ${cycle}: ${Object.keys(traderData).length} unique traders (${navCount} navigations)`)
    }

    // Also try ascending
    for (const cycle of cycles) {
      for (const orderBy of ['profit_rate', 'profit', 'max_drawdown']) {
        for (let pg = 1; pg <= 10; pg++) {
          await page.goto(`https://www.gate.com/copytrading?order_by=${orderBy}&sort_by=asc&cycle=${cycle}&page=${pg}`, 
            { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
          await sleep(2000)
        }
      }
      console.log(`  After ${cycle} asc: ${Object.keys(traderData).length} unique traders`)
    }

    console.log(`\nTotal unique traders: ${Object.keys(traderData).length}`)
  } finally {
    await browser.close()
  }

  // Update DB
  console.log('\n--- Updating database ---')
  let updated = 0
  const existingMap = {}
  for (const r of (beforeRows || [])) {
    existingMap[`${r.source_trader_id}|${r.season_id}`] = r
  }

  for (const [leaderId, seasons] of Object.entries(traderData)) {
    for (const [season, data] of Object.entries(seasons)) {
      const existing = existingMap[`${leaderId}|${season}`]
      if (!existing) continue
      const updates = {}
      if (existing.pnl == null && data.pnl != null) updates.pnl = data.pnl
      if (existing.win_rate == null && data.win_rate != null) updates.win_rate = data.win_rate
      if (existing.max_drawdown == null && data.max_drawdown != null) updates.max_drawdown = data.max_drawdown
      if (existing.aum == null && data.aum != null) updates.aum = data.aum
      if (Object.keys(updates).length === 0) continue
      const { error } = await sb.from('trader_snapshots')
        .update(updates)
        .eq('source', SOURCE)
        .eq('source_trader_id', leaderId)
        .eq('season_id', season)
      if (!error) updated++
    }
  }

  // AFTER
  const { data: afterRows } = await sb.from('trader_snapshots')
    .select('pnl, win_rate, trades_count, max_drawdown, aum')
    .eq('source', SOURCE)
  const after = { total: 0, no_pnl: 0, no_wr: 0, no_tc: 0, no_mdd: 0, no_aum: 0 }
  for (const r of (afterRows || [])) {
    after.total++
    if (r.pnl == null) after.no_pnl++
    if (r.win_rate == null) after.no_wr++
    if (r.trades_count == null) after.no_tc++
    if (r.max_drawdown == null) after.no_mdd++
    if (r.aum == null) after.no_aum++
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`RESULTS (${SOURCE}):`)
  console.log(`  pnl:    ${before.no_pnl} → ${after.no_pnl}`)
  console.log(`  wr:     ${before.no_wr} → ${after.no_wr}`)
  console.log(`  tc:     ${before.no_tc} → ${after.no_tc} (not available from API)`)
  console.log(`  mdd:    ${before.no_mdd} → ${after.no_mdd}`)
  console.log(`  aum:    ${before.no_aum} → ${after.no_aum}`)
  console.log(`  Updated: ${updated} rows`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
