#!/usr/bin/env node
/**
 * OKX Futures Detail Enrichment
 * 
 * Fills: trader_equity_curve, trader_stats_detail, trader_position_history, trader_portfolio
 * 
 * APIs (all public, no auth needed):
 *   - public-lead-traders?uniqueCode=X  → pnlRatios (equity curve), winRatio, traderInsts
 *   - public-current-subpositions?uniqueCode=X → current portfolio
 *   - public-weekly-pnl?uniqueCode=X → weekly PnL
 * 
 * Usage: node scripts/import/enrich_okx_detail.mjs [--limit=200]
 */

import 'dotenv/config'
import { sb, sleep } from './lib/index.mjs'

const SOURCE = 'okx_futures'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const BASE = 'https://www.okx.com/api/v5/copytrading'

const limitArg = process.argv.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 200

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, signal: AbortSignal.timeout(15000) })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

// ============================================
// Fetch trader detail (pnlRatios, instruments, stats)
// ============================================
async function fetchTraderDetail(uniqueCode) {
  const json = await fetchJSON(`${BASE}/public-lead-traders?instType=SWAP&uniqueCode=${uniqueCode}`)
  if (!json || json.code !== '0' || !json.data?.[0]?.ranks?.[0]) return null
  return json.data[0].ranks[0]
}

// ============================================
// Fetch current positions (portfolio)
// ============================================
async function fetchPositions(uniqueCode) {
  const json = await fetchJSON(`${BASE}/public-current-subpositions?instType=SWAP&uniqueCode=${uniqueCode}&limit=50`)
  if (!json || json.code !== '0') return []
  return json.data || []
}

// ============================================
// Fetch closed position history
// ============================================
async function fetchPositionHistory(uniqueCode) {
  const all = []
  let after = ''
  for (let page = 0; page < 5; page++) { // max 5 pages = ~250 positions
    const url = `${BASE}/public-subpositions-history?instType=SWAP&uniqueCode=${uniqueCode}&limit=50${after ? '&after=' + after : ''}`
    const json = await fetchJSON(url)
    if (!json || json.code !== '0' || !json.data?.length) break
    all.push(...json.data)
    after = json.data[json.data.length - 1].subPosId
    if (json.data.length < 50) break
    await sleep(300)
  }
  return all
}

// ============================================
// Fetch weekly PnL
// ============================================
async function fetchWeeklyPnl(uniqueCode) {
  const json = await fetchJSON(`${BASE}/public-weekly-pnl?uniqueCode=${uniqueCode}`)
  if (!json || json.code !== '0') return []
  return json.data || []
}

// ============================================
// DB upsert helpers
// ============================================
async function upsertEquityCurve(traderId, pnlRatios) {
  if (!pnlRatios?.length) return 0
  const now = new Date().toISOString()
  
  // pnlRatios are sorted newest first; each has beginTs and pnlRatio (cumulative, decimal)
  const sorted = [...pnlRatios].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  
  let count = 0
  for (const period of ['7D', '30D', '90D']) {
    const days = WINDOW_DAYS[period]
    const relevant = sorted.slice(-days)
    if (relevant.length < 2) continue
    
    // Calculate period-relative ROI
    const firstRatio = parseFloat(relevant[0].pnlRatio)
    const rows = relevant.map(r => {
      const cumRatio = parseFloat(r.pnlRatio)
      const periodRoi = ((1 + cumRatio) / (1 + firstRatio) - 1) * 100
      return {
        source: SOURCE, source_trader_id: traderId, period,
        data_date: new Date(parseInt(r.beginTs)).toISOString().split('T')[0],
        roi_pct: isFinite(periodRoi) ? periodRoi : null,
        pnl_usd: null,
        captured_at: now,
      }
    })
    
    const { error } = await sb.from('trader_equity_curve')
      .upsert(rows, { onConflict: 'source,source_trader_id,period,data_date' })
    if (error) console.log(`  ⚠ equity ${period}: ${error.message}`)
    else count += rows.length
  }
  return count
}

