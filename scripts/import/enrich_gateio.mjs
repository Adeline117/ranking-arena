#!/usr/bin/env node
/**
 * Gate.io Enrichment — fill max_drawdown (and win_rate) for existing futures traders
 *
 * Strategy:
 *   1. Use Playwright to open gate.io (bypass Akamai)
 *   2. Re-fetch leader list with all sort orders to get max_drawdown
 *   3. For traders still missing max_drawdown, call leader detail API per trader
 *   4. UPDATE nulls only
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

  // Get existing traders missing data
  const { data: existing } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', SOURCE)

  if (!existing?.length) {
    console.log('No existing gateio traders found')
    return
  }

  const needsMdd = existing.filter(r => r.max_drawdown == null && !r.source_trader_id.startsWith('cta_'))
  const needsWr = existing.filter(r => r.win_rate == null && !r.source_trader_id.startsWith('cta_'))
  console.log(`DB: ${existing.length} snapshots`)
  console.log(`Futures missing max_drawdown: ${needsMdd.length}`)
  console.log(`Futures missing win_rate: ${needsWr.length}`)

  // Collect IDs that need enrichment
  const needsEnrich = new Set()
  for (const r of [...needsMdd, ...needsWr]) {
    needsEnrich.add(r.source_trader_id)
  }
  console.log(`Unique futures traders needing enrichment: ${needsEnrich.size}`)

  if (needsEnrich.size === 0) {
    console.log('Nothing to do!')
    return
  }

  // Launch browser
  let proxyWorks = true
  console.log('\n🌐 Launching browser...')
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: { server: PROXY },
      args: ['--no-sandbox'],
    })
  } catch {
    console.log('  ⚠ Proxy failed, trying without...')
    proxyWorks = false
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })
  const page = await context.newPage()

  try {
    console.log('  Navigating to gate.io copytrading...')
    await page.goto('https://www.gate.io/copytrading', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(e => console.log('  ⚠ Nav:', e.message))
    await sleep(8000)
    console.log('  Page title:', await page.title().catch(() => '?'))

    // Step 1: Re-fetch leader list with all sort orders to collect max_drawdown
    console.log('\n--- Re-fetching leader list data ---')
    const traderData = new Map() // leader_id -> {win_rate, max_drawdown}

    const fetchResult = await page.evaluate(async () => {
      const data = new Map()
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
                if (!data.has(id) || !data.get(id).maxDrawdown) {
                  data.set(id, {
                    leaderId: id,
                    winRate: parseFloat(t.win_rate || 0) * 100,
                    maxDrawdown: parseFloat(t.max_drawdown || 0) * 100,
                  })
                }
              }
            } catch { break }
          }
        }
      }
      // Convert Map to array for return
      return [...data.values()]
    })

    for (const t of fetchResult) {
      traderData.set(t.leaderId, t)
    }
    console.log(`  Fetched data for ${traderData.size} traders from list API`)

    // Step 2: For traders still missing, try detail API
    const stillMissing = [...needsEnrich].filter(id => {
      const d = traderData.get(id)
      return !d || (!d.maxDrawdown && !d.winRate)
    })

    if (stillMissing.length > 0) {
      console.log(`\n--- Fetching detail for ${stillMissing.length} remaining traders ---`)
      let detailCount = 0
      
      for (const leaderId of stillMissing) {
        if (leaderId.startsWith('cta_') || leaderId.startsWith('spot_')) continue
        
        const detail = await page.evaluate(async (lid) => {
          try {
            const r = await fetch(`/apiw/v2/copy/leader/detail?leader_id=${lid}`)
            const j = await r.json()
            const d = j?.data
            if (!d) return null
            return {
              winRate: parseFloat(d.win_rate || 0) * 100,
              maxDrawdown: parseFloat(d.max_drawdown || 0) * 100,
            }
          } catch { return null }
        }, leaderId)

        if (detail) {
          traderData.set(leaderId, { leaderId, ...detail })
          detailCount++
        }
        await sleep(500)
        
        if (detailCount % 20 === 0 && detailCount > 0) {
          console.log(`  Detail: ${detailCount}/${stillMissing.length}`)
        }
      }
      console.log(`  Fetched ${detailCount} trader details`)
    }

    // Step 3: Update DB
    console.log('\n--- Updating database ---')
    let updated = 0

    for (const row of existing) {
      if (row.source_trader_id.startsWith('cta_')) continue
      
      const apiData = traderData.get(row.source_trader_id)
      if (!apiData) continue

      const updates = {}
      if (row.win_rate == null && apiData.winRate > 0) updates.win_rate = apiData.winRate
      if (row.max_drawdown == null && apiData.maxDrawdown > 0) updates.max_drawdown = apiData.maxDrawdown

      if (Object.keys(updates).length === 0) continue

      const { error } = await supabase
        .from('trader_snapshots')
        .update(updates)
        .eq('source', SOURCE)
        .eq('source_trader_id', row.source_trader_id)
        .eq('season_id', row.season_id)

      if (!error) updated++
    }

    console.log(`  Updated ${updated} snapshot rows`)

  } finally {
    await browser.close()
  }

  // Final stats
  const { data: after } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', SOURCE)

  const afterMdd = after.filter(r => r.max_drawdown == null && !r.source_trader_id.startsWith('cta_')).length
  const afterWr = after.filter(r => r.win_rate == null && !r.source_trader_id.startsWith('cta_')).length

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Gate.io enrichment done`)
  console.log(`   Futures missing max_drawdown: ${needsMdd.length} → ${afterMdd}`)
  console.log(`   Futures missing win_rate: ${needsWr.length} → ${afterWr}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
