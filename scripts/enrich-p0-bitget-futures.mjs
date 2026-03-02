#!/usr/bin/env node
/**
 * Bitget Futures P0 Enrichment
 * 
 * Priority fields: win_rate, max_drawdown, trades_count
 * Multi-period: 7d, 30d, 90d
 * 
 * Usage: node scripts/enrich-p0-bitget-futures.mjs [--dry-run]
 */
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE = 'bitget_futures'
const API_URL = 'https://www.bitget.com/v1/trigger/trace/public/cycleData'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// CRITICAL: NO fabricated values!
function parseNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace('%', '').trim())
  return isNaN(n) ? null : n
}

async function fetchCycleData(traderId, cycleTime, headers) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      languageType: 0,
      triggerUserId: traderId,
      cycleTime, // 7, 30, or 90
    })
  })
  if (!response.ok) return null
  const json = await response.json()
  if (json.code !== '00000') return null
  return json.data?.statisticsDTO || null
}

async function main() {
  console.log(`\n🚀 Bitget Futures P0 Enrichment (source='${SOURCE}')`)
  if (DRY_RUN) console.log('  [DRY RUN]\n')

  // Get rows needing enrichment
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown, trades_count, roi')
    .eq('source', SOURCE)
    .or('max_drawdown.is.null,win_rate.is.null,trades_count.is.null')
    .limit(1000)

  if (error) { console.error('Query error:', error.message); process.exit(1) }
  console.log(`  DB rows needing enrichment: ${rows.length}`)
  if (rows.length === 0) {
    console.log('  ✅ All rows complete!')
    return
  }

  // Launch browser to get headers (Bitget doesn't require auth, but use real browser headers)
  console.log('🎭 Launching browser for headers...')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  
  // Get standard browser headers
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.bitget.com',
    'Referer': 'https://www.bitget.com/copy-trading/futures',
  }

  // Separate hex IDs from non-hex IDs
  const hexPattern = /^[a-f0-9]{16,}$/i
  const hexRows = rows.filter(r => hexPattern.test(r.source_trader_id))
  const nonHexRows = rows.filter(r => !hexPattern.test(r.source_trader_id))

  console.log(`  Hex IDs: ${hexRows.length}, Non-hex IDs: ${nonHexRows.length}`)

  // Map to store non-hex → hex ID mappings
  const idMap = new Map()

  // For non-hex IDs, visit trader page to find hex ID
  if (nonHexRows.length > 0) {
    console.log('\n🔍 Resolving non-hex IDs via trader pages...')
    let capturedHex = null
    
    for (const row of nonHexRows.slice(0, 50)) { // Limit to 50 to save time
      capturedHex = null
      
      const detailPage = await context.newPage()
      detailPage.on('request', req => {
        if (req.url().includes('/cycleData')) {
          try {
            const body = JSON.parse(req.postData() || '{}')
            if (body.triggerUserId && hexPattern.test(body.triggerUserId)) {
              capturedHex = body.triggerUserId
              console.log(`    ${row.handle} → ${capturedHex}`)
            }
          } catch {}
        }
      })

      try {
        await detailPage.goto(`https://www.bitget.com/copy-trading/futures/trade-center/detail?traderId=${row.source_trader_id}`, {
          waitUntil: 'networkidle',
          timeout: 20000,
        }).catch(() => {})
        await sleep(3000)
        
        if (capturedHex) {
          idMap.set(row.source_trader_id, capturedHex)
        } else {
          console.log(`    ✗ ${row.handle} - no hex ID captured`)
        }
      } catch (e) {
        console.log(`    Error for ${row.handle}: ${e.message.slice(0, 60)}`)
      }
      
      await detailPage.close()
      await sleep(500)
    }
  }

  await browser.close()

  // Now enrich all traders
  console.log('\n📊 Enriching traders...')
  let updated = 0, skipped = 0, errors = 0

  for (const row of rows) {
    let traderId = row.source_trader_id
    
    // Use mapped hex ID if available
    if (!hexPattern.test(traderId)) {
      const hexId = idMap.get(traderId)
      if (!hexId) {
        console.log(`  ✗ ${row.handle} - no hex ID, skipping`)
        skipped++
        continue
      }
      traderId = hexId
    }

    try {
      // Fetch 30d data (main period)
      const data = await fetchCycleData(traderId, 30, headers)
      
      if (!data) {
        console.log(`  ✗ ${row.handle} - API returned no data`)
        errors++
        await sleep(200)
        continue
      }

      const updates = {}
      
      // CRITICAL: Only use real API data, NO formulas or defaults
      if (row.win_rate == null && data.winningRate != null) {
        const wr = parseNum(data.winningRate)
        if (wr != null && wr >= 0 && wr <= 100) updates.win_rate = wr
      }
      
      if (row.max_drawdown == null && data.maxRetracement != null) {
        let mdd = parseNum(data.maxRetracement)
        if (mdd != null) {
          if (mdd > 0) mdd = -mdd // Ensure negative
          if (mdd < -100) mdd = null // Invalid
          if (mdd != null) updates.max_drawdown = Math.abs(mdd)
        }
      }
      
      if (row.trades_count == null && data.totalOrders != null) {
        const tc = parseInt(data.totalOrders)
        if (!isNaN(tc) && tc >= 0) updates.trades_count = tc
      }

      // Also update ROI if missing
      if (row.roi == null && data.roi != null) {
        const roi = parseNum(data.roi)
        if (roi != null) updates.roi = roi
      }

      if (Object.keys(updates).length === 0) {
        console.log(`  - ${row.handle} - no updates needed`)
        skipped++
        continue
      }

      if (DRY_RUN) {
        console.log(`  [DRY] ${row.handle}: ${JSON.stringify(updates)}`)
        updated++
        continue
      }

      const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!ue) {
        updated++
        console.log(`  ✓ ${row.handle}: ${Object.keys(updates).join(', ')}`)
      } else {
        errors++
        console.error(`  Error updating ${row.handle}: ${ue.message}`)
      }
      
      await sleep(150) // Rate limit
    } catch (e) {
      errors++
      console.error(`  Error for ${row.handle}: ${e.message}`)
      await sleep(300)
    }
  }

  console.log(`\n✅ Complete: ${updated} updated, ${skipped} skipped, ${errors} errors`)

  // Final stats
  const { count: mddNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('max_drawdown', null)

  const { count: wrNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('win_rate', null)

  const { count: tcNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('trades_count', null)

  console.log(`\n📊 Final nulls: WR=${wrNull} MDD=${mddNull} TC=${tcNull}`)
}

main().catch(e => { console.error(e); process.exit(1) })