async function upsertStatsFromDetail(traderId, detail) {
  if (!detail) return 0
  const now = new Date().toISOString()
  
  const winRatio = detail.winRatio != null ? parseFloat(detail.winRatio) * 100 : null
  const totalPnl = parseFloat(detail.pnl || '0')
  const followers = parseInt(detail.copyTraderNum || '0')
  const aum = parseFloat(detail.aum || '0')
  
  // Compute MDD from pnlRatios for each period
  const pnlRatios = detail.pnlRatios || []
  const sorted = [...pnlRatios].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  
  let count = 0
  for (const period of ['7D', '30D', '90D']) {
    const days = WINDOW_DAYS[period]
    const relevant = sorted.slice(-days)
    if (relevant.length < 2) continue
    
    const firstRatio = parseFloat(relevant[0].pnlRatio)
    const lastRatio = parseFloat(relevant[relevant.length - 1].pnlRatio)
    const roi = ((1 + lastRatio) / (1 + firstRatio) - 1) * 100
    
    // MDD
    const curve = relevant.map(r => 1 + parseFloat(r.pnlRatio))
    let peak = curve[0], maxDD = 0
    for (const v of curve) {
      if (v > peak) peak = v
      if (peak > 0) { const dd = ((peak - v) / peak) * 100; if (dd > maxDD) maxDD = dd }
    }
    
    const row = {
      source: SOURCE, source_trader_id: traderId, period,
      roi: isFinite(roi) ? roi : null,
      total_trades: null,
      profitable_trades_pct: winRatio,
      avg_holding_time_hours: null,
      avg_profit: null, avg_loss: null,
      largest_win: null, largest_loss: null,
      sharpe_ratio: null,
      max_drawdown: maxDD > 0 && maxDD < 100 ? maxDD : null,
      copiers_count: followers,
      copiers_pnl: null,
      aum: aum > 0 ? aum : null,
      captured_at: now,
    }
    
    await sb.from('trader_stats_detail')
      .delete().eq('source', SOURCE).eq('source_trader_id', traderId).eq('period', period)
    const { error } = await sb.from('trader_stats_detail').insert(row)
    if (!error) count++
  }
  return count
}

async function upsertPortfolio(traderId, positions) {
  if (!positions?.length) return 0
  const now = new Date().toISOString()
  const rows = positions.map(p => ({
    source: SOURCE, source_trader_id: traderId,
    symbol: p.instId || 'UNKNOWN',
    direction: p.posSide === 'short' ? 'short' : 'long',
    invested_pct: null,
    entry_price: parseFloat(p.openAvgPx || '0') || null,
    pnl: parseFloat(p.upl || '0') || null,
    captured_at: now,
  })).filter(r => r.symbol !== 'UNKNOWN' && r.symbol !== '')
  
  if (rows.length === 0) return 0
  
  const { error } = await sb.from('trader_portfolio')
    .upsert(rows, { onConflict: 'source,source_trader_id,symbol,captured_at' })
  if (error) { console.log(`  ⚠ portfolio: ${error.message}`); return 0 }
  return rows.length
}

async function upsertAssetBreakdown(traderId, traderInsts) {
  if (!traderInsts?.length) return 0
  const now = new Date().toISOString()
  const total = traderInsts.length
  const rows = traderInsts.map(inst => ({
    source: SOURCE, source_trader_id: traderId,
    period: '90D', // traderInsts is overall
    symbol: inst.replace('-USDT-SWAP', '').replace('-SWAP', ''),
    weight_pct: (1 / total) * 100, // equal weight approximation
    captured_at: now,
  }))
  
  const { error } = await sb.from('trader_asset_breakdown')
    .upsert(rows, { onConflict: 'source,source_trader_id,period,symbol,captured_at' })
  if (error) { console.log(`  ⚠ assets: ${error.message}`); return 0 }
  return rows.length
}

