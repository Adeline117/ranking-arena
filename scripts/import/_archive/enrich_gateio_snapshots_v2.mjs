#!/usr/bin/env node
/**
 * Gate.io Enrichment v2 — fills win_rate, max_drawdown, aum in trader_snapshots
 * 
 * Strategy: Navigate the copytrading page with different sort/cycle combos
 * and intercept API responses. The page's own JavaScript handles auth/cookies.
 * Then use page clicking to paginate through results.
 *
 * Usage: node scripts/import/enrich_gateio_snapshots_v2.mjs
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
  console.log(`Gate.io Snapshot Enrichment v2`)
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

  // Get existing trader IDs that need enrichment
  const needingEnrichment = new Set()
  for (const r of (beforeRows || [])) {
    if (r.win_rate == null || r.max_drawdown == null || r.aum == null) {
      needingEnrichment.add(r.source_trader_id)
    }
  }
  console.log(`Traders needing enrichment: ${needingEnrichment.size}`)

  // Launch browser
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

  const traderData = {} // leader_id -> { season -> { pnl, wr, mdd, aum } }

  const page = await context.newPage()

  // Intercept ALL copy leader list responses
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
    // Navigate different sort/cycle URLs directly — triggers the API calls from the page itself
    const cycles = ['week', 'month', 'quarter']
    const orderBys = ['profit_rate', 'profit', 'aum', 'max_drawdown', 'win_rate', 'sharp_ratio', 'follow_profit']

    for (const cycle of cycles) {
      for (const orderBy of orderBys) {
        for (let pg = 1; pg <= 15; pg++) {
          const url = `https://www.gate.com/copytrading?order_by=${orderBy}&sort_by=desc&cycle=${cycle}&page=${pg}`
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
          await sleep(3000)
          
          const prevCount = Object.keys(traderData).length
          // Wait for API response
          await sleep(2000)
          const newCount = Object.keys(traderData).length
          
          if (newCount === prevCount && pg > 1) break // no new data
        }
        console.log(`  ${cycle}/${orderBy}: ${Object.keys(traderData).length} unique traders`)
      }
    }

    // Also try ascending sorts
    for (const cycle of cycles) {
      for (const orderBy of ['profit_rate', 'profit']) {
        for (let pg = 1; pg <= 10; pg++) {
          const url = `https://www.gate.com/copytrading?order_by=${orderBy}&sort_by=asc&cycle=${cycle}&page=${pg}`
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
          await sleep(4000)
          const prevCount = Object.keys(traderData).length
          await sleep(1000)
          if (Object.keys(traderData).length === prevCount && pg > 1) break
        }
      }
    }

    console.log(`\nTotal unique traders fetched: ${Object.keys(traderData).length}`)
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
  console.log(`  tc:     ${before.no_tc} → ${after.no_tc}`)
  console.log(`  mdd:    ${before.no_mdd} → ${after.no_mdd}`)
  console.log(`  aum:    ${before.no_aum} → ${after.no_aum}`)
  console.log(`  Updated: ${updated} rows`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
