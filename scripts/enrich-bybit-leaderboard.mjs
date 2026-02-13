#!/usr/bin/env node
/**
 * Enrich bybit leaderboard_ranks: fill win_rate, max_drawdown, trades_count
 * Uses api2.bybit.com/fapi/beehive/public/v1/common/leader-income
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const PERIOD_PREFIX = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }

async function fetchLeaderIncome(leaderMark) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(leaderMark)}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }
      )
      if (res.status === 403) return null // WAF
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      const text = await res.text()
      if (text.startsWith('<')) return null
      const json = JSON.parse(text)
      if (json.retCode !== 0) return null
      return json.result
    } catch(e) { if (i < 2) await sleep(1000); else console.log(`    timeout/err: ${e.message?.substring(0,50)}`) }
  }
  return null
}

function extractPeriodStats(result, seasonId) {
  const pfx = PERIOD_PREFIX[seasonId]
  if (!pfx) return null

  // Win/loss counts
  const winKey = pfx + 'WinCount'
  const lossKey = pfx + 'LossCount'
  const winCount = parseInt(result[winKey] || '0')
  const lossCount = parseInt(result[lossKey] || '0')
  const totalTrades = winCount + lossCount

  // Win rate from API (E4)
  const wrKey = pfx + 'ProfitWinRateE4'
  const wrE4 = parseInt(result[wrKey] || '0')

  // Max drawdown (E4)
  const ddKey = pfx + 'DrawDownE4'
  const ddE4 = parseInt(result[ddKey] || '0')

  return {
    win_rate: wrE4 > 0 ? wrE4 / 100 : (totalTrades > 0 ? (winCount / totalTrades * 100) : null),
    max_drawdown: ddE4 > 0 ? ddE4 / 100 : null,
    trades_count: totalTrades > 0 ? totalTrades : null,
  }
}

async function main() {
  console.log('=== Bybit leaderboard_ranks enrichment ===')

  // Get all rows needing enrichment
  let allRows = []
  let from = 0
  while (true) {
    const { data } = await sb.from('leaderboard_ranks')
      .select('id,source_trader_id,season_id,win_rate,max_drawdown,trades_count')
      .eq('source', 'bybit')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(from, from + 999)
    if (!data || data.length === 0) break
    allRows.push(...data)
    from += 1000
    if (data.length < 1000) break
  }

  console.log(`Total rows needing enrichment: ${allRows.length}`)

  // Group by trader
  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const traders = [...byTrader.keys()]
  console.log(`Unique traders: ${traders.length}`)

  let updated = 0, skipped = 0, apiErr = 0, wafBlocked = 0

  for (let i = 0; i < traders.length; i++) {
    const traderId = traders[i]
    const rows = byTrader.get(traderId)

    if ((i + 1) % 10 === 0 || i < 5) console.log(`  Fetching [${i + 1}/${traders.length}] ${traderId.substring(0,10)}...`)

    const result = await fetchLeaderIncome(traderId)
    if (!result) {
      apiErr++
      if (apiErr > 20 && apiErr > (i + 1) * 0.5) {
        console.log('Too many API errors, likely WAF blocked. Stopping.')
        wafBlocked = 1
        break
      }
      await sleep(800)
      continue
    }

    for (const row of rows) {
      const stats = extractPeriodStats(result, row.season_id)
      if (!stats) { skipped++; continue }

      // Only update null fields
      const update = {}
      if (row.win_rate == null && stats.win_rate != null) update.win_rate = stats.win_rate
      if (row.max_drawdown == null && stats.max_drawdown != null) update.max_drawdown = stats.max_drawdown
      if (row.trades_count == null && stats.trades_count != null) update.trades_count = stats.trades_count

      if (Object.keys(update).length === 0) { skipped++; continue }

      const { error } = await sb.from('leaderboard_ranks').update(update).eq('id', row.id)
      if (error) { console.log(`  ⚠ update ${row.id}: ${error.message}`); continue }
      updated++
    }

    await sleep(300)

    if ((i + 1) % 50 === 0 || i === traders.length - 1) {
      console.log(`  [${i + 1}/${traders.length}] updated=${updated} skipped=${skipped} apiErr=${apiErr}`)
    }
  }

  console.log(`\n=== Done ===`)
  console.log(`Updated: ${updated}`)
  console.log(`Skipped: ${skipped}`)
  console.log(`API errors: ${apiErr}`)
  if (wafBlocked) console.log('⚠ WAF blocked detected')
}

main().catch(console.error)
