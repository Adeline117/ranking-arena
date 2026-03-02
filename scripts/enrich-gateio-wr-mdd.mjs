#!/usr/bin/env node
/**
 * Gate.io Win Rate & Max Drawdown Enrichment
 * 
 * Fetches WR/MDD from Gate.io trader detail page API
 * Source: https://www.gate.io/futures_leaderboard (click trader -> Network tab)
 * 
 * API Endpoint (需要在浏览器Network里确认):
 * - List API: /apiw/v2/copy/leader/list
 * - Detail API: /apiw/v2/copy/leader/detail?leader_id=XXX (待确认)
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.gate.io/futures_leaderboard',
  'Origin': 'https://www.gate.io',
}

const DELAY_MS = 500
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace('%', '').trim())
  return isNaN(n) ? null : n
}

/**
 * Fetch trader detail from Gate.io API
 * TODO: 需要在浏览器里找到正确的API endpoint
 */
async function fetchTraderDetail(leaderId) {
  try {
    // 方法1: 尝试detail endpoint (常见模式)
    const detailUrl = `https://www.gate.io/apiw/v2/copy/leader/detail?leader_id=${leaderId}`
    
    const response = await fetch(detailUrl, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) {
      console.warn(`  ⚠️  HTTP ${response.status} for trader ${leaderId}`)
      return null
    }

    const json = await response.json()
    
    if (json.code !== 0) {
      console.warn(`  ⚠️  API error for ${leaderId}: ${json.message}`)
      return null
    }

    // Parse WR and MDD
    const data = json.data || {}
    let wr = parseNum(data.win_rate)
    let mdd = parseNum(data.max_drawdown || data.mdd || data.maxDrawdown)
    
    // Convert decimals to percentages
    if (wr != null && wr <= 1) wr = Math.round(wr * 10000) / 100
    if (mdd != null && Math.abs(mdd) <= 1) mdd = Math.round(Math.abs(mdd) * 10000) / 100

    return {
      win_rate: wr,
      max_drawdown: mdd ? Math.abs(mdd) : null,
    }
  } catch (error) {
    console.warn(`  ⚠️  Request failed for ${leaderId}: ${error.message}`)
    return null
  }
}

/**
 * Main enrichment process
 */
async function main() {
  console.log('🔍 Fetching Gate.io traders with missing WR/MDD...\n')

  // Get traders with null WR or MDD
  const { data: traders, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, max_drawdown, roi')
    .eq('source', 'gateio')
    .or('win_rate.is.null,max_drawdown.is.null')
    .order('roi', { ascending: false, nullsLast: true })
    .limit(100)

  if (error) {
    console.error('❌ Database error:', error)
    process.exit(1)
  }

  console.log(`Found ${traders.length} traders needing enrichment\n`)

  if (traders.length === 0) {
    console.log('✅ All traders already have WR/MDD data!')
    return
  }

  let updated = 0
  let failed = 0

  for (const trader of traders) {
    console.log(`\n📊 Processing trader ${trader.source_trader_id} (ID ${trader.id})...`)
    console.log(`   Current: WR=${trader.win_rate}, MDD=${trader.max_drawdown}, ROI=${trader.roi}`)

    const detail = await fetchTraderDetail(trader.source_trader_id)

    if (!detail) {
      console.log('   ❌ Failed to fetch detail')
      failed++
      await sleep(DELAY_MS)
      continue
    }

    console.log(`   Fetched: WR=${detail.win_rate}, MDD=${detail.max_drawdown}`)

    // Update database
    const updates = {}
    if (detail.win_rate != null) updates.win_rate = detail.win_rate
    if (detail.max_drawdown != null) updates.max_drawdown = detail.max_drawdown

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await sb
        .from('leaderboard_ranks')
        .update(updates)
        .eq('id', trader.id)

      if (updateError) {
        console.log(`   ❌ Update failed: ${updateError.message}`)
        failed++
      } else {
        console.log(`   ✅ Updated: ${Object.keys(updates).join(', ')}`)
        updated++
      }
    } else {
      console.log('   ⏭️  No new data to update')
    }

    await sleep(DELAY_MS)
  }

  console.log('\n═══════════════════════════════════════')
  console.log(`✅ Enrichment complete!`)
  console.log(`   Updated: ${updated}`)
  console.log(`   Failed: ${failed}`)
  console.log(`   Total processed: ${traders.length}`)
  console.log('═══════════════════════════════════════')
}

main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
