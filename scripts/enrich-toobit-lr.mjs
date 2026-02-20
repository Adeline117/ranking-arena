#!/usr/bin/env node
/**
 * enrich-toobit-lr.mjs
 * Direct API enrichment for Toobit leaderboard_ranks (WR + MDD + TC)
 *
 * API endpoints:
 *   - leaders-new: leaderProfitOrderRatio (WR), leaderTradeProfit (MDD curve), leaderOrderCount (TC)
 *   - identity-type-leaders: same fields
 *   - leader-detail: lastWeekWinRate (fallback), tradeCount
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
const API_BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

function calcMDD(dailyPnl) {
  if (!Array.isArray(dailyPnl) || dailyPnl.length < 2) return null
  let peak = -Infinity, maxDD = 0
  for (const e of dailyPnl) {
    const v = parseFloat(e.value)
    if (isNaN(v)) continue
    if (v > peak) peak = v
    const dd = peak - v
    if (dd > maxDD) maxDD = dd
  }
  if (maxDD <= 0) return null
  const base = 100 + Math.max(peak, 0)
  return Math.round((maxDD / base) * 10000) / 100 // percentage, 2dp
}

async function main() {
  console.log('=== Toobit Leaderboard Enrichment (Direct API) ===')

  // 1. Get traders from DB
  const { data: traders } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'toobit')
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(500)

  console.log(`Traders needing enrichment: ${traders?.length || 0}`)
  if (!traders?.length) {
    console.log('Nothing to do.')
    return
  }

  const neededIds = new Set(traders.map(t => t.source_trader_id))
  console.log(`Unique trader IDs: ${neededIds.size}`)

  // 2. Collect data from leaderboard APIs
  const apiData = new Map() // traderId -> { wr, mdd, tc }

  // leaders-new (all pages, all periods)
  for (const dt of [7, 30, 90]) {
    for (let page = 1; page <= 10; page++) {
      const data = await fetchJson(`${API_BASE}/leaders-new?pageNo=${page}&pageSize=50&sortBy=roi&sortType=desc&dataType=${dt}`)
      if (!data || data.code !== 200) break
      const items = data.data?.records || data.data?.list || []
      if (!items.length) break

      for (const item of items) {
        const id = String(item.leaderUserId || '')
        if (!id) continue
        const wr = item.leaderProfitOrderRatio != null ? parseFloat(item.leaderProfitOrderRatio) * 100 : null
        const tc = item.leaderOrderCount != null ? parseInt(item.leaderOrderCount) : null
        const mdd = calcMDD(item.leaderTradeProfit)

        const ex = apiData.get(id) || {}
        if (wr != null && ex.wr == null) ex.wr = Math.round(wr * 100) / 100
        if (mdd != null && ex.mdd == null) ex.mdd = mdd
        if (tc != null && ex.tc == null) ex.tc = tc
        apiData.set(id, ex)
      }

      if (items.length < 50) break
      await sleep(200)
    }
  }
  console.log(`After leaders-new: ${apiData.size} traders with data`)

  // identity-type-leaders
  const identity = await fetchJson(`${API_BASE}/identity-type-leaders`)
  if (identity?.code === 200 && identity.data) {
    for (const list of Object.values(identity.data)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const id = String(item.leaderUserId || '')
        if (!id) continue
        const wr = item.leaderProfitOrderRatio != null ? parseFloat(item.leaderProfitOrderRatio) * 100 : null
        const tc = item.leaderOrderCount != null ? parseInt(item.leaderOrderCount) : null
        const ex = apiData.get(id) || {}
        if (wr != null && ex.wr == null) ex.wr = Math.round(wr * 100) / 100
        if (tc != null && ex.tc == null) ex.tc = tc
        apiData.set(id, ex)
      }
    }
  }
  console.log(`After identity-type: ${apiData.size} traders with data`)

  // 3. For remaining traders, use leader-detail (lastWeekWinRate fallback)
  const stillNeeded = [...neededIds].filter(id => !apiData.has(id) || apiData.get(id).wr == null)
  console.log(`Fetching leader-detail for ${stillNeeded.length} remaining traders...`)

  let detailFetched = 0
  for (const id of stillNeeded) {
    const data = await fetchJson(`${API_BASE}/leader-detail?leaderUserId=${id}&dataType=90`)
    if (data?.code === 200 && data.data) {
      const d = data.data
      let wr = d.lastWeekWinRate != null ? parseFloat(d.lastWeekWinRate) * 100 : null
      const tc = d.tradeCount != null ? parseInt(d.tradeCount) : null
      const ex = apiData.get(id) || {}
      if (wr != null && ex.wr == null) ex.wr = Math.round(wr * 100) / 100
      if (tc != null && ex.tc == null) ex.tc = tc
      apiData.set(id, ex)
      detailFetched++
    }
    await sleep(150)
  }
  console.log(`leader-detail fetched: ${detailFetched}`)
  console.log(`Total traders with any data: ${[...apiData.values()].filter(d => d.wr != null || d.mdd != null || d.tc != null).length}`)

  // 4. Update DB
  let updated = 0, failed = 0, noData = 0

  for (const trader of traders) {
    const data = apiData.get(trader.source_trader_id)
    if (!data) { noData++; continue }

    const updates = {}
    if (data.wr != null && trader.win_rate == null) {
      if (data.wr >= 0 && data.wr <= 100) updates.win_rate = data.wr
    }
    if (data.mdd != null && trader.max_drawdown == null) {
      if (data.mdd >= 0 && data.mdd <= 100) updates.max_drawdown = data.mdd
    }
    if (data.tc != null && trader.trades_count == null) {
      if (data.tc > 0) updates.trades_count = data.tc
    }

    if (Object.keys(updates).length === 0) { noData++; continue }

    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', trader.id)
    if (error) {
      console.error(`  ERR ${trader.source_trader_id}: ${error.message}`)
      failed++
    } else {
      updated++
    }
  }

  // 5. Final counts
  const { count: wrNullAfter } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'toobit')
    .is('win_rate', null)

  const { count: mddNullAfter } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'toobit')
    .is('max_drawdown', null)

  console.log(`\nDone: updated=${updated} noData=${noData} failed=${failed}`)
  console.log(`Toobit WR null remaining: ${wrNullAfter}`)
  console.log(`Toobit MDD null remaining: ${mddNullAfter}`)
}

main().catch(e => { console.error(e); process.exit(1) })