// ============================================
// Upsert position history
// ============================================
async function upsertPositionHistory(traderId, positions) {
  if (!positions?.length) return 0
  const now = new Date().toISOString()

  const records = positions.map(p => ({
    source: SOURCE,
    source_trader_id: traderId,
    symbol: (p.instId || '').replace('-USDT-SWAP', '').replace('-SWAP', '') || 'UNKNOWN',
    direction: p.posSide === 'short' ? 'short' : 'long',
    position_type: 'perpetual',
    margin_mode: p.mgnMode || 'cross',
    open_time: p.openTime ? new Date(parseInt(p.openTime)).toISOString() : null,
    close_time: p.closeTime ? new Date(parseInt(p.closeTime)).toISOString() : null,
    entry_price: parseFloat(p.openAvgPx || '0') || null,
    exit_price: parseFloat(p.closeAvgPx || '0') || null,
    max_position_size: parseFloat(p.subPos || '0') || null,
    closed_size: parseFloat(p.subPos || '0') || null,
    pnl_usd: parseFloat(p.pnl || '0') || null,
    pnl_pct: parseFloat(p.pnlRatio || '0') ? parseFloat(p.pnlRatio) * 100 : null,
    status: 'closed',
    captured_at: now,
  })).filter(r => r.symbol !== 'UNKNOWN')

  if (records.length === 0) return 0

  // Delete old position history for this trader, then insert fresh
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  await sb.from('trader_position_history')
    .delete()
    .eq('source', SOURCE)
    .eq('source_trader_id', traderId)
    .gt('captured_at', sevenDaysAgo)

  const { error } = await sb.from('trader_position_history').insert(records)
  if (error) { console.log(`  ⚠ position history: ${error.message}`); return 0 }
  return records.length
}

// ============================================
// Main
// ============================================
async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`OKX Futures Detail Enrichment`)
  console.log(`${'='.repeat(60)}`)

  const { data: traders } = await sb.from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', SOURCE).eq('is_active', true)
    .limit(LIMIT * 2)

  if (!traders?.length) { console.log('No traders found'); return }

  // Check existing
  const ids = traders.map(t => t.source_trader_id).slice(0, 500)
  const { data: existingStats } = await sb.from('trader_stats_detail')
    .select('source_trader_id').eq('source', SOURCE).in('source_trader_id', ids)
  const hasStats = new Set(existingStats?.map(e => e.source_trader_id) || [])

  const needsWork = traders.filter(t => !hasStats.has(t.source_trader_id))
  const toProcess = needsWork.slice(0, LIMIT)

  console.log(`Total: ${traders.length}, has stats: ${hasStats.size}, to process: ${toProcess.length}`)

  let statsN = 0, equityN = 0, portfolioN = 0, assetsN = 0, posHistN = 0, errors = 0
  const startTime = Date.now()

  for (let i = 0; i < toProcess.length; i++) {
    const tid = toProcess[i].source_trader_id
    try {
      const detail = await fetchTraderDetail(tid)
      if (detail) {
        // Equity curve from pnlRatios
        const ec = await upsertEquityCurve(tid, detail.pnlRatios)
        if (ec > 0) equityN++
        
        // Stats
        const st = await upsertStatsFromDetail(tid, detail)
        if (st > 0) statsN++
        
        // Asset breakdown from traderInsts
        if (detail.traderInsts?.length > 0) {
          const ab = await upsertAssetBreakdown(tid, detail.traderInsts)
          if (ab > 0) assetsN++
        }
      }
      await sleep(600)
      
      // Positions (portfolio)
      const positions = await fetchPositions(tid)
      if (positions.length > 0) {
        const pn = await upsertPortfolio(tid, positions)
        if (pn > 0) portfolioN++
      }
      await sleep(500)

      // Position history (closed positions)
      const posHistory = await fetchPositionHistory(tid)
      if (posHistory.length > 0) {
        const ph = await upsertPositionHistory(tid, posHistory)
        if (ph > 0) posHistN++
      }
      await sleep(500)
    } catch (e) { errors++ }

    if ((i + 1) % 20 === 0 || i === toProcess.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      console.log(`  [${i + 1}/${toProcess.length}] stats=${statsN} eq=${equityN} port=${portfolioN} posHist=${posHistN} assets=${assetsN} err=${errors} | ${elapsed}m`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ OKX Futures enrichment done`)
  console.log(`   Stats: ${statsN}, Equity: ${equityN}, Portfolio: ${portfolioN}, PosHistory: ${posHistN}, Assets: ${assetsN}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
