#!/usr/bin/env node
/**
 * Gate.io Enrichment v4 — Route interception approach
 * 
 * Uses Playwright route() to modify page_size in the page's own API requests.
 * Then triggers additional pages by intercepting and modifying page numbers.
 * Also cycles through week/month/quarter by triggering the page's cycle selector.
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
  console.log(`Gate.io Snapshot Enrichment v4 (route interception)`)
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

  // leader_id -> { season -> { pnl, wr, mdd, aum } }
  const traderData = {}
  let targetPage = 1

  const page = await context.newPage()

  // Route: modify page_size and page number
  await page.route('**/copy/leader/list**', async (route, request) => {
    const url = new URL(request.url())
    url.searchParams.set('page_size', '100') // max allowed
    url.searchParams.set('page', String(targetPage))
    await route.continue({ url: url.toString() })
  })

  page.on('response', async (res) => {
    const url = res.url()
    if (!url.includes('/copy/leader/list')) return
    try {
      const j = await res.json()
      if (j?.code !== 0 || !j?.data?.list) return
      const cm = url.match(/cycle=(\w+)/)
      const cycle = cm ? cm[1] : 'month'
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
    // Load page 1 (month cycle is default)
    console.log('\n--- Loading month cycle ---')
    targetPage = 1
    await page.goto('https://www.gate.com/copytrading', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
    await sleep(10000)
    console.log(`  Page 1: ${Object.keys(traderData).length} unique traders`)

    // Load pages 2-4 by reloading with different target
    for (let pg = 2; pg <= 5; pg++) {
      targetPage = pg
      await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
      await sleep(5000)
      console.log(`  Page ${pg}: ${Object.keys(traderData).length} unique traders`)
    }

    // Switch to week cycle
    console.log('\n--- Loading week cycle ---')
    // Find cycle selector tabs
    const weekTab = page.locator('text="7 Days"').first()
    if (await weekTab.isVisible().catch(() => false)) {
      targetPage = 1
      await weekTab.click()
      await sleep(5000)
      console.log(`  Week page 1: ${Object.keys(traderData).length}`)
      for (let pg = 2; pg <= 5; pg++) {
        targetPage = pg
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
        await sleep(5000)
        console.log(`  Week page ${pg}: ${Object.keys(traderData).length}`)
      }
    } else {
      console.log('  Week tab not found, trying different selectors...')
      // Try alternative: look for text containing "7" or "Week"
      const tabs = await page.evaluate(() => {
        const spans = document.querySelectorAll('span, div, button');
        return Array.from(spans).filter(s => {
          const t = s.textContent?.trim();
          return t && (t === '7D' || t === '7 Days' || t === 'Week' || t === '1W');
        }).map(s => ({ text: s.textContent?.trim(), tag: s.tagName }));
      });
      console.log('  Found tabs:', tabs);
    }

    // Switch to quarter cycle  
    console.log('\n--- Loading quarter cycle ---')
    const quarterTab = page.locator('text="90 Days"').first()
    if (await quarterTab.isVisible().catch(() => false)) {
      targetPage = 1
      await quarterTab.click()
      await sleep(5000)
      console.log(`  Quarter page 1: ${Object.keys(traderData).length}`)
      for (let pg = 2; pg <= 5; pg++) {
        targetPage = pg
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
        await sleep(5000)
        console.log(`  Quarter page ${pg}: ${Object.keys(traderData).length}`)
      }
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
  console.log(`  tc:     ${before.no_tc} → ${after.no_tc} (not in list API)`)
  console.log(`  mdd:    ${before.no_mdd} → ${after.no_mdd}`)
  console.log(`  aum:    ${before.no_aum} → ${after.no_aum}`)
  console.log(`  Updated: ${updated} rows`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
