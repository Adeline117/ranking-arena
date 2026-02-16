#!/usr/bin/env node
/**
 * Enrich trader_snapshots with multi-period data (7d, 30d)
 * Targets: binance_futures, bybit, okx_futures, bitget_futures, bingx
 * NO fabricated data - only real API values
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
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000), ...opts })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

// ═══════════════════════════════════════════
// Binance Futures — multi-period from copy-trade API
// ═══════════════════════════════════════════
async function enrichBinanceFutures() {
  console.log('\nBinance Futures — multi-period enrichment')

  let allRows = [], offset = 0
  while (true) {
    const { data } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, pnl_7d, pnl_30d, win_rate_7d, win_rate_30d, aum')
      .eq('source', 'binance_futures')
      .or('pnl_7d.is.null,pnl_30d.is.null,win_rate_7d.is.null')
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }
  console.log(`  ${allRows.length} rows, ${traderMap.size} unique traders`)

  let updated = 0, failed = 0
  const entries = [...traderMap.entries()]

  for (let i = 0; i < entries.length; i++) {
    const [traderId, rows] = entries[i]

    // Binance copy-trade performance API with different periods
    const results = {}
    for (const [period, days] of [['7d', 7], ['30d', 30]]) {
      const d = await fetchJSON(`https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/performance?portfolioId=${traderId}&timeRange=${days}`)
      if (d?.data) results[period] = d.data
      await sleep(200)
    }

    // Also try to get AUM
    const detail = await fetchJSON(`https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${traderId}`)
    const aum = detail?.data?.totalMarginBalance ? parseFloat(detail.data.totalMarginBalance) : null

    for (const row of rows) {
      const updates = {}
      if (row.pnl_7d == null && results['7d']?.pnl != null) updates.pnl_7d = parseFloat(results['7d'].pnl)
      if (row.pnl_30d == null && results['30d']?.pnl != null) updates.pnl_30d = parseFloat(results['30d'].pnl)
      if (row.win_rate_7d == null && results['7d']?.winRate != null) updates.win_rate_7d = parseFloat((parseFloat(results['7d'].winRate) * 100).toFixed(2))
      if (row.win_rate_30d == null && results['30d']?.winRate != null) updates.win_rate_30d = parseFloat((parseFloat(results['30d'].winRate) * 100).toFixed(2))
      if (row.aum == null && aum != null) updates.aum = aum

      if (!Object.keys(updates).length) continue
      const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) updated++
      else failed++
    }

    if ((i + 1) % 50 === 0 || i < 3) console.log(`  [${i + 1}/${entries.length}] updated=${updated} failed=${failed}`)
    await sleep(300)
  }
  console.log(`  DONE: updated=${updated} failed=${failed}`)
}

// ═══════════════════════════════════════════
// BingX — multi-period from /api/v1/copy/trader/detail
// ═══════════════════════════════════════════
async function enrichBingX() {
  console.log('\nBingX — multi-period enrichment')

  let allRows = [], offset = 0
  while (true) {
    const { data } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, pnl_7d, pnl_30d, win_rate_7d, win_rate_30d, max_drawdown_7d, max_drawdown_30d, aum')
      .eq('source', 'bingx')
      .or('pnl_7d.is.null,win_rate_7d.is.null')
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }
  console.log(`  ${allRows.length} rows, ${traderMap.size} unique traders`)

  let updated = 0, failed = 0
  const entries = [...traderMap.entries()]

  for (let i = 0; i < entries.length; i++) {
    const [traderId, rows] = entries[i]

    const results = {}
    for (const [period, val] of [['7d', '7D'], ['30d', '30D']]) {
      const d = await fetchJSON(`https://bingx.com/api/v1/copy/trader/detail?uid=${traderId}&period=${val}`)
      if (d?.data) results[period] = d.data
      await sleep(300)
    }

    for (const row of rows) {
      const updates = {}
      for (const [period, key] of [['7d', '_7d'], ['30d', '_30d']]) {
        const d = results[period]
        if (!d) continue
        if (row[`pnl${key}`] == null && d.pnl != null) updates[`pnl${key}`] = parseFloat(d.pnl)
        if (row[`win_rate${key}`] == null && d.winRate != null) updates[`win_rate${key}`] = parseFloat((parseFloat(d.winRate) * 100).toFixed(2))
        if (row[`max_drawdown${key}`] == null && d.maxDrawdown != null) updates[`max_drawdown${key}`] = parseFloat((Math.abs(parseFloat(d.maxDrawdown)) * 100).toFixed(2))
      }
      if (row.aum == null && results['30d']?.aum != null) updates.aum = parseFloat(results['30d'].aum)

      if (!Object.keys(updates).length) continue
      const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) updated++
      else failed++
    }

    if ((i + 1) % 30 === 0 || i < 3) console.log(`  [${i + 1}/${entries.length}] updated=${updated} failed=${failed}`)
    await sleep(300)
  }
  console.log(`  DONE: updated=${updated} failed=${failed}`)
}

// ═══════════════════════════════════════════
// OKX Futures — multi-period
// ═══════════════════════════════════════════
async function enrichOKXFutures() {
  console.log('\nOKX Futures — multi-period enrichment')

  let allRows = [], offset = 0
  while (true) {
    const { data } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, pnl_7d, pnl_30d, win_rate_7d, win_rate_30d, max_drawdown_7d, max_drawdown_30d, aum')
      .eq('source', 'okx_futures')
      .or('pnl_7d.is.null,win_rate_7d.is.null')
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }
  console.log(`  ${allRows.length} rows, ${traderMap.size} unique traders`)

  let updated = 0, failed = 0
  const entries = [...traderMap.entries()]

  for (let i = 0; i < entries.length; i++) {
    const [traderId, rows] = entries[i]

    // OKX copy trading detail for different periods
    for (const [period, key] of [['7d', '_7d'], ['30d', '_30d']]) {
      const d = await fetchJSON(`https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&uniqueName=${traderId}&period=${period}`)
      if (!d?.data?.[0]) continue
      const info = d.data[0]
      
      for (const row of rows) {
        const updates = {}
        if (row[`pnl${key}`] == null && info.pnl != null) updates[`pnl${key}`] = parseFloat(info.pnl)
        if (row[`win_rate${key}`] == null && info.winRatio != null) updates[`win_rate${key}`] = parseFloat((parseFloat(info.winRatio) * 100).toFixed(2))
        if (row[`max_drawdown${key}`] == null && info.maxDrawdown != null) updates[`max_drawdown${key}`] = parseFloat((Math.abs(parseFloat(info.maxDrawdown)) * 100).toFixed(2))

        if (!Object.keys(updates).length) continue
        const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', row.id)
        if (!error) updated++
        else failed++
      }
      await sleep(300)
    }

    if ((i + 1) % 30 === 0 || i < 3) console.log(`  [${i + 1}/${entries.length}] updated=${updated} failed=${failed}`)
  }
  console.log(`  DONE: updated=${updated} failed=${failed}`)
}

// ═══════════════════════════════════════════
// Bitget Futures — multi-period
// ═══════════════════════════════════════════
async function enrichBitgetFutures() {
  console.log('\nBitget Futures — multi-period enrichment')

  let allRows = [], offset = 0
  while (true) {
    const { data } = await supabase.from('trader_snapshots')
      .select('id, source_trader_id, pnl_7d, pnl_30d, win_rate_7d, win_rate_30d, max_drawdown_7d, max_drawdown_30d, aum')
      .eq('source', 'bitget_futures')
      .or('pnl_7d.is.null,win_rate_7d.is.null')
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }
  console.log(`  ${allRows.length} rows, ${traderMap.size} unique traders`)

  let updated = 0, failed = 0
  const entries = [...traderMap.entries()]

  for (let i = 0; i < entries.length; i++) {
    const [traderId, rows] = entries[i]

    for (const [period, key] of [['7D', '_7d'], ['30D', '_30d']]) {
      const d = await fetchJSON(`https://www.bitget.com/v1/trigger/trace/public/traderDetail?traderId=${traderId}&statisticsPeriod=${period}`)
      if (!d?.data) continue
      const info = d.data

      for (const row of rows) {
        const updates = {}
        if (row[`pnl${key}`] == null && info.totalProfit != null) updates[`pnl${key}`] = parseFloat(info.totalProfit)
        if (row[`win_rate${key}`] == null && info.winRate != null) updates[`win_rate${key}`] = parseFloat((parseFloat(info.winRate) * 100).toFixed(2))
        if (row[`max_drawdown${key}`] == null && info.maxDrawDown != null) updates[`max_drawdown${key}`] = parseFloat((Math.abs(parseFloat(info.maxDrawDown)) * 100).toFixed(2))

        if (!Object.keys(updates).length) continue
        const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', row.id)
        if (!error) updated++
        else failed++
      }
      await sleep(400)
    }

    if ((i + 1) % 30 === 0 || i < 3) console.log(`  [${i + 1}/${entries.length}] updated=${updated} failed=${failed}`)
  }
  console.log(`  DONE: updated=${updated} failed=${failed}`)
}

// ═══════════════════════════════════════════
const ALL = {
  binance_futures: enrichBinanceFutures,
  bingx: enrichBingX,
  okx_futures: enrichOKXFutures,
  bitget_futures: enrichBitgetFutures,
}

async function main() {
  if (SOURCE_FILTER && ALL[SOURCE_FILTER]) {
    await ALL[SOURCE_FILTER]()
  } else {
    for (const [name, fn] of Object.entries(ALL)) {
      await fn()
    }
  }
  console.log('\nAll multi-period enrichment done!')
}

main().catch(console.error)
