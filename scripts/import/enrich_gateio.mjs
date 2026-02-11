#!/usr/bin/env node
/**
 * Gate.io Enrichment — fill max_drawdown and win_rate for existing futures traders
 *
 * Uses Playwright to bypass Akamai, re-fetches leader list with all sort orders.
 *
 * Usage: node scripts/import/enrich_gateio.mjs
 */

import { chromium } from 'playwright'
import {
  getSupabaseClient,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'
const PROXY = 'http://127.0.0.1:7890'

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Gate.io Enrichment — Fill max_drawdown & win_rate`)
  console.log(`${'='.repeat(60)}`)

  // Get existing traders missing data (futures only, not CTA)
  const { data: existing } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .not('source_trader_id', 'like', 'cta_%')
    .limit(2000)

  if (!existing?.length) { console.log('No futures traders found'); return }

  const beforeMdd = existing.filter(r => r.max_drawdown == null).length
  const beforeWr = existing.filter(r => r.win_rate == null).length
  console.log(`DB: ${existing.length} futures snapshots`)
  console.log(`Missing max_drawdown: ${beforeMdd}, missing win_rate: ${beforeWr}`)

  // Launch browser
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
  const page = await context.newPage()

  try {
    await page.goto('https://www.gate.io/copytrading', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await sleep(8000)
    console.log('Page:', await page.title().catch(() => '?'))

    // Fetch all leader data from list API
    console.log('\n--- Fetching leader list ---')
    const traderData = await page.evaluate(async () => {
      const data = {}
      const cycles = ['week', 'month', 'quarter']
      const orderBys = ['profit_rate', 'profit', 'aum', 'sharp_ratio', 'max_drawdown', 'win_rate']
      
      for (const cycle of cycles) {
        for (const orderBy of orderBys) {
          for (let pg = 1; pg <= 10; pg++) {
            try {
              const r = await fetch(`/apiw/v2/copy/leader/list?page=${pg}&page_size=100&status=running&order_by=${orderBy}&sort_by=desc&cycle=${cycle}`)
              const j = await r.json()
              const list = j?.data?.list || []
              if (list.length === 0) break
              for (const t of list) {
                const id = String(t.leader_id)
                const wr = parseFloat(t.win_rate || '0') * 100
                const mdd = parseFloat(t.max_drawdown || '0') * 100
                if (!data[id] || (mdd > 0 && !data[id].mdd)) {
                  data[id] = { wr, mdd }
                }
              }
            } catch { break }
          }
        }
      }
      return data
    })

    const traderCount = Object.keys(traderData).length
    console.log(`Fetched data for ${traderCount} traders`)

    await browser.close()

    // Update DB
    console.log('\n--- Updating database ---')
    let updated = 0

    for (const row of existing) {
      const api = traderData[row.source_trader_id]
      if (!api) continue

      const updates = {}
      if (row.win_rate == null && api.wr >= 0) updates.win_rate = api.wr
      if (row.max_drawdown == null && api.mdd >= 0) updates.max_drawdown = api.mdd

      if (Object.keys(updates).length === 0) continue

      const { error } = await supabase
        .from('trader_snapshots')
        .update(updates)
        .eq('source', SOURCE)
        .eq('source_trader_id', row.source_trader_id)
        .eq('season_id', row.season_id)

      if (!error) updated++
    }

    console.log(`Updated ${updated} rows`)

    // After stats
    const { data: after } = await supabase
      .from('trader_snapshots')
      .select('win_rate, max_drawdown')
      .eq('source', SOURCE)
      .not('source_trader_id', 'like', 'cta_%')
      .limit(2000)

    const afterMdd = after.filter(r => r.max_drawdown == null).length
    const afterWr = after.filter(r => r.win_rate == null).length

    console.log(`\n${'='.repeat(60)}`)
    console.log(`✅ Gate.io enrichment done`)
    console.log(`   max_drawdown: ${beforeMdd} missing → ${afterMdd} missing`)
    console.log(`   win_rate: ${beforeWr} missing → ${afterWr} missing`)
    console.log(`${'='.repeat(60)}`)
  } catch (e) {
    console.error('Error:', e.message)
    await browser.close()
  }
}

main().catch(console.error)
