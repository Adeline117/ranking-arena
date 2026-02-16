#!/usr/bin/env node
/**
 * Bulk enrich leaderboard_ranks for platforms with API access.
 * NO estimated/fabricated values — only real API data.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null

async function fetchJSON(url, opts = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts })
    if (!r.ok) return null
    return r.json()
  } catch { return null }
}

// ═══════════════════════════════════════════
// Gains — winRate + totalTrades from stats API
// ═══════════════════════════════════════════
async function enrichGains() {
  console.log('\n' + '═'.repeat(50))
  console.log('Gains — enriching leaderboard_ranks')
  
  let allRows = [], from = 0
  while (true) {
    const { data } = await supabase.from('leaderboard_ranks')
      .select('id, source_trader_id, win_rate, trades_count, max_drawdown')
      .eq('source', 'gains')
      .or('win_rate.is.null,trades_count.is.null')
      .range(from, from + 999)
    if (!data?.length) break
    allRows = allRows.concat(data)
    if (data.length < 1000) break
    from += 1000
  }
  
  // Unique addresses
  const addrMap = new Map()
  for (const r of allRows) {
    if (!addrMap.has(r.source_trader_id)) addrMap.set(r.source_trader_id, [])
    addrMap.get(r.source_trader_id).push(r)
  }
  
  console.log(`  ${allRows.length} rows, ${addrMap.size} unique traders`)
  let updated = 0, failed = 0

  for (const [addr, rows] of addrMap) {
    const stats = await fetchJSON(`https://backend-global.gains.trade/api/personal-trading-history/${addr}/stats?chainId=42161`)
    if (!stats) { failed++; await sleep(300); continue }

    const wr = stats.winRate != null ? parseFloat(parseFloat(stats.winRate).toFixed(2)) : null
    const tc = stats.totalTrades != null ? parseInt(stats.totalTrades) : null

    for (const row of rows) {
      const updates = {}
      if (row.win_rate == null && wr != null) updates.win_rate = wr
      if (row.trades_count == null && tc != null) updates.trades_count = tc
      if (!Object.keys(updates).length) continue
      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) updated++
    }
    if ((updated + failed) % 50 === 0) console.log(`  progress: updated=${updated} failed=${failed}`)
    await sleep(200)
  }
  console.log(`  DONE: updated=${updated} failed=${failed}`)
}

// ═══════════════════════════════════════════
// BloFin — /copytrading/master/detail
// ═══════════════════════════════════════════
async function enrichBlofin() {
  console.log('\n' + '═'.repeat(50))
  console.log('BloFin — enriching leaderboard_ranks')

  let allRows = [], from = 0
  while (true) {
    const { data } = await supabase.from('leaderboard_ranks')
      .select('id, source_trader_id, win_rate, trades_count, max_drawdown')
      .eq('source', 'blofin')
      .or('win_rate.is.null,trades_count.is.null')
      .range(from, from + 999)
    if (!data?.length) break
    allRows = allRows.concat(data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  ${allRows.length} rows to enrich`)
  let updated = 0, failed = 0

  for (const row of allRows) {
    const d = await fetchJSON(`https://openapi.blofin.com/api/v1/copytrading/master/detail?uniqueName=${row.source_trader_id}`)
    if (!d?.data) { failed++; await sleep(500); continue }
    const info = d.data
    const updates = {}
    if (row.win_rate == null && info.winRate != null) updates.win_rate = parseFloat((parseFloat(info.winRate) * 100).toFixed(2))
    if (row.trades_count == null && info.totalTrades != null) updates.trades_count = parseInt(info.totalTrades)
    if (row.max_drawdown == null && info.maxDrawdown != null) updates.max_drawdown = parseFloat((Math.abs(parseFloat(info.maxDrawdown)) * 100).toFixed(2))
    if (Object.keys(updates).length) {
      await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      updated++
    }
    if ((updated + failed) % 20 === 0) console.log(`  progress: updated=${updated} failed=${failed}`)
    await sleep(500)
  }
  console.log(`  DONE: updated=${updated} failed=${failed}`)
}

// ═══════════════════════════════════════════
// Toobit — /v1/copy/trader/info
// ═══════════════════════════════════════════
async function enrichToobit() {
  console.log('\n' + '═'.repeat(50))
  console.log('Toobit — enriching leaderboard_ranks')

  let allRows = [], from = 0
  while (true) {
    const { data } = await supabase.from('leaderboard_ranks')
      .select('id, source_trader_id, win_rate, trades_count, max_drawdown')
      .eq('source', 'toobit')
      .or('win_rate.is.null,trades_count.is.null,max_drawdown.is.null')
      .range(from, from + 999)
    if (!data?.length) break
    allRows = allRows.concat(data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  ${allRows.length} rows to enrich`)
  let updated = 0, failed = 0

  for (const row of allRows) {
    const d = await fetchJSON(`https://www.toobit.com/v1/copy/trader/info?traderId=${row.source_trader_id}`)
    if (!d?.result) { failed++; await sleep(500); continue }
    const info = d.result
    const updates = {}
    if (row.win_rate == null && info.winRate != null) updates.win_rate = parseFloat(parseFloat(info.winRate).toFixed(2))
    if (row.trades_count == null && info.tradeCount != null) updates.trades_count = parseInt(info.tradeCount)
    if (row.max_drawdown == null && info.maxDrawdown != null) updates.max_drawdown = parseFloat(Math.abs(parseFloat(info.maxDrawdown)).toFixed(2))
    if (Object.keys(updates).length) {
      await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      updated++
    }
    await sleep(500)
  }
  console.log(`  DONE: updated=${updated} failed=${failed}`)
}

// ═══════════════════════════════════════════
// Weex — /v1/ct/trader/detail
// ═══════════════════════════════════════════
async function enrichWeex() {
  console.log('\n' + '═'.repeat(50))
  console.log('Weex — enriching leaderboard_ranks')

  let allRows = [], from = 0
  while (true) {
    const { data } = await supabase.from('leaderboard_ranks')
      .select('id, source_trader_id, win_rate, trades_count, max_drawdown')
      .eq('source', 'weex')
      .or('win_rate.is.null,trades_count.is.null,max_drawdown.is.null')
      .range(from, from + 999)
    if (!data?.length) break
    allRows = allRows.concat(data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  ${allRows.length} rows to enrich`)
  let updated = 0, failed = 0

  for (const row of allRows) {
    const d = await fetchJSON(`https://www.weex.com/v1/ct/trader/detail?traderId=${row.source_trader_id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    })
    if (!d?.data) { failed++; await sleep(500); continue }
    const info = d.data
    const updates = {}
    if (row.win_rate == null && info.winRate != null) updates.win_rate = parseFloat(parseFloat(info.winRate).toFixed(2))
    if (row.trades_count == null && info.tradeCount != null) updates.trades_count = parseInt(info.tradeCount)
    if (row.max_drawdown == null && info.maxDrawdown != null) updates.max_drawdown = parseFloat(Math.abs(parseFloat(info.maxDrawdown)).toFixed(2))
    if (Object.keys(updates).length) {
      await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      updated++
    }
    await sleep(500)
  }
  console.log(`  DONE: updated=${updated} failed=${failed}`)
}

// ═══════════════════════════════════════════
// LBank — detail API
// ═══════════════════════════════════════════
async function enrichLbank() {
  console.log('\n' + '═'.repeat(50))
  console.log('LBank — enriching leaderboard_ranks')

  let allRows = [], from = 0
  while (true) {
    const { data } = await supabase.from('leaderboard_ranks')
      .select('id, source_trader_id, win_rate, trades_count, max_drawdown')
      .eq('source', 'lbank')
      .or('win_rate.is.null,trades_count.is.null,max_drawdown.is.null')
      .range(from, from + 999)
    if (!data?.length) break
    allRows = allRows.concat(data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  ${allRows.length} rows to enrich`)
  let updated = 0, failed = 0

  for (const row of allRows) {
    const d = await fetchJSON(`https://www.lbank.com/copy-swap/v1/trader/detail?traderId=${row.source_trader_id}`)
    if (!d?.data) { failed++; await sleep(500); continue }
    const info = d.data
    const updates = {}
    if (row.win_rate == null && info.winRate != null) updates.win_rate = parseFloat(parseFloat(info.winRate).toFixed(2))
    if (row.trades_count == null && info.tradeCount != null) updates.trades_count = parseInt(info.tradeCount)
    if (row.max_drawdown == null && info.maxDrawdown != null) updates.max_drawdown = parseFloat(Math.abs(parseFloat(info.maxDrawdown)).toFixed(2))
    if (Object.keys(updates).length) {
      await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      updated++
    }
    await sleep(500)
  }
  console.log(`  DONE: updated=${updated} failed=${failed}`)
}

// ═══════════════════════════════════════════
// CoinEx — /res/copy/leader/info
// ═══════════════════════════════════════════
async function enrichCoinex() {
  console.log('\n' + '═'.repeat(50))
  console.log('CoinEx — enriching leaderboard_ranks')

  let allRows = [], from = 0
  while (true) {
    const { data } = await supabase.from('leaderboard_ranks')
      .select('id, source_trader_id, win_rate, trades_count, max_drawdown')
      .eq('source', 'coinex')
      .or('win_rate.is.null,trades_count.is.null,max_drawdown.is.null')
      .range(from, from + 999)
    if (!data?.length) break
    allRows = allRows.concat(data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  ${allRows.length} rows to enrich`)
  let updated = 0, failed = 0

  for (const row of allRows) {
    const d = await fetchJSON(`https://www.coinex.com/res/copy/leader/info?leader_id=${row.source_trader_id}`)
    if (!d?.data) { failed++; await sleep(500); continue }
    const info = d.data
    const updates = {}
    if (row.win_rate == null && info.win_rate != null) updates.win_rate = parseFloat((parseFloat(info.win_rate) * 100).toFixed(2))
    if (row.trades_count == null && info.trade_count != null) updates.trades_count = parseInt(info.trade_count)
    if (row.max_drawdown == null && info.max_drawdown != null) updates.max_drawdown = parseFloat((Math.abs(parseFloat(info.max_drawdown)) * 100).toFixed(2))
    if (Object.keys(updates).length) {
      await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      updated++
    }
    await sleep(500)
  }
  console.log(`  DONE: updated=${updated} failed=${failed}`)
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════
const ALL = { gains: enrichGains, blofin: enrichBlofin, toobit: enrichToobit, weex: enrichWeex, lbank: enrichLbank, coinex: enrichCoinex }

async function main() {
  if (SOURCE_FILTER && ALL[SOURCE_FILTER]) {
    await ALL[SOURCE_FILTER]()
  } else {
    for (const [name, fn] of Object.entries(ALL)) {
      if (SOURCE_FILTER && name !== SOURCE_FILTER) continue
      await fn()
    }
  }
  console.log('\nAll done!')
}

main().catch(console.error)
