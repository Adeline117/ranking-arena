#!/usr/bin/env node
/**
 * BingX Enrichment Script
 * 
 * Enriches trader_snapshots and leaderboard_ranks with:
 * - win_rate, max_drawdown, trades_count from recommend API (batch)
 * - Individual trader detail API fallback for remaining
 * 
 * Uses .env.local for config.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://bingx.com/',
  'Origin': 'https://bingx.com',
  'Accept': 'application/json',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Step 1: Batch fetch from recommend API ──
async function fetchRecommendBatch() {
  const enrichMap = new Map() // uid -> { wr, mdd, tc }
  console.log('📡 Fetching from recommend API...')
  
  for (let page = 0; page < 30; page++) {
    try {
      const r = await fetch(
        `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=${page}&pageSize=50`,
        {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
        }
      )
      const data = await r.json()
      if (data.code !== 0) {
        console.log(`  Page ${page}: code=${data.code}, stopping`)
        break
      }
      const items = data.data?.result || []
      if (!items.length) break
      
      for (const item of items) {
        const uid = String(item.trader?.uid || '')
        if (!uid) continue
        const stat = item.rankStat || {}
        enrichMap.set(uid, {
          tc: stat.totalTransactions ? parseInt(stat.totalTransactions) : null,
          wr: stat.winRate != null ? parseFloat(stat.winRate) : null,
          mdd: stat.maxDrawdown != null ? parseFloat(stat.maxDrawdown) : null,
          pnl: stat.pnl != null ? parseFloat(stat.pnl) : null,
        })
      }
      
      if (page % 5 === 0) console.log(`  Page ${page}: ${enrichMap.size} traders collected`)
      await sleep(600)
    } catch (e) {
      console.log(`  Page ${page} error: ${e.message}`)
      break
    }
  }
  
  console.log(`✅ Recommend API: ${enrichMap.size} traders`)
  return enrichMap
}

// ── Step 2: Individual detail API for remaining ──
async function fetchIndividualDetail(uid) {
  // Try multiple endpoints
  const endpoints = [
    `https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}&timeType=3`,
    `https://bingx.com/api/strategy/api/v1/copy/trader/detail?uid=${uid}`,
  ]
  
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10000),
      })
      if (!r.ok) continue
      const data = await r.json()
      if (data.code === 0 && data.data) {
        const d = data.data
        return {
          wr: d.winRate != null ? parseFloat(d.winRate) : null,
          mdd: d.maxDrawdown != null ? parseFloat(d.maxDrawdown) : null,
          tc: d.totalTransactions != null ? parseInt(d.totalTransactions) : null,
          pnl: d.pnl != null ? parseFloat(d.pnl) : null,
        }
      }
    } catch { /* try next */ }
  }
  return null
}

// ── Step 3: Normalize values ──
function normalizeWR(wr) {
  if (wr == null) return null
  // If between 0-1, convert to percentage
  if (wr > 0 && wr <= 1) return wr * 100
  return wr
}

function normalizeMDD(mdd) {
  if (mdd == null) return null
  // Ensure positive (some APIs return negative)
  const val = Math.abs(mdd)
  // If between 0-1, convert to percentage
  if (val > 0 && val <= 1) return val * 100
  return val
}

// ── Step 4: Update DB ──
async function updateTable(table, enrichMap) {
  // Fetch rows needing enrichment
  const { data: rows, error } = await sb
    .from(table)
    .select('id, source_trader_id, win_rate, max_drawdown, trades_count, pnl')
    .eq('source', 'bingx')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
  
  if (error) { console.error(`  ${table} fetch error:`, error.message); return 0 }
  console.log(`  ${table}: ${rows.length} rows need enrichment`)
  
  let updated = 0
  for (const row of rows) {
    const d = enrichMap.get(row.source_trader_id)
    if (!d) continue
    
    const updates = {}
    if (row.win_rate == null && d.wr != null) updates.win_rate = normalizeWR(d.wr)
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = normalizeMDD(d.mdd)
    if (row.trades_count == null && d.tc != null) updates.trades_count = d.tc
    if (row.pnl == null && d.pnl != null) updates.pnl = d.pnl
    
    if (!Object.keys(updates).length) continue
    
    const { error: ue } = await sb.from(table).update(updates).eq('id', row.id)
    if (!ue) updated++
    else console.error(`  Update failed for ${row.id}:`, ue.message)
  }
  
  return updated
}

// ── Main ──
async function main() {
  console.log('🚀 BingX Enrichment Starting...\n')
  
  // Step 1: Batch from recommend
  const enrichMap = await fetchRecommendBatch()
  
  // Step 2: Get rows still needing data
  const { data: needRows } = await sb
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'bingx')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
  
  const remaining = (needRows || []).filter(r => !enrichMap.has(r.source_trader_id))
  const uniqueRemaining = [...new Set(remaining.map(r => r.source_trader_id))]
  
  console.log(`\n📡 Fetching ${uniqueRemaining.length} individual details...`)
  let fetched = 0
  for (let i = 0; i < uniqueRemaining.length; i++) {
    const uid = uniqueRemaining[i]
    const detail = await fetchIndividualDetail(uid)
    if (detail) {
      enrichMap.set(uid, detail)
      fetched++
    }
    if ((i + 1) % 20 === 0) console.log(`  [${i + 1}/${uniqueRemaining.length}] fetched=${fetched}`)
    await sleep(400)
  }
  console.log(`✅ Individual API: ${fetched}/${uniqueRemaining.length} fetched`)
  
  // Step 3: Update both tables
  console.log('\n📝 Updating database...')
  const snapUpdated = await updateTable('trader_snapshots', enrichMap)
  const lrUpdated = await updateTable('leaderboard_ranks', enrichMap)
  
  console.log(`\n✅ Done!`)
  console.log(`  trader_snapshots: ${snapUpdated} rows updated`)
  console.log(`  leaderboard_ranks: ${lrUpdated} rows updated`)
  
  // Step 4: Verify
  console.log('\n📊 Verification:')
  for (const table of ['trader_snapshots', 'leaderboard_ranks']) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx')
    const { count: noWR } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('win_rate', null)
    const { count: noMDD } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('max_drawdown', null)
    const { count: noTC } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('trades_count', null)
    console.log(`  ${table} (${total} total):`)
    console.log(`    win_rate null: ${noWR} (${((1 - noWR/total) * 100).toFixed(1)}% filled)`)
    console.log(`    max_drawdown null: ${noMDD} (${((1 - noMDD/total) * 100).toFixed(1)}% filled)`)
    console.log(`    trades_count null: ${noTC} (${((1 - noTC/total) * 100).toFixed(1)}% filled)`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
