#!/usr/bin/env node
/**
 * All-Platform Position History Enrichment
 * 
 * Fetches positions for ALL traders across platforms and saves to trader_position_history.
 * Uses direct API calls (no browser) for platforms that support it.
 * 
 * Supported: hyperliquid, okx_futures, binance_futures (via VPS), gate.io, htx
 * 
 * Usage: node scripts/import/enrich_all_positions.mjs --source=hyperliquid [--limit=500] [--skip-existing]
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

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

// ============================================
// Hyperliquid
// ============================================
async function fetchHyperliquidPositions(address) {
  const data = await fetchJSON('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address }),
  })
  if (!data?.assetPositions?.length) return []
  
  const openPositions = data.assetPositions
    .filter(p => parseFloat(p.position?.szi || '0') !== 0)
    .map(p => {
      const pos = p.position
      const size = parseFloat(pos.szi || '0')
      return {
        symbol: pos.coin || 'UNKNOWN',
        direction: size > 0 ? 'long' : 'short',
        entry_price: parseFloat(pos.entryPx || '0') || null,
        exit_price: null,
        max_position_size: Math.abs(size),
        pnl_usd: parseFloat(pos.unrealizedPnl || '0') || null,
        pnl_pct: parseFloat(pos.returnOnEquity || '0') ? parseFloat(pos.returnOnEquity) * 100 : null,
        margin_mode: pos.leverage?.type || 'cross',
        status: 'open',
        open_time: null, close_time: null,
      }
    })

  // Also fetch fills for closed positions
  await sleep(100)
  const fills = await fetchJSON('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userFills', user: address }),
  })

  const closedPositions = []
  if (fills?.length) {
    for (const fill of fills.slice(0, 500)) {
      const closedPnl = parseFloat(fill.closedPnl || '0')
      if (closedPnl === 0) continue
      if (fill.dir === 'Spot Dust Conversion') continue
      closedPositions.push({
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
  }

  return [...openPositions, ...closedPositions]
}

// ============================================
// OKX Futures
// ============================================
async function fetchOkxPositions(uniqueCode) {
  const positions = []
  
  // Current open positions
  const current = await fetchJSON(`https://www.okx.com/api/v5/copytrading/public-current-subpositions?instType=SWAP&uniqueCode=${uniqueCode}&limit=50`)
  if (current?.code === '0' && current.data?.length) {
    for (const p of current.data) {
      positions.push({
        symbol: (p.instId || '').replace('-USDT-SWAP', '').replace('-SWAP', '') || 'UNKNOWN',
        direction: p.posSide === 'short' ? 'short' : 'long',
        entry_price: parseFloat(p.openAvgPx || '0') || null,
        exit_price: null,
        max_position_size: parseFloat(p.subPos || '0') || null,
        pnl_usd: parseFloat(p.upl || '0') || null,
        pnl_pct: parseFloat(p.uplRatio || '0') ? parseFloat(p.uplRatio) * 100 : null,
        margin_mode: p.mgnMode || 'cross',
        status: 'open',
        open_time: p.openTime ? new Date(parseInt(p.openTime)).toISOString() : null,
        close_time: null,
      })
    }
  }

  // Closed position history
  await sleep(300)
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
    await sleep(300)
  }

  return positions
}

// ============================================
// Jupiter Perps (Solana)
// ============================================
async function fetchJupiterPositions(traderId) {
  // Jupiter Perps uses on-chain data
  const url = `https://perps-api.jup.ag/v1/positions/${traderId}`
  const data = await fetchJSON(url)
  if (!data || !Array.isArray(data)) return []
  
  return data.map(p => ({
    symbol: p.market || p.symbol || 'UNKNOWN',
    direction: p.side === 'short' ? 'short' : 'long',
    entry_price: parseFloat(p.entryPrice || '0') || null,
    exit_price: null,
    max_position_size: parseFloat(p.size || p.positionSize || '0') || null,
    pnl_usd: parseFloat(p.pnl || p.unrealizedPnl || '0') || null,
    pnl_pct: null,
    margin_mode: 'cross',
    status: 'open',
    open_time: p.openedAt ? new Date(p.openedAt).toISOString() : null,
    close_time: null,
  }))
}

// ============================================
// Upsert to DB
// ============================================
async function upsertPositions(source, traderId, positions) {
  if (!positions?.length) return 0
  const now = new Date().toISOString()

  const records = positions.map(p => ({
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
  })).filter(r => r.symbol !== 'UNKNOWN')

  if (records.length === 0) return 0

  // Delete recent entries for this trader
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  await sb.from('trader_position_history')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)
    .gt('captured_at', sevenDaysAgo)

  // Insert in batches of 100
  for (let i = 0; i < records.length; i += 100) {
    const batch = records.slice(i, i + 100)
    const { error } = await sb.from('trader_position_history').insert(batch)
    if (error) { console.log(`  ⚠ insert: ${error.message}`); return 0 }
  }
  return records.length
}

// ============================================
// Get traders to process
// ============================================
async function getTraders(source) {
  // Get all traders from trader_sources
  const allTraders = []
  let offset = 0
  while (true) {
    const { data } = await sb.from('trader_sources')
      .select('source_trader_id')
      .eq('source', source)
      .eq('is_active', true)
      .range(offset, offset + 999)
    if (!data?.length) break
    allTraders.push(...data)
    offset += 1000
    if (data.length < 1000) break
  }
  
  // Also get from trader_snapshots if not enough
  if (allTraders.length < 100) {
    const { data: snapTraders } = await sb.from('trader_snapshots')
      .select('source_trader_id')
      .eq('source', source)
      .limit(5000)
    if (snapTraders?.length) {
      const existingIds = new Set(allTraders.map(t => t.source_trader_id))
      for (const t of snapTraders) {
        if (!existingIds.has(t.source_trader_id)) {
          allTraders.push(t)
          existingIds.add(t.source_trader_id)
        }
      }
    }
  }

  const uniqueIds = [...new Set(allTraders.map(t => t.source_trader_id))]

  if (SKIP_EXISTING) {
    // Get traders who already have position data
    const existing = new Set()
    let page = 0
    while (true) {
      const { data } = await sb.from('trader_position_history')
        .select('source_trader_id')
        .eq('source', source)
        .range(page * 1000, (page + 1) * 1000 - 1)
      if (!data?.length) break
      data.forEach(d => existing.add(d.source_trader_id))
      page++
      if (data.length < 1000) break
    }
    const filtered = uniqueIds.filter(id => !existing.has(id))
    console.log(`  Unique: ${uniqueIds.length}, already covered: ${existing.size}, remaining: ${filtered.length}`)
    return filtered.slice(0, LIMIT)
  }

  return uniqueIds.slice(0, LIMIT)
}

// ============================================
// Platform dispatcher
// ============================================
const FETCHERS = {
  hyperliquid: { fn: fetchHyperliquidPositions, delayMs: 200 },
  okx_futures: { fn: fetchOkxPositions, delayMs: 600 },
  jupiter_perps: { fn: fetchJupiterPositions, delayMs: 300 },
}

async function main() {
  if (!sourceArg || !FETCHERS[sourceArg]) {
    console.log(`Usage: --source=${Object.keys(FETCHERS).join('|')}`)
    console.log('Available sources:', Object.keys(FETCHERS).join(', '))
    process.exit(1)
  }

  const { fn: fetchFn, delayMs } = FETCHERS[sourceArg]

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Position Enrichment: ${sourceArg} (limit=${LIMIT}, skipExisting=${SKIP_EXISTING})`)
  console.log(`${'='.repeat(60)}`)

  const traders = await getTraders(sourceArg)
  console.log(`Processing: ${traders.length} traders`)

  if (traders.length === 0) { console.log('Nothing to process'); return }

  let tradersWithData = 0, totalPositions = 0, errors = 0
  const startTime = Date.now()

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i]
    try {
      const positions = await fetchFn(tid)
      if (positions.length > 0) {
        const saved = await upsertPositions(sourceArg, tid, positions)
        if (saved > 0) {
          tradersWithData++
          totalPositions += saved
        }
      }
    } catch (e) {
      errors++
      if (errors <= 5) console.log(`  ⚠ ${tid.slice(0, 15)}: ${e.message}`)
    }

    await sleep(delayMs)

    if ((i + 1) % 50 === 0 || i === traders.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      const rate = ((i + 1) / ((Date.now() - startTime) / 1000)).toFixed(1)
      console.log(`  [${i + 1}/${traders.length}] traders=${tradersWithData} pos=${totalPositions} err=${errors} | ${elapsed}m ${rate}/s`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ ${sourceArg} position enrichment done`)
  console.log(`   Traders with data: ${tradersWithData}/${traders.length}`)
  console.log(`   Total positions saved: ${totalPositions}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
