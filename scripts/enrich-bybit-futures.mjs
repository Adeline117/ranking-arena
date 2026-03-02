#!/usr/bin/env node
/**
 * Enrich Bybit Futures leaderboard_ranks: fill win_rate, max_drawdown, trades_count
 * 
 * API: https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income
 * 
 * Target: source = 'bybit' (Futures/Classic copy trading)
 * 
 * Uses period-specific fields:
 * - 7D: sevenDay{WinCount,LossCount,ProfitWinRateE4,DrawDownE4}
 * - 30D: thirtyDay{WinCount,LossCount,ProfitWinRateE4,DrawDownE4}
 * - 90D: ninetyDay{WinCount,LossCount,ProfitWinRateE4,DrawDownE4}
 * 
 * E4 conversion: divide by 100 to get percentage (e.g., 6667 → 66.67%)
 * 
 * Usage:
 *   node scripts/enrich-bybit-futures.mjs
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SOURCE = 'bybit'
const API_BASE = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const PERIOD_PREFIX = {
  '7D': 'sevenDay',
  '30D': 'thirtyDay',
  '90D': 'ninetyDay'
}

// ---------------------------------------------------------------------------
// Fetch trader detail from Bybit API
// ---------------------------------------------------------------------------

async function fetchLeaderIncome(leaderMark) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${API_BASE}?leaderMark=${encodeURIComponent(leaderMark)}`
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000)
      })

      // Rate limit or WAF
      if (res.status === 403) {
        console.log(`    ⚠️ WAF blocked (403) for ${leaderMark.substring(0, 10)}...`)
        return null
      }
      if (res.status === 429) {
        const waitTime = 3000 * (attempt + 1)
        console.log(`    ⏳ Rate limited (429), waiting ${waitTime}ms...`)
        await sleep(waitTime)
        continue
      }

      if (!res.ok) {
        console.log(`    ⚠️ HTTP ${res.status} for ${leaderMark.substring(0, 10)}...`)
        return null
      }

      const text = await res.text()
      
      // WAF sometimes returns HTML
      if (text.startsWith('<')) {
        console.log(`    ⚠️ HTML response (WAF?) for ${leaderMark.substring(0, 10)}...`)
        return null
      }

      const json = JSON.parse(text)
      
      if (json.retCode !== 0) {
        console.log(`    ⚠️ API error retCode=${json.retCode} for ${leaderMark.substring(0, 10)}...`)
        return null
      }

      return json.result

    } catch (err) {
      if (attempt < 2) {
        await sleep(1000)
      } else {
        console.log(`    ⚠️ Fetch error: ${err.message?.substring(0, 50)}`)
      }
    }
  }
  
  return null
}

// ---------------------------------------------------------------------------
// Extract period-specific stats from API response
// ---------------------------------------------------------------------------

function extractPeriodStats(result, seasonId) {
  const prefix = PERIOD_PREFIX[seasonId]
  if (!prefix) {
    console.log(`    ⚠️ Unknown season_id: ${seasonId}`)
    return null
  }

  // Win/loss counts
  const winKey = `${prefix}WinCount`
  const lossKey = `${prefix}LossCount`
  const winCount = parseInt(result[winKey] || '0', 10)
  const lossCount = parseInt(result[lossKey] || '0', 10)
  const totalTrades = winCount + lossCount

  // Win rate (E4 format: divide by 100 for percentage)
  const wrKey = `${prefix}ProfitWinRateE4`
  const wrE4 = parseInt(result[wrKey] || '0', 10)

  // Max drawdown (E4 format)
  const ddKey = `${prefix}DrawDownE4`
  const ddE4 = parseInt(result[ddKey] || '0', 10)

  return {
    win_rate: wrE4 > 0 
      ? wrE4 / 100 
      : (totalTrades > 0 ? (winCount / totalTrades * 100) : null),
    max_drawdown: ddE4 > 0 ? ddE4 / 100 : null,
    trades_count: totalTrades > 0 ? totalTrades : null,
  }
}

// ---------------------------------------------------------------------------
// Main enrichment logic
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60))
  console.log('Bybit Futures Enrichment')
  console.log('='.repeat(60))
  console.log(`Source: ${SOURCE}`)
  console.log(`Target: leaderboard_ranks with missing win_rate/max_drawdown/trades_count`)
  console.log()

  // 1. Fetch all rows needing enrichment
  console.log('📥 Fetching rows from leaderboard_ranks...')
  
  let allRows = []
  let offset = 0
  const limit = 1000

  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id,source_trader_id,season_id,win_rate,max_drawdown,trades_count')
      .eq('source', SOURCE)
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(offset, offset + limit - 1)

    if (error) {
      console.error(`❌ Database error: ${error.message}`)
      process.exit(1)
    }

    if (!data || data.length === 0) break

    allRows.push(...data)
    console.log(`  Fetched ${data.length} rows (total: ${allRows.length})`)

    if (data.length < limit) break
    offset += limit
  }

  console.log(`\n📊 Total rows needing enrichment: ${allRows.length}\n`)

  if (allRows.length === 0) {
    console.log('✅ No rows need enrichment. All done!')
    return
  }

  // 2. Group by trader
  const byTrader = new Map()
  for (const row of allRows) {
    const traderId = row.source_trader_id
    if (!byTrader.has(traderId)) {
      byTrader.set(traderId, [])
    }
    byTrader.get(traderId).push(row)
  }

  const traders = [...byTrader.keys()]
  console.log(`👥 Unique traders: ${traders.length}\n`)

  // 3. Fetch and update
  let updated = 0
  let skipped = 0
  let apiErrors = 0
  let wafBlocked = false

  for (let i = 0; i < traders.length; i++) {
    const traderId = traders[i]
    const rows = byTrader.get(traderId)

    // Progress log
    if ((i + 1) % 10 === 0 || i < 5 || i === traders.length - 1) {
      console.log(`[${i + 1}/${traders.length}] Fetching ${traderId.substring(0, 12)}... (${rows.length} rows)`)
    }

    // Fetch trader data
    const result = await fetchLeaderIncome(traderId)

    if (!result) {
      apiErrors++
      
      // Stop if too many errors (likely WAF block)
      if (apiErrors > 20 && apiErrors > (i + 1) * 0.5) {
        console.log('\n⚠️ Too many API errors detected. Likely WAF blocked. Stopping.')
        wafBlocked = true
        break
      }

      await sleep(800)
      continue
    }

    // Update each row for this trader
    for (const row of rows) {
      const stats = extractPeriodStats(result, row.season_id)
      
      if (!stats) {
        skipped++
        continue
      }

      // Build update object (only update null fields)
      const updateData = {}
      if (row.win_rate == null && stats.win_rate != null) {
        updateData.win_rate = stats.win_rate
      }
      if (row.max_drawdown == null && stats.max_drawdown != null) {
        updateData.max_drawdown = stats.max_drawdown
      }
      if (row.trades_count == null && stats.trades_count != null) {
        updateData.trades_count = stats.trades_count
      }

      if (Object.keys(updateData).length === 0) {
        skipped++
        continue
      }

      // Update row
      const { error } = await sb
        .from('leaderboard_ranks')
        .update(updateData)
        .eq('id', row.id)

      if (error) {
        console.log(`  ⚠️ Update failed for row ${row.id}: ${error.message}`)
        continue
      }

      updated++
    }

    // Rate limiting
    await sleep(300)

    // Periodic status
    if ((i + 1) % 50 === 0 || i === traders.length - 1) {
      console.log(`  Progress: updated=${updated}, skipped=${skipped}, apiErrors=${apiErrors}`)
    }
  }

  // 4. Summary
  console.log('\n' + '='.repeat(60))
  console.log('✅ Enrichment Complete')
  console.log('='.repeat(60))
  console.log(`📊 Results:`)
  console.log(`   Updated:    ${updated}`)
  console.log(`   Skipped:    ${skipped}`)
  console.log(`   API errors: ${apiErrors}`)
  if (wafBlocked) {
    console.log(`   ⚠️ WAF block detected - consider using proxy or increasing delays`)
  }
  console.log('='.repeat(60))
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err)
  process.exit(1)
})
