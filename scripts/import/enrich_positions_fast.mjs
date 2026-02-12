#!/usr/bin/env node
/**
 * Fast Position Enrichment - Current positions only (no historical fills)
 * 
 * Usage: node scripts/import/enrich_positions_fast.mjs --source=hyperliquid [--limit=500] [--skip-existing]
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const args = process.argv.slice(2)
const sourceArg = args.find(a => a.startsWith('--source='))?.split('=')[1]
const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1]
const LIMIT = limitArg ? parseInt(limitArg) : 500
const SKIP_EXISTING = args.includes('--skip-existing')
const OFFSET = parseInt(args.find(a => a.startsWith('--offset='))?.split('=')[1] || '0')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

async function fetchJSON(url, options = {}) {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { 'User-Agent': UA, 'Accept': 'application/json', ...options.headers },
        signal: AbortSignal.timeout(10000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 1) await sleep(1000) }
  }
  return null
}

// ============================================
// Hyperliquid - current positions only
// ============================================
async function fetchHyperliquid(address) {
  const data = await fetchJSON('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address }),
  })
  if (!data?.assetPositions?.length) return []
  return data.assetPositions
    .filter(p => parseFloat(p.position?.szi || '0') !== 0)
    .map(p => {
      const pos = p.position
      const size = parseFloat(pos.szi || '0')
      return {
        symbol: pos.coin, direction: size > 0 ? 'long' : 'short',
        entry_price: parseFloat(pos.entryPx || '0') || null,
        max_position_size: Math.abs(size),
        pnl_usd: parseFloat(pos.unrealizedPnl || '0') || null,
        pnl_pct: parseFloat(pos.returnOnEquity || '0') ? parseFloat(pos.returnOnEquity) * 100 : null,
        margin_mode: pos.leverage?.type || 'cross', status: 'open',
      }
    })
}

// ============================================
// OKX - current + closed
// ============================================
async function fetchOkx(uniqueCode) {
  const positions = []
  const current = await fetchJSON(`https://www.okx.com/api/v5/copytrading/public-current-subpositions?instType=SWAP&uniqueCode=${uniqueCode}&limit=50`)
  if (current?.code === '0' && current.data?.length) {
    for (const p of current.data) {
      positions.push({
        symbol: (p.instId || '').replace('-USDT-SWAP', '').replace('-SWAP', ''),
        direction: p.posSide === 'short' ? 'short' : 'long',
        entry_price: parseFloat(p.openAvgPx || '0') || null,
        max_position_size: parseFloat(p.subPos || '0') || null,
        pnl_usd: parseFloat(p.upl || '0') || null,
        margin_mode: p.mgnMode || 'cross', status: 'open',
        open_time: p.openTime ? new Date(parseInt(p.openTime)).toISOString() : null,
      })
    }
  }
  await sleep(300)
  // closed positions - 1 page
  const hist = await fetchJSON(`https://www.okx.com/api/v5/copytrading/public-subpositions-history?instType=SWAP&uniqueCode=${uniqueCode}&limit=50`)
  if (hist?.code === '0' && hist.data?.length) {
    for (const p of hist.data) {
      positions.push({
        symbol: (p.instId || '').replace('-USDT-SWAP', '').replace('-SWAP', ''),
        direction: p.posSide === 'short' ? 'short' : 'long',
        entry_price: parseFloat(p.openAvgPx || '0') || null,
        exit_price: parseFloat(p.closeAvgPx || '0') || null,
        max_position_size: parseFloat(p.subPos || '0') || null,
        closed_size: parseFloat(p.subPos || '0') || null,
        pnl_usd: parseFloat(p.pnl || '0') || null,
        pnl_pct: parseFloat(p.pnlRatio || '0') ? parseFloat(p.pnlRatio) * 100 : null,
        margin_mode: p.mgnMode || 'cross', status: 'closed',
        open_time: p.openTime ? new Date(parseInt(p.openTime)).toISOString() : null,
        close_time: p.closeTime ? new Date(parseInt(p.closeTime)).toISOString() : null,
      })
    }
  }
  return positions
}

// ============================================
// Jupiter Perps
// ============================================
async function fetchJupiter(wallet) {
  // Jupiter v2 API
  const data = await fetchJSON(`https://perps-api.jup.ag/v2/positions?walletAddress=${wallet}`)
  const list = data?.dataList
  if (!list || !Array.isArray(list)) return []
  return list.filter(p => p && p.asset).map(p => ({
    symbol: p.asset || 'UNKNOWN',
    direction: p.side === 'short' ? 'short' : 'long',
    entry_price: parseFloat(p.entryPriceUsd || '0') / 1e6 || null,
    max_position_size: parseFloat(p.sizeUsd || '0') / 1e6 || null,
    pnl_usd: parseFloat(p.pnlAfterFeesUsd || p.pnlBeforeFeesUsd || '0') / 1e6 || null,
    margin_mode: 'cross', status: 'open',
  }))
}

// ============================================
// Upsert
// ============================================
async function upsertPositions(source, traderId, positions) {
  if (!positions?.length) return 0
  const now = new Date().toISOString()
  const records = positions.map(p => ({
    source, source_trader_id: traderId,
    symbol: p.symbol || 'UNKNOWN', direction: p.direction || 'long',
    position_type: 'perpetual', margin_mode: p.margin_mode || 'cross',
    open_time: p.open_time || null, close_time: p.close_time || null,
    entry_price: p.entry_price || null, exit_price: p.exit_price || null,
    max_position_size: p.max_position_size || null, closed_size: p.closed_size || null,
    pnl_usd: p.pnl_usd || null, pnl_pct: p.pnl_pct || null,
    status: p.status || 'open', captured_at: now,
  })).filter(r => r.symbol !== 'UNKNOWN' && r.symbol)

  if (!records.length) return 0

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  await sb.from('trader_position_history').delete()
    .eq('source', source).eq('source_trader_id', traderId).gt('captured_at', sevenDaysAgo)

  const { error } = await sb.from('trader_position_history').insert(records)
  if (error) { console.error(`  ⚠ ${traderId.slice(0,12)}: ${error.message}`); return 0 }
  return records.length
}

// ============================================
// Get traders
// ============================================
async function getTraders(source) {
  const ids = new Set()
  
  // From trader_sources
  let offset = 0
  while (true) {
    const { data } = await sb.from('trader_sources')
      .select('source_trader_id')
      .eq('source', source).eq('is_active', true)
      .range(offset, offset + 999)
    if (!data?.length) break
    data.forEach(t => ids.add(t.source_trader_id))
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
    data.forEach(t => ids.add(t.source_trader_id))
    offset += 1000
    if (data.length < 1000) break
  }

  let uniqueIds = [...ids]
  console.log(`  Total unique traders: ${uniqueIds.length}`)

  if (SKIP_EXISTING) {
    // Use RPC or simple query to get existing trader IDs
    const existing = new Set()
    offset = 0
    while (true) {
      // Query in batches
      const { data: d2 } = await sb.from('trader_position_history')
        .select('source_trader_id')
        .eq('source', source)
        .range(offset, offset + 999)
      if (!d2?.length) break
      d2.forEach(d => existing.add(d.source_trader_id))
      offset += 1000
      if (d2.length < 1000) break
    }
    uniqueIds = uniqueIds.filter(id => !existing.has(id))
    console.log(`  Already covered: ${existing.size}, remaining: ${uniqueIds.length}`)
  }

  return uniqueIds.slice(OFFSET, OFFSET + LIMIT)
}

// ============================================
// Main
// ============================================
const FETCHERS = {
  hyperliquid: { fn: fetchHyperliquid, delayMs: 150 },
  okx_futures: { fn: fetchOkx, delayMs: 500 },
  jupiter_perps: { fn: fetchJupiter, delayMs: 200 },
}

async function main() {
  if (!sourceArg || !FETCHERS[sourceArg]) {
    console.log(`Usage: --source=${Object.keys(FETCHERS).join('|')} [--limit=500] [--skip-existing] [--offset=0]`)
    process.exit(1)
  }

  const { fn, delayMs } = FETCHERS[sourceArg]
  console.log(`\n🚀 Position Enrichment: ${sourceArg}`)
  
  const traders = await getTraders(sourceArg)
  console.log(`  Processing: ${traders.length} traders\n`)

  if (!traders.length) { console.log('Nothing to process'); return }

  let withData = 0, totalPos = 0, errors = 0
  const t0 = Date.now()

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i]
    let posCount = 0
    try {
      const positions = await fn(tid)
      posCount = positions.length
      if (positions.length > 0) {
        const saved = await upsertPositions(sourceArg, tid, positions)
        if (saved > 0) { withData++; totalPos += saved }
      }
    } catch (e) {
      errors++
      if (errors <= 3) console.error(`  ⚠ ${tid.slice(0,15)}: ${e.message}`)
    }
    await sleep(delayMs)

    if (i < 5) console.log(`  #${i+1} ${tid.slice(0,15)} → ${posCount} pos`)
    if ((i + 1) % 100 === 0 || i === traders.length - 1) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1)
      console.log(`  [${i+1}/${traders.length}] withData=${withData} pos=${totalPos} err=${errors} | ${mins}m`)
    }
  }

  console.log(`\n✅ Done: ${withData} traders, ${totalPos} positions, ${errors} errors`)
}

main().catch(console.error)
