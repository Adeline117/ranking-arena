#!/usr/bin/env node
/**
 * HTX Futures Detail Enrichment
 * 
 * Fills: trader_equity_curve, trader_stats_detail
 * API: futures.htx.com/-/x/hbg/v1/futures/copytrading/rank
 *   - profitList: array of cumulative ROI values (last 30 days)
 *   - winRate, mdd, profitRate90, profit90, copyUserNum
 * 
 * HTX rank API returns all data in the list response - no per-trader detail API needed.
 * We re-fetch the rank list and extract detail for each trader.
 * 
 * Usage: node scripts/import/enrich_htx_detail.mjs [--limit=500]
 */

import 'dotenv/config'
import { sb, sleep } from './lib/index.mjs'

const SOURCE = 'htx_futures'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const API_URL = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'
const PAGE_SIZE = 50

const limitArg = process.argv.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 500

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

// ============================================
// Fetch all traders from rank API
// ============================================
async function fetchAllTraders() {
  console.log('📡 Fetching HTX rank data...')
  const allTraders = new Map()
  
  for (let page = 1; page <= 20; page++) {
    const data = await fetchJSON(`${API_URL}?rankType=1&pageNo=${page}&pageSize=${PAGE_SIZE}`)
    if (!data || data.code !== 200 || !data.data?.itemList?.length) break
    
    for (const item of data.data.itemList) {
      const id = item.userSign || String(item.uid || '')
      if (id && !allTraders.has(id)) allTraders.set(id, item)
    }
    
    console.log(`  Page ${page}: ${data.data.itemList.length} items, total: ${allTraders.size}`)
    if (data.data.itemList.length < PAGE_SIZE || allTraders.size >= LIMIT) break
    await sleep(500)
  }
  
  return allTraders
}

// ============================================
// Extract equity curve from profitList
// ============================================
function extractEquityCurve(profitList, period) {
  if (!Array.isArray(profitList) || profitList.length < 2) return []
  
  const days = WINDOW_DAYS[period]
  const values = profitList.map(v => parseFloat(v))
  const relevant = values.slice(-days)
  
  // profitList values are cumulative ROI (decimal). 
  // Generate dates going backwards from today
  const today = new Date()
  const points = []
  
  for (let i = 0; i < relevant.length; i++) {
    const date = new Date(today)
    date.setDate(date.getDate() - (relevant.length - 1 - i))
    points.push({
      date: date.toISOString().split('T')[0],
      roi_pct: relevant[i] * 100, // Convert decimal to percentage
    })
  }
  
  return points
}

// ============================================
// DB helpers
// ============================================
async function upsertEquityCurve(traderId, profitList) {
  if (!profitList?.length) return 0
  const now = new Date().toISOString()
  let count = 0
  
  for (const period of ['7D', '30D']) {
    const points = extractEquityCurve(profitList, period)
    if (points.length < 2) continue
    
    const rows = points.map(p => ({
      source: SOURCE, source_trader_id: traderId, period,
      data_date: p.date,
      roi_pct: p.roi_pct,
      pnl_usd: null,
      captured_at: now,
    }))
    
    const { error } = await sb.from('trader_equity_curve')
      .upsert(rows, { onConflict: 'source,source_trader_id,period,data_date' })
    if (!error) count += rows.length
  }
  return count
}

async function upsertStats(traderId, item) {
  const now = new Date().toISOString()
  const profitList = item.profitList || []
  
  const winRate = item.winRate != null ? parseFloat(item.winRate) * 100 : null
  const mdd = item.mdd != null ? parseFloat(item.mdd) * 100 : null
  const followers = parseInt(item.copyUserNum || '0')
  const aum = parseFloat(item.aum || '0')
  
  let count = 0
  for (const period of ['7D', '30D', '90D']) {
    const days = WINDOW_DAYS[period]
    const values = profitList.map(v => parseFloat(v))
    const relevant = values.slice(-days)
    
    // Period ROI
    let roi = null
    if (relevant.length >= 2) {
      roi = (relevant[relevant.length - 1] - relevant[0]) * 100
    } else if (period === '90D' && item.profitRate90 != null) {
      roi = parseFloat(item.profitRate90)
    }
    
    // Period MDD
    let periodMdd = null
    if (relevant.length >= 2) {
      const equity = relevant.map(r => 1 + r)
      let peak = equity[0], maxDD = 0
      for (const e of equity) {
        if (e > peak) peak = e
        if (peak > 0) { const dd = ((peak - e) / peak) * 100; if (dd > maxDD) maxDD = dd }
      }
      periodMdd = maxDD > 0.01 && maxDD < 100 ? maxDD : null
    }
    
    const row = {
      source: SOURCE, source_trader_id: traderId, period,
      roi,
      total_trades: null,
      profitable_trades_pct: winRate,
      avg_holding_time_hours: null,
      avg_profit: null, avg_loss: null,
      largest_win: null, largest_loss: null,
      sharpe_ratio: null,
      max_drawdown: periodMdd || mdd,
      copiers_count: followers,
      copiers_pnl: parseFloat(item.copyProfit || '0') || null,
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

// ============================================
// Main
// ============================================
async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`HTX Futures Detail Enrichment`)
  console.log(`${'='.repeat(60)}`)

  const allTraders = await fetchAllTraders()
  if (allTraders.size === 0) { console.log('No traders from API'); return }
  
  // Check existing in DB
  const ids = Array.from(allTraders.keys()).slice(0, 500)
  const { data: existingStats } = await sb.from('trader_stats_detail')
    .select('source_trader_id').eq('source', SOURCE).in('source_trader_id', ids)
  const hasStats = new Set(existingStats?.map(e => e.source_trader_id) || [])
  
  const toProcess = Array.from(allTraders.entries())
    .filter(([id]) => !hasStats.has(id))
    .slice(0, LIMIT)

  console.log(`API traders: ${allTraders.size}, has stats: ${hasStats.size}, to process: ${toProcess.length}`)

  let statsN = 0, equityN = 0, errors = 0

  for (let i = 0; i < toProcess.length; i++) {
    const [id, item] = toProcess[i]
    try {
      const sn = await upsertStats(id, item)
      if (sn > 0) statsN++
      
      const en = await upsertEquityCurve(id, item.profitList)
      if (en > 0) equityN++
    } catch (e) { errors++ }

    if ((i + 1) % 50 === 0 || i === toProcess.length - 1) {
      console.log(`  [${i + 1}/${toProcess.length}] stats=${statsN} equity=${equityN} err=${errors}`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ HTX enrichment done`)
  console.log(`   Stats: ${statsN}, Equity: ${equityN}, Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
