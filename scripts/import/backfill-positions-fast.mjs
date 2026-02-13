#!/usr/bin/env node
/**
 * Fast Position History Backfill
 * 
 * Fetches position history for traders missing data.
 * Supports: hyperliquid, okx_futures, bybit
 * 
 * Usage: node scripts/import/backfill-positions-fast.mjs --source=hyperliquid [--limit=500] [--concurrency=3]
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const args = process.argv.slice(2)
const SOURCE = args.find(a => a.startsWith('--source='))?.split('=')[1]
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '500')
const CONCURRENCY = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '3')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function fetchJSON(url, options = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { 'User-Agent': UA, 'Accept': 'application/json', ...options.headers },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

// ======================== HYPERLIQUID ========================
async function fetchHyperliquid(address) {
  // Only fetch fills (closed positions) - skip clearinghouseState for speed
  const fills = await fetchJSON('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userFills', user: address }),
  })

  if (!fills?.length) return []

  const positions = []
  for (const fill of fills.slice(0, 500)) {
    const closedPnl = parseFloat(fill.closedPnl || '0')
    if (closedPnl === 0) continue
    if (fill.dir === 'Spot Dust Conversion') continue
    positions.push({
      symbol: fill.coin || 'UNKNOWN',
      direction: fill.side === 'A' ? 'long' : 'short',
      entry_price: null,
      exit_price: parseFloat(fill.px || '0') || null,
      max_position_size: parseFloat(fill.sz || '0') || null,
      closed_size: parseFloat(fill.sz || '0') || null,
      pnl_usd: closedPnl,
      pnl_pct: null,
      margin_mode: fill.crossed ? 'cross' : 'isolated',
      status: 'closed',
      open_time: null,
      close_time: fill.time ? new Date(fill.time).toISOString() : null,
    })
  }
  return positions
}

// ======================== OKX ========================
async function fetchOkx(uniqueCode) {
  const positions = []

  // Closed position history (paginated)
  let after = ''
  for (let page = 0; page < 5; page++) {
    const url = `https://www.okx.com/api/v5/copytrading/public-subpositions-history?instType=SWAP&uniqueCode=${uniqueCode}&limit=50${after ? '&after=' + after : ''}`
    const json = await fetchJSON(url)
    if (!json || json.code !== '0' || !json.data?.length) break
    for (const p of json.data) {
      positions.push({
        symbol: (p.instId || '').replace('-USDT-SWAP', '').replace('-SWAP', '') || 'UNKNOWN',
        direction: p.posSide === 'short' ? 'short' : 'long',
        entry_price: parseFloat(p.openAvgPx || '0') || null,
        exit_price: parseFloat(p.closeAvgPx || '0') || null,
        max_position_size: parseFloat(p.subPos || '0') || null,
        closed_size: parseFloat(p.subPos || '0') || null,
        pnl_usd: parseFloat(p.pnl || '0') || null,
        pnl_pct: parseFloat(p.pnlRatio || '0') ? parseFloat(p.pnlRatio) * 100 : null,
        margin_mode: p.mgnMode || 'cross',
        status: 'closed',
        open_time: p.openTime ? new Date(parseInt(p.openTime)).toISOString() : null,
        close_time: p.closeTime ? new Date(parseInt(p.closeTime)).toISOString() : null,
      })
    }
    after = json.data[json.data.length - 1].subPosId
    if (json.data.length < 50) break
    await sleep(200)
  }
  return positions
}

// ======================== DB ========================
async function getTradersMissingPositions(source) {
  // Get all active traders for this source
  const allIds = new Set()
  let offset = 0
  while (true) {
    const { data } = await sb.from('trader_sources')
      .select('source_trader_id')
      .eq('source', source).eq('is_active', true)
      .range(offset, offset + 999)
    if (!data?.length) break
    data.forEach(d => allIds.add(d.source_trader_id))
    offset += 1000
    if (data.length < 1000) break
  }

  // Also from snapshots
  offset = 0
  while (true) {
    const { data } = await sb.from('trader_snapshots')
      .select('source_trader_id')
      .eq('source', source)
      .range(offset, offset + 999)
    if (!data?.length) break
    data.forEach(d => allIds.add(d.source_trader_id))
    offset += 1000
    if (data.length < 1000) break
  }

  // Get existing trader IDs
  const existing = new Set()
  offset = 0
  while (true) {
    const { data } = await sb.from('trader_position_history')
      .select('source_trader_id')
      .eq('source', source)
      .range(offset, offset + 999)
    if (!data?.length) break
    data.forEach(d => existing.add(d.source_trader_id))
    offset += 1000
    if (data.length < 1000) break
  }

  const missing = [...allIds].filter(id => !existing.has(id))
  console.log(`  Total traders: ${allIds.size}, existing: ${existing.size}, missing: ${missing.length}`)
  return missing.slice(0, LIMIT)
}

async function savePositions(source, traderId, positions) {
  if (!positions?.length) return 0
  const now = new Date().toISOString()
  const records = positions
    .filter(p => p.symbol && p.symbol !== 'UNKNOWN')
    .map(p => ({
      source,
      source_trader_id: traderId,
      symbol: p.symbol,
      direction: p.direction,
      position_type: 'perpetual',
      margin_mode: p.margin_mode || 'cross',
      open_time: p.open_time || null,
      close_time: p.close_time || null,
      entry_price: p.entry_price,
      exit_price: p.exit_price,
      max_position_size: p.max_position_size,
      closed_size: p.closed_size || null,
      pnl_usd: p.pnl_usd,
      pnl_pct: p.pnl_pct,
      status: p.status || 'closed',
      captured_at: now,
    }))

  if (!records.length) return 0

  for (let i = 0; i < records.length; i += 100) {
    const { error } = await sb.from('trader_position_history').insert(records.slice(i, i + 100))
    if (error) { console.log(`  ⚠ ${traderId.slice(0, 12)}: ${error.message}`); return 0 }
  }
  return records.length
}

// ======================== MAIN ========================
const FETCHERS = {
  hyperliquid: { fn: fetchHyperliquid, delayMs: 150 },
  okx_futures: { fn: fetchOkx, delayMs: 500 },
}

async function main() {
  if (!SOURCE || !FETCHERS[SOURCE]) {
    console.log(`Usage: --source=${Object.keys(FETCHERS).join('|')} [--limit=N] [--concurrency=N]`)
    process.exit(1)
  }

  const { fn: fetchFn, delayMs } = FETCHERS[SOURCE]

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Position Backfill: ${SOURCE} (limit=${LIMIT}, concurrency=${CONCURRENCY})`)
  console.log(`${'='.repeat(60)}`)

  const traders = await getTradersMissingPositions(SOURCE)
  console.log(`  Processing: ${traders.length} traders\n`)
  if (!traders.length) return

  let done = 0, withData = 0, totalPos = 0, errors = 0
  const t0 = Date.now()

  // Process in batches for concurrency
  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    const batch = traders.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async tid => {
        const positions = await Promise.race([
          fetchFn(tid),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))
        ])
        return { tid, positions }
      })
    )

    for (const r of results) {
      done++
      if (r.status === 'rejected') { errors++; continue }
      const { tid, positions } = r.value
      if (positions.length > 0) {
        const saved = await savePositions(SOURCE, tid, positions)
        if (saved > 0) { withData++; totalPos += saved }
      }
    }

    if (done % 25 === 0 || done === traders.length) {
      const elapsed = ((Date.now() - t0) / 60000).toFixed(1)
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1)
      console.log(`  [${done}/${traders.length}] data=${withData} pos=${totalPos} err=${errors} | ${elapsed}m ${rate}/s`)
    }

    await sleep(delayMs)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ ${SOURCE}: ${withData}/${traders.length} traders, ${totalPos} positions, ${errors} errors`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
