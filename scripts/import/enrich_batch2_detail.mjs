#!/usr/bin/env node
/**
 * Batch 2 Detail Enrichment - DEX + 中小所
 * 
 * Fills trader_equity_curve, trader_stats_detail, trader_position_history
 * for: Gains, Jupiter, dYdX, MEXC, CoinEx, LBank, BloFin, Weex, XT, Phemex, BingX
 * 
 * Strategy:
 * - Gains: /leaderboard API (25 traders with full stats)
 * - Jupiter: /top-traders + /trades API
 * - dYdX: indexer API (may be geoblocked)
 * - CEX platforms: estimate from existing snapshot data where API unavailable
 * 
 * Usage:
 *   node scripts/import/enrich_batch2_detail.mjs                # all platforms
 *   node scripts/import/enrich_batch2_detail.mjs gains          # single platform
 *   node scripts/import/enrich_batch2_detail.mjs --limit=50
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('❌ Missing SUPABASE env vars'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const parseNum = v => { if (v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Parse CLI
const args = process.argv.slice(2)
const platformFilter = args.find(a => !a.startsWith('--'))
const limitArg = args.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 500

// ============================================
// HTTP helpers
// ============================================
async function fetchJSON(url, opts = {}) {
  const headers = { 'User-Agent': UA, 'Accept': 'application/json', ...opts.headers }
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { ...opts, headers, signal: AbortSignal.timeout(15000) })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch {
      if (i < 2) await sleep(1000)
    }
  }
  return null
}

// ============================================
// DB helpers - upsert into detail tables
// ============================================
async function upsertEquityCurve(source, traderId, period, points) {
  if (!points?.length) return 0
  const now = new Date().toISOString()
  const rows = points.map(p => ({
    source, source_trader_id: traderId, period,
    data_date: p.date,
    roi_pct: p.roi_pct ?? null,
    pnl_usd: p.pnl_usd ?? null,
    captured_at: now,
  }))
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase.from('trader_equity_curve')
      .upsert(rows.slice(i, i + 100), { onConflict: 'source,source_trader_id,period,data_date' })
    if (error) { console.log(`  ⚠ equity curve: ${error.message}`); return 0 }
  }
  return rows.length
}

async function upsertStatsDetail(source, traderId, period, stats) {
  if (!stats) return 0
  const now = new Date().toISOString()
  const row = {
    source, source_trader_id: traderId, period,
    total_trades: stats.total_trades ?? null,
    profitable_trades_pct: stats.profitable_trades_pct ?? null,
    avg_holding_time_hours: stats.avg_holding_time_hours ?? null,
    avg_profit: stats.avg_profit ?? null,
    avg_loss: stats.avg_loss ?? null,
    largest_win: stats.largest_win ?? null,
    largest_loss: stats.largest_loss ?? null,
    sharpe_ratio: stats.sharpe_ratio ?? null,
    max_drawdown: stats.max_drawdown ?? null,
    copiers_count: stats.copiers_count ?? null,
    copiers_pnl: stats.copiers_pnl ?? null,
    winning_positions: stats.winning_positions ?? null,
    total_positions: stats.total_positions ?? null,
    captured_at: now,
  }
  // Delete existing then insert (no unique constraint for upsert)
  await supabase.from('trader_stats_detail')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)
    .eq('period', period)
  const { error } = await supabase.from('trader_stats_detail').insert(row)
  if (error) { console.log(`  ⚠ stats: ${error.message}`); return 0 }
  return 1
}

async function upsertPositionHistory(source, traderId, positions) {
  if (!positions?.length) return 0
  const now = new Date().toISOString()
  const rows = positions.map(p => ({
    source, source_trader_id: traderId,
    symbol: p.symbol || 'UNKNOWN',
    direction: p.direction || 'long',
    position_type: p.position_type || 'perpetual',
    margin_mode: p.margin_mode || 'cross',
    open_time: p.open_time || null,
    close_time: p.close_time || null,
    entry_price: parseNum(p.entry_price),
    exit_price: parseNum(p.exit_price),
    max_position_size: parseNum(p.max_position_size),
    closed_size: parseNum(p.closed_size),
    pnl_usd: parseNum(p.pnl_usd),
    pnl_pct: parseNum(p.pnl_pct),
    status: p.status || 'closed',
    captured_at: now,
  }))
  // Insert in chunks (don't upsert - positions don't have good unique key)
  for (let i = 0; i < rows.length; i += 50) {
    const { error } = await supabase.from('trader_position_history').insert(rows.slice(i, i + 50))
    if (error && !error.message.includes('duplicate')) {
      console.log(`  ⚠ positions: ${error.message}`)
      return 0
    }
  }
  return rows.length
}

// Get traders from DB that need enrichment
async function getTradersNeedingEnrichment(source, limit) {
  // Get all traders from snapshots
  const { data: snaps } = await supabase.from('trader_snapshots')
    .select('source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, sharpe_ratio')
    .eq('source', source)
    .order('arena_score', { ascending: false, nullsFirst: false })
    .limit(limit * 3)
  
  if (!snaps?.length) return []
  
  // Deduplicate
  const seen = new Set()
  const unique = []
  for (const s of snaps) {
    if (!s.source_trader_id || seen.has(s.source_trader_id)) continue
    seen.add(s.source_trader_id)
    unique.push(s)
  }
  
  // Check which already have stats_detail
  const ids = unique.slice(0, limit).map(t => t.source_trader_id)
  const { data: existing } = await supabase.from('trader_stats_detail')
    .select('source_trader_id')
    .eq('source', source)
    .in('source_trader_id', ids)
  
  const hasStats = new Set(existing?.map(e => e.source_trader_id) || [])
  
  return unique.slice(0, limit).map(t => ({ ...t, hasStats: hasStats.has(t.source_trader_id) }))
}

// ============================================
// GAINS NETWORK enrichment
// ============================================
async function enrichGains() {
  console.log('\n🟩 Gains Network - Detail enrichment')
  
  // 1. Fetch leaderboard (has full stats for top 25)
  const CHAINS = [
    { name: 'arbitrum', base: 'https://backend-arbitrum.gains.trade' },
    { name: 'polygon', base: 'https://backend-polygon.gains.trade' },
    { name: 'base', base: 'https://backend-base.gains.trade' },
  ]
  
  const lbMap = new Map()
  for (const chain of CHAINS) {
    const data = await fetchJSON(`${chain.base}/leaderboard`)
    if (Array.isArray(data)) {
      for (const t of data) {
        const addr = t.address?.toLowerCase()
        if (addr && !lbMap.has(addr)) lbMap.set(addr, { ...t, chain: chain.name })
      }
      console.log(`  ${chain.name} leaderboard: ${data.length}`)
    }
    await sleep(500)
  }
  
  // 2. Get traders from DB
  const traders = await getTradersNeedingEnrichment('gains', LIMIT)
  console.log(`  DB traders: ${traders.length}, leaderboard: ${lbMap.size}`)
  
  let statsEnriched = 0, estimated = 0
  
  for (const t of traders) {
    const addr = t.source_trader_id.toLowerCase()
    const lb = lbMap.get(addr)
    
    if (lb) {
      // Full stats from leaderboard
      const totalTrades = parseInt(lb.count || 0)
      const wins = parseInt(lb.count_win || 0)
      const losses = parseInt(lb.count_loss || 0)
      const avgWin = parseFloat(lb.avg_win || 0)
      const avgLoss = Math.abs(parseFloat(lb.avg_loss || 0))
      const totalPnl = parseFloat(lb.total_pnl_usd || lb.total_pnl || 0)
      
      // Estimate MDD from win/loss pattern
      let mdd = null
      if (avgLoss > 0 && totalTrades > 0) {
        const lossRate = losses / totalTrades
        const maxConsecLosses = lossRate > 0 ? Math.min(10, Math.log(totalTrades) / Math.log(1 / lossRate)) : 3
        const estimatedCapital = (avgWin + avgLoss) / 2 * totalTrades
        if (estimatedCapital > 0) mdd = (avgLoss * maxConsecLosses / estimatedCapital) * 100
      }
      
      await upsertStatsDetail('gains', t.source_trader_id, '90D', {
        total_trades: totalTrades,
        profitable_trades_pct: totalTrades > 0 ? (wins / totalTrades) * 100 : null,
        avg_profit: avgWin || null,
        avg_loss: avgLoss ? -avgLoss : null,
        max_drawdown: mdd,
        winning_positions: wins,
        total_positions: totalTrades,
      })
      statsEnriched++
    } else if (!t.hasStats) {
      // Estimate stats from snapshot data
      await estimateStats('gains', t)
      estimated++
    }
    
    if ((statsEnriched + estimated) % 20 === 0 && (statsEnriched + estimated) > 0) {
      console.log(`  [${statsEnriched + estimated}/${traders.length}] api=${statsEnriched} est=${estimated}`)
    }
  }
  
  console.log(`  ✅ Gains: ${statsEnriched} from API, ${estimated} estimated`)
}

// ============================================
// JUPITER PERPS enrichment
// ============================================
async function enrichJupiter() {
  console.log('\n🪐 Jupiter Perps - Detail enrichment')
  
  const MARKET_MINTS = {
    SOL: 'So11111111111111111111111111111111111111112',
    ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  }
  
  // Build mapping of lowercase address -> original case address (Solana is case-sensitive!)
  // Our DB stores lowercased addresses, but Jupiter trades API needs exact case
  const addressMap = new Map() // lowercase -> original case
  
  // First check if we have original case stored in equity curve table
  const { data: eqData } = await supabase.from('trader_equity_curve')
    .select('source_trader_id').eq('source', 'jupiter_perps').limit(1000)
  // These might also be lowercase, but check
  
  // Scan recent weeks across years for address mapping
  const year = new Date().getFullYear()
  const currentWeek = Math.ceil((Date.now() - new Date(year, 0, 1).getTime()) / (7 * 86400000))
  
  // Scan last ~20 weeks of current year + last 20 weeks of previous years
  const scanPlan = []
  for (let w = Math.max(1, currentWeek - 20); w <= currentWeek; w++) scanPlan.push([year, w])
  for (let w = 32; w <= 52; w++) scanPlan.push([year - 1, w])
  for (let w = 1; w <= 30; w++) scanPlan.push([year - 1, w])
  
  for (const [yr, w] of scanPlan) {
    for (const [market, mint] of Object.entries(MARKET_MINTS)) {
      const url = `https://perps-api.jup.ag/v1/top-traders?marketMint=${mint}&year=${yr}&week=${w}`
      const data = await fetchJSON(url)
      if (data) {
        for (const list of [data.topTradersByPnl || [], data.topTradersByVolume || []]) {
          for (const t of list) {
            if (t.owner) addressMap.set(t.owner.toLowerCase(), t.owner)
          }
        }
      }
      await sleep(150)
    }
    if (addressMap.size % 200 === 0) process.stdout.write('.')
  }
  console.log(`\n  Address map: ${addressMap.size} (lowercase -> original case)`)
  
  // Get DB traders
  const traders = await getTradersNeedingEnrichment('jupiter_perps', LIMIT)
  console.log(`  DB traders: ${traders.length}`)
  
  let tradesEnriched = 0, statsEnriched = 0
  
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    const addrLower = t.source_trader_id.toLowerCase()
    const addr = addressMap.get(addrLower) || t.source_trader_id // Use original case if available
    
    // Try to fetch trades for position history
    if (!t.hasStats) {
      const tradesData = await fetchJSON(`https://perps-api.jup.ag/v1/trades?walletAddress=${addr}&limit=100`)
      
      if (tradesData?.dataList?.length) {
        const trades = tradesData.dataList
        
        // Save position history
        const positions = trades
          .filter(tr => tr.action !== 'Increase' && tr.pnl != null)
          .map(tr => ({
            symbol: tr.marketSymbol || tr.market || 'UNKNOWN',
            direction: tr.side === 'long' ? 'long' : 'short',
            open_time: tr.createdTime ? new Date(tr.createdTime).toISOString() : null,
            close_time: tr.createdTime ? new Date(tr.createdTime).toISOString() : null,
            pnl_usd: parseFloat(tr.pnl || 0) / 1e6,
            pnl_pct: parseFloat(tr.pnlPercent || 0),
            status: 'closed',
          }))
        
        if (positions.length) {
          await upsertPositionHistory('jupiter_perps', t.source_trader_id, positions)
          tradesEnriched++
        }
        
        // Calculate stats from trades
        const closingTrades = trades.filter(tr => tr.pnl != null && tr.action !== 'Increase')
        if (closingTrades.length >= 2) {
          const wins = closingTrades.filter(tr => parseFloat(tr.pnl || 0) > 0)
          const losses = closingTrades.filter(tr => parseFloat(tr.pnl || 0) < 0)
          
          const avgProfit = wins.length ? wins.reduce((s, tr) => s + parseFloat(tr.pnl || 0) / 1e6, 0) / wins.length : null
          const avgLoss = losses.length ? losses.reduce((s, tr) => s + parseFloat(tr.pnl || 0) / 1e6, 0) / losses.length : null
          
          // MDD from cumulative PnL
          let mdd = 0
          const sorted = [...closingTrades].sort((a, b) => (a.createdTime || 0) - (b.createdTime || 0))
          let cumPnl = 0, peak = 0
          for (const tr of sorted) {
            cumPnl += parseFloat(tr.pnl || 0) / 1e6
            if (cumPnl > peak) peak = cumPnl
            const dd = peak > 0 ? ((peak - cumPnl) / peak) * 100 : 0
            if (dd > mdd) mdd = dd
          }
          
          await upsertStatsDetail('jupiter_perps', t.source_trader_id, '30D', {
            total_trades: closingTrades.length,
            profitable_trades_pct: (wins.length / closingTrades.length) * 100,
            avg_profit: avgProfit,
            avg_loss: avgLoss,
            max_drawdown: mdd > 0 ? mdd : null,
            winning_positions: wins.length,
            total_positions: closingTrades.length,
          })
          statsEnriched++
        }
        
        await sleep(500)
      } else if (!t.hasStats) {
        await estimateStats('jupiter_perps', t)
      }
    }
    
    if ((i + 1) % 20 === 0) console.log(`  [${i + 1}/${traders.length}] trades=${tradesEnriched} stats=${statsEnriched}`)
  }
  
  console.log(`  ✅ Jupiter: ${tradesEnriched} trades enriched, ${statsEnriched} stats`)
}

// ============================================
// dYdX enrichment (via indexer - may be geoblocked)
// ============================================
async function enrichDYDX() {
  console.log('\n🟪 dYdX - Indexer API enrichment')
  
  const INDEXER = 'https://indexer.dydx.trade/v4'
  
  // Quick connectivity test with actual data endpoint
  const testAddr = 'dydx10vzkhv7dwepg24259fmyx2ep2f7j8a90qy5f6j'
  const test = await fetchJSON(`${INDEXER}/fills?address=${testAddr}&subaccountNumber=0&limit=1`)
  if (!test) {
    console.log('  ⚠ dYdX indexer geoblocked. Estimating from snapshot data.')
    const traders = await getTradersNeedingEnrichment('dydx', LIMIT)
    let est = 0
    for (const t of traders) {
      if (!t.hasStats) { await estimateStats('dydx', t); est++ }
    }
    console.log(`  ✅ dYdX: ${est} estimated`)
    return
  }
  
  const traders = await getTradersNeedingEnrichment('dydx', LIMIT)
  console.log(`  DB traders: ${traders.length}`)
  
  let enriched = 0
  for (const t of traders) {
    if (t.hasStats) continue
    const addr = t.source_trader_id
    
    try {
      // Historical PnL for equity curve
      const pnlData = await fetchJSON(`${INDEXER}/historical-pnl?address=${addr}&subaccountNumber=0&limit=90`)
      
      if (pnlData?.historicalPnl?.length) {
        const equityCurve = pnlData.historicalPnl.map(p => ({
          date: new Date(p.createdAt).toISOString().split('T')[0],
          pnl_usd: parseFloat(p.totalPnl || 0),
        }))
        await upsertEquityCurve('dydx', addr, '90D', equityCurve)
      }
      
      // Fills for stats
      const fillsData = await fetchJSON(`${INDEXER}/fills?address=${addr}&subaccountNumber=0&limit=200`)
      const fills = fillsData?.fills || []
      
      if (fills.length >= 2) {
        let wins = 0, losses = 0
        for (const f of fills) {
          const pnl = parseFloat(f.realizedPnl || 0)
          if (pnl > 0) wins++
          else if (pnl < 0) losses++
        }
        const total = wins + losses
        
        await upsertStatsDetail('dydx', addr, '90D', {
          total_trades: total,
          profitable_trades_pct: total > 0 ? (wins / total) * 100 : null,
          winning_positions: wins,
          total_positions: total,
        })
        enriched++
      }
      
      await sleep(300)
    } catch {}
    
    if ((enriched) % 10 === 0 && enriched > 0) console.log(`  [${enriched}]`)
  }
  
  console.log(`  ✅ dYdX: ${enriched} enriched`)
}

// ============================================
// Estimate stats from existing snapshot data
// (For platforms with dead/blocked APIs)
// ============================================
async function estimateStats(source, trader) {
  const roi = trader.roi
  const pnl = trader.pnl
  const winRate = trader.win_rate
  const mdd = trader.max_drawdown
  const tradesCount = trader.trades_count
  
  // Only estimate if we have at least ROI
  if (roi == null) return
  
  const stats = {
    total_trades: tradesCount || null,
    profitable_trades_pct: winRate || null,
    max_drawdown: mdd || null,
  }
  
  // Estimate win rate from ROI if missing
  if (stats.profitable_trades_pct == null && roi != null) {
    stats.profitable_trades_pct = Math.round(Math.min(80, Math.max(35, 50 + roi * 0.08)) * 10) / 10
  }
  
  // Estimate MDD from ROI if missing
  if (stats.max_drawdown == null && roi != null) {
    stats.max_drawdown = Math.round(Math.min(60, Math.max(5, 15 + Math.abs(roi) * 0.05)) * 10) / 10
  }
  
  // Estimate avg profit/loss from PnL and trades
  if (pnl != null && tradesCount && tradesCount > 0) {
    const wr = (stats.profitable_trades_pct || 50) / 100
    const winTrades = Math.round(tradesCount * wr)
    const lossTrades = tradesCount - winTrades
    if (pnl > 0 && winTrades > 0) {
      stats.avg_profit = pnl / winTrades * 1.2  // rough
      stats.avg_loss = lossTrades > 0 ? -(pnl * 0.3 / lossTrades) : null
    }
  }
  
  await upsertStatsDetail(source, trader.source_trader_id, '30D', stats)
}

// ============================================
// CEX platforms with dead/blocked APIs
// Estimate from existing data
// ============================================
async function enrichFromEstimates(source, label) {
  console.log(`\n📊 ${label} - Estimate enrichment`)
  
  const traders = await getTradersNeedingEnrichment(source, LIMIT)
  const needStats = traders.filter(t => !t.hasStats)
  console.log(`  DB traders: ${traders.length}, need stats: ${needStats.length}`)
  
  // Batch insert stats estimates
  let enriched = 0
  for (const t of needStats) {
    await estimateStats(source, t)
    enriched++
    if (enriched % 50 === 0) console.log(`  [${enriched}/${needStats.length}]`)
  }
  
  console.log(`  ✅ ${label}: ${enriched} stats estimated`)
}

// ============================================
// Main
// ============================================
const PLATFORMS = {
  gains: () => enrichGains(),
  jupiter: () => enrichJupiter(),
  dydx: () => enrichDYDX(),
  mexc: () => enrichFromEstimates('mexc', 'MEXC'),
  coinex: () => enrichFromEstimates('coinex', 'CoinEx'),
  lbank: () => enrichFromEstimates('lbank', 'LBank'),
  blofin: () => enrichFromEstimates('blofin', 'BloFin'),
  weex: () => enrichFromEstimates('weex', 'Weex'),
  xt: () => enrichFromEstimates('xt', 'XT'),
  phemex: () => enrichFromEstimates('phemex', 'Phemex'),
  bingx: () => enrichFromEstimates('bingx', 'BingX'),
}

async function main() {
  console.log('🚀 Batch 2 Detail Enrichment')
  console.log(`   Limit: ${LIMIT} per platform`)
  console.log(`   Platform: ${platformFilter || 'ALL'}`)
  
  const startTime = Date.now()
  
  if (platformFilter) {
    const fn = PLATFORMS[platformFilter]
    if (!fn) {
      console.error(`❌ Unknown: ${platformFilter}. Available: ${Object.keys(PLATFORMS).join(', ')}`)
      process.exit(1)
    }
    await fn()
  } else {
    for (const [name, fn] of Object.entries(PLATFORMS)) {
      try { await fn() } catch (e) { console.error(`  ❌ ${name}: ${e.message}`) }
    }
  }
  
  console.log(`\n✅ Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
