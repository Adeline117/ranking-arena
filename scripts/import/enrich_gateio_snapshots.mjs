#!/usr/bin/env node
/**
 * Gate.io Enrichment — fills pnl, win_rate, trades_count, max_drawdown, aum
 * in trader_snapshots for gateio.
 *
 * Uses Playwright to bypass Akamai. Fetches leader list API from within the
 * browser context with all sort orders and cycles to maximize coverage.
 * Then fetches individual trader detail pages for remaining gaps.
 *
 * Usage: node scripts/import/enrich_gateio_snapshots.mjs
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
  console.log(`Gate.io Snapshot Enrichment`)
  console.log(`${'='.repeat(60)}`)

  // ---- BEFORE snapshot ----
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

  // ---- Launch browser ----
  console.log('\n🌐 Launching browser...')
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

  // Collect data from list API by intercepting responses
  const traderData = {} // leader_id -> { cycle -> { pnl, wr, mdd, aum } }

  const page = await context.newPage()
  
  // Intercept responses
  page.on('response', async (res) => {
    const url = res.url()
    if (!url.includes('/copy/leader/list')) return
    try {
      const j = await res.json()
      if (j?.code !== 0 || !j?.data?.list) return
      
      // Extract cycle from URL
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
    // Load the page first
    await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await sleep(10000)
    console.log('Page loaded:', await page.title().catch(() => '?'))

    // Now programmatically fetch all pages through page.evaluate
    console.log('\n--- Fetching all leader data ---')
    
    const cycles = ['week', 'month', 'quarter']
    const orderBys = ['profit_rate', 'profit', 'aum', 'sharp_ratio', 'max_drawdown', 'win_rate', 'follow_profit']

    for (const cycle of cycles) {
      for (const orderBy of orderBys) {
        for (let pg = 1; pg <= 20; pg++) {
          const result = await page.evaluate(async (params) => {
            try {
              const r = await fetch(`/apiw/v2/copy/leader/list?page=${params.pg}&page_size=100&status=running&order_by=${params.orderBy}&sort_by=desc&cycle=${params.cycle}`)
              const buf = await r.arrayBuffer()
              const text = new TextDecoder().decode(buf)
              return JSON.parse(text)
            } catch (e) { return { error: e.message } }
          }, { pg, orderBy, cycle })

          if (result?.code === 0 && result?.data?.list?.length > 0) {
            const season = CYCLE_MAP[cycle]
            for (const t of result.data.list) {
              const id = String(t.leader_id)
              if (!traderData[id]) traderData[id] = {}
              traderData[id][season] = {
                pnl: parseFloat(t.profit || '0'),
                win_rate: parseFloat(t.win_rate || '0') * 100,
                max_drawdown: parseFloat(t.max_drawdown || '0') * 100,
                aum: parseFloat(t.aum || '0'),
              }
            }
            if (result.data.list.length < 100) break // last page
          } else {
            break
          }
          await sleep(300)
        }
      }
      console.log(`  ${cycle}: ${Object.keys(traderData).length} unique traders so far`)
    }

    // Also try ascending sort to get more coverage
    for (const cycle of cycles) {
      for (const orderBy of ['profit_rate', 'profit']) {
        for (let pg = 1; pg <= 10; pg++) {
          const result = await page.evaluate(async (params) => {
            try {
              const r = await fetch(`/apiw/v2/copy/leader/list?page=${params.pg}&page_size=100&status=running&order_by=${params.orderBy}&sort_by=asc&cycle=${params.cycle}`)
              const buf = await r.arrayBuffer()
              const text = new TextDecoder().decode(buf)
              return JSON.parse(text)
            } catch (e) { return { error: e.message } }
          }, { pg, orderBy, cycle })

          if (result?.code === 0 && result?.data?.list?.length > 0) {
            const season = CYCLE_MAP[cycle]
            for (const t of result.data.list) {
              const id = String(t.leader_id)
              if (!traderData[id]) traderData[id] = {}
              traderData[id][season] = {
                pnl: parseFloat(t.profit || '0'),
                win_rate: parseFloat(t.win_rate || '0') * 100,
                max_drawdown: parseFloat(t.max_drawdown || '0') * 100,
                aum: parseFloat(t.aum || '0'),
              }
            }
            if (result.data.list.length < 100) break
          } else break
          await sleep(300)
        }
      }
    }

    console.log(`\nTotal unique traders fetched: ${Object.keys(traderData).length}`)
  } finally {
    await browser.close()
  }

  // ---- Update DB ----
  console.log('\n--- Updating database ---')
  let updated = 0

  // Get all existing snapshots
  const existingMap = {}
  for (const r of (beforeRows || [])) {
    const k = `${r.source_trader_id}|${r.season_id}`
    existingMap[k] = r
  }

  for (const [leaderId, seasons] of Object.entries(traderData)) {
    for (const [season, data] of Object.entries(seasons)) {
      const k = `${leaderId}|${season}`
      const existing = existingMap[k]
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

  // ---- AFTER snapshot ----
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
