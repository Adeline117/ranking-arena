#!/usr/bin/env node
/**
 * Fix bybit leaderboard_ranks max_drawdown (null rows)
 *
 * Root cause: previous enrich scripts skipped DrawDownE4=0,
 * treating it as "no data". But 0 IS valid (trader had no drawdown
 * in that period). This script sets max_drawdown=0 when API returns 0.
 *
 * Direct API works without Puppeteer (api2.bybit.com not WAF-blocked).
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(leaderMark)}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }
      )
      if (res.status === 403) { console.log(`  WAF 403 for ${leaderMark.substring(0, 10)}`); return null }
      if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue }
      if (!res.ok) return null
      const text = await res.text()
      if (text.startsWith('<')) return null  // HTML error page
      const json = JSON.parse(text)
      if (json.retCode !== 0) return null
      return json.result
    } catch (e) {
      if (attempt < 2) await sleep(1000)
      else console.log(`  fetch err ${leaderMark.substring(0, 10)}: ${e.message?.substring(0, 60)}`)
    }
  }
  return null
}

/**
 * Extract max_drawdown for a specific season from the leader-income result.
 * KEY FIX: DrawDownE4=0 is treated as 0.0 (not null).
 * Previous scripts did `ddE4 > 0 ? ... : null` which skipped legit 0% drawdown.
 */
function extractMDD(result, seasonId) {
  const pfx = PERIOD_PREFIX[seasonId]
  if (!pfx) return null

  const ddRaw = result[pfx + 'DrawDownE4']
  if (ddRaw == null || ddRaw === '') return null  // truly missing
  const ddE4 = parseInt(ddRaw)
  if (isNaN(ddE4)) return null
  return ddE4 / 100  // convert E4 (× 10^-4 of 100%) → percent (e.g. 9964 → 99.64%)
}

async function main() {
  console.log('=== Fix bybit max_drawdown (null rows) ===')

  // Get all rows with null max_drawdown
  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, max_drawdown')
      .eq('source', 'bybit')
      .is('max_drawdown', null)
      .range(from, from + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`Total bybit rows with null max_drawdown: ${allRows.length}`)

  // Group by trader
  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const traders = [...byTrader.keys()]
  console.log(`Unique traders: ${traders.length}`)

  let updated = 0, noData = 0, apiErr = 0, apiReturns0 = 0
  const startTime = Date.now()

  for (let i = 0; i < traders.length; i++) {
    const traderId = traders[i]
    const rows = byTrader.get(traderId)

    const result = await fetchLeaderIncome(traderId)
    if (!result) {
      apiErr++
      await sleep(600)
      if (apiErr > 30 && apiErr > (i + 1) * 0.6) {
        console.log('Too many API errors — likely WAF. Stopping.')
        break
      }
      continue
    }

    let rowUpdated = false
    for (const row of rows) {
      const mdd = extractMDD(result, row.season_id)
      if (mdd === null) {
        noData++
        continue
      }
      if (mdd === 0) apiReturns0++

      const { error } = await sb.from('leaderboard_ranks')
        .update({ max_drawdown: mdd })
        .eq('id', row.id)
      if (error) {
        console.log(`  ⚠ update id=${row.id}: ${error.message}`)
      } else {
        updated++
        rowUpdated = true
      }
    }

    await sleep(250)

    if ((i + 1) % 50 === 0 || i === traders.length - 1) {
      const mins = ((Date.now() - startTime) / 60000).toFixed(1)
      console.log(`  [${i + 1}/${traders.length}] updated=${updated} noData=${noData} apiErr=${apiErr} zeroMDD=${apiReturns0} | ${mins}m`)
    }
  }

  console.log('\n=== Done ===')
  console.log(`Updated: ${updated}`)
  console.log(`No data (API null/missing): ${noData}`)
  console.log(`API errors: ${apiErr}`)
  console.log(`Rows set to 0% drawdown: ${apiReturns0}`)

  // Verify
  const { count } = await sb.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bybit')
    .is('max_drawdown', null)
  console.log(`\nRemaining bybit null MDD rows: ${count}`)
}

main().catch(console.error)
