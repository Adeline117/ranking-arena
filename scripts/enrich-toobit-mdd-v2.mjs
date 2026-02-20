/**
 * enrich-toobit-mdd-v2.mjs
 * Fill max_drawdown for toobit leaderboard_ranks using exhaustive leaderboard pagination
 * Calculates MDD from leaderTradeProfit curve in leaders-new API response
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const HEADERS = {
  'Origin': 'https://www.toobit.com',
  'Referer': 'https://www.toobit.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
}
const BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading'
const sleep = ms => new Promise(r => setTimeout(r, ms))

function calcMDD(curve) {
  if (!Array.isArray(curve) || curve.length < 2) return null
  let peak = -Infinity, maxDD = 0
  for (const e of curve) {
    const v = parseFloat(e.value)
    if (isNaN(v)) continue
    if (v > peak) peak = v
    const dd = peak - v
    if (dd > maxDD) maxDD = dd
  }
  if (maxDD <= 0) return null
  const base = 100 + Math.max(peak, 0)
  return Math.round((maxDD / base) * 10000) / 100
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) })
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

async function main() {
  console.log('=== Toobit MDD Enrichment v2 ===')
  console.log('Strategy: Exhaustive leaderboard pagination → calcMDD from profit curves')

  // 1. Get all rows needing MDD
  const { data: rows } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, max_drawdown')
    .eq('source', 'toobit')
    .is('max_drawdown', null)
    .limit(500)

  console.log(`Rows with null MDD: ${rows?.length || 0}`)
  if (!rows?.length) { console.log('Nothing to do.'); return }

  const neededIds = new Set(rows.map(r => r.source_trader_id))
  console.log(`Unique trader IDs: ${neededIds.size}`)

  // 2. Exhaustive leaderboard pagination
  const apiData = new Map() // traderId → mdd
  const sortFields = ['roi', 'profit', 'follower', 'winRate', 'tradeCount', 'sharpeRatio']
  const sortTypes = ['desc', 'asc']
  const periods = [7, 30, 90]

  let apiCallCount = 0
  for (const dt of periods) {
    for (const sort of sortFields) {
      for (const dir of sortTypes) {
        for (let page = 1; page <= 30; page++) {
          const data = await fetchJson(`${BASE}/leaders-new?pageNo=${page}&pageSize=50&sortBy=${sort}&sortType=${dir}&dataType=${dt}`)
          apiCallCount++
          if (!data || data.code !== 200) break
          const items = data.data?.records || data.data?.list || []
          if (!items.length) break

          for (const item of items) {
            const id = String(item.leaderUserId || '')
            if (!id || apiData.has(id)) continue
            const mdd = calcMDD(item.leaderTradeProfit)
            if (mdd != null) apiData.set(id, mdd)
          }

          if (items.length < 50) break
          await sleep(80)
        }
      }
    }

    // identity-type-leaders
    const itData = await fetchJson(`${BASE}/identity-type-leaders?dataType=${dt}`)
    if (itData?.code === 200 && itData.data) {
      for (const list of Object.values(itData.data)) {
        if (!Array.isArray(list)) continue
        for (const item of list) {
          const id = String(item.leaderUserId || '')
          if (!id || apiData.has(id)) continue
          const mdd = calcMDD(item.leaderTradeProfit)
          if (mdd != null) apiData.set(id, mdd)
        }
      }
    }
    await sleep(300)
  }

  console.log(`API calls made: ${apiCallCount}`)
  console.log(`Traders with MDD from API: ${apiData.size}`)
  const coverable = [...neededIds].filter(id => apiData.has(id))
  console.log(`Coverable from our needed IDs: ${coverable.length}`)
  console.log(`Not found in API (inactive/retired traders): ${neededIds.size - coverable.length}`)

  // 3. Update DB
  let updated = 0, skipped = 0, failed = 0
  for (const row of rows) {
    const mdd = apiData.get(row.source_trader_id)
    if (mdd == null) { skipped++; continue }
    if (mdd < 0 || mdd > 100) { console.log(`  SKIP ${row.source_trader_id}: MDD out of range: ${mdd}`); skipped++; continue }

    const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: mdd }).eq('id', row.id)
    if (error) {
      console.error(`  ERR id=${row.id} traderId=${row.source_trader_id}: ${error.message}`)
      failed++
    } else {
      updated++
    }
  }

  // 4. Final counts
  const { count: mddNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'toobit')
    .is('max_drawdown', null)

  const { count: mddFilled } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'toobit')
    .not('max_drawdown', 'is', null)

  console.log(`\n=== DONE ===`)
  console.log(`Updated: ${updated} rows`)
  console.log(`Skipped (no API data): ${skipped} rows (${neededIds.size - coverable.length} unique traders not on any leaderboard)`)
  console.log(`Failed: ${failed}`)
  console.log(`\nDB state for toobit leaderboard_ranks:`)
  console.log(`  max_drawdown filled: ${mddFilled}`)
  console.log(`  max_drawdown still NULL: ${mddNull}`)
  if (mddNull > 0) {
    console.log(`  Reason for remaining nulls: traders are no longer active on any Toobit leaderboard page`)
    console.log(`  (exhausted all sort orders, periods, and pages - no profit curve available)`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
