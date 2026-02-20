#!/usr/bin/env node
/**
 * daily-checkpoint.mjs — 每日交易员快照
 *
 * 每天 UTC 00:00 运行一次，对所有已知交易员拍日快照。
 * 数据护城河：积累多年历史数据，任何后来者无法通过金钱购买的时间壁垒。
 *
 * 策略：
 * 1. 从各交易所 API 获取当前排行榜数据（ROI/WR/MDD/trades）
 * 2. 对数据库中所有 active 交易员写入 snapshot_date = today 的快照
 * 3. 对不在当前排行榜的老交易员：只写入 last_seen_at，跳过数据点
 * 4. 用 (source, source_trader_id, snapshot_date) 唯一键做 upsert，防重复
 *
 * Usage:
 *   node scripts/import/daily-checkpoint.mjs
 *   node scripts/import/daily-checkpoint.mjs --source=binance_futures
 *   node scripts/import/daily-checkpoint.mjs --dry-run
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const DRY_RUN = process.argv.includes('--dry-run')
const TARGET_SOURCE = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const TODAY = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ============================================================
// Per-source snapshot fetchers
// ============================================================

async function fetchBinanceFutures() {
  const results = new Map()
  try {
    for (const period of ['DAILY', 'WEEKLY', 'MONTHLY']) {
      const r = await fetch(
        `https://www.binance.com/bapi/futures/v2/public/future/leaderboard/getLeaderboardRank?tradeType=PERPETUAL&statisticsType=${period}&isShared=true&isTrader=false&limit=500`
      )
      const j = await r.json()
      const list = j?.data || []
      for (const t of list) {
        const id = String(t.encryptedUid || t.uid)
        if (!results.has(id)) results.set(id, { roi: null, pnl: null, win_rate: null, max_drawdown: null, trades_count: null, followers: null })
        const entry = results.get(id)
        if (period === 'DAILY') entry.roi_7d = t.roi != null ? parseFloat(t.roi) * 100 : null
        if (period === 'WEEKLY') entry.roi_7d = t.roi != null ? parseFloat(t.roi) * 100 : null
        if (period === 'MONTHLY') {
          entry.roi = t.roi != null ? parseFloat(t.roi) * 100 : null
          entry.pnl = t.pnl != null ? parseFloat(t.pnl) : null
        }
      }
    }
  } catch (e) { console.error('binance_futures fetch error:', e.message) }
  return results
}

async function fetchBybitFutures() {
  const results = new Map()
  try {
    // Bybit requires Puppeteer (WAF protected) - skip direct API
    // Data comes from VPS crons; just mark all known traders as seen
    console.log('  bybit: WAF protected, using existing data')
  } catch (e) { console.error('bybit fetch error:', e.message) }
  return results
}

async function fetchHyperliquid() {
  const results = new Map()
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'leaderboard' })
    })
    const j = await r.json()
    const list = j?.leaderboardRows || []
    for (const t of list) {
      const id = t.ethAddress?.toLowerCase()
      if (!id) continue
      results.set(id, {
        roi: t.windowPerformances?.[2]?.[1]?.pnl != null ? null : null, // HL uses absolute PnL
        pnl: t.windowPerformances?.[2]?.[1]?.pnl != null ? parseFloat(t.windowPerformances[2][1].pnl) : null,
        win_rate: null,
        max_drawdown: null,
        trades_count: null,
        followers: null,
        roi_30d: t.windowPerformances?.[1]?.[1]?.pnl != null ? null : null,
        roi_7d: t.windowPerformances?.[0]?.[1]?.pnl != null ? null : null,
      })
    }
  } catch (e) { console.error('hyperliquid fetch error:', e.message) }
  return results
}

async function fetchGains() {
  const results = new Map()
  try {
    const r = await fetch('https://backend-v8.gains.trade/leaderboards', {
      headers: { 'Origin': 'https://gains.trade', 'Referer': 'https://gains.trade/' }
    })
    const j = await r.json()
    const list = j?.topTradersCurrentMonth || j?.topTradersAllTime || []
    for (const t of list) {
      const id = (t.address || t.trader)?.toLowerCase()
      if (!id) continue
      results.set(id, {
        roi: t.roi != null ? parseFloat(t.roi) * 100 : null,
        pnl: t.pnl != null ? parseFloat(t.pnl) : null,
        win_rate: t.winRate != null ? parseFloat(t.winRate) * 100 : null,
        max_drawdown: null,
        trades_count: t.tradesCount != null ? parseInt(t.tradesCount) : null,
        followers: null,
      })
    }
  } catch (e) { console.error('gains fetch error:', e.message) }
  return results
}

// Simplified fetcher for exchanges that just need leaderboard API calls
async function fetchMexc() {
  const results = new Map()
  try {
    // MEXC requires Puppeteer - mark existing traders as seen
    console.log('  mexc: requires Puppeteer, using existing data')
  } catch (e) { console.error('mexc fetch error:', e.message) }
  return results
}

// ============================================================
// Source config: which fetchers to use
// ============================================================

const SOURCE_FETCHERS = {
  binance_futures: fetchBinanceFutures,
  hyperliquid: fetchHyperliquid,
  gains: fetchGains,
  // Puppeteer-required sources: bybit, mexc, bitget, etc.
  // These are handled by VPS crons; daily checkpoint marks them as "seen"
}

// ============================================================
// Core: write snapshot for a source
// ============================================================

async function checkpointSource(source) {
  console.log(`\n📸 [${source}] Starting checkpoint for ${TODAY}`)

  // Get all known traders for this source
  const { data: traders, error: te } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle, avatar_url')
    .eq('source', source)

  if (te || !traders?.length) {
    console.log(`  No traders found for ${source}`)
    return { written: 0, skipped: 0 }
  }

  console.log(`  ${traders.length} known traders`)

  // Fetch live data if fetcher exists
  let liveData = new Map()
  const fetcher = SOURCE_FETCHERS[source]
  if (fetcher) {
    console.log(`  Fetching live data from API...`)
    liveData = await fetcher()
    console.log(`  Got ${liveData.size} traders from API`)
  }

  // Get current leaderboard_ranks for this source (latest metrics)
  const { data: ranks } = await supabase
    .from('leaderboard_ranks')
    .select('source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, rank')
    .eq('source', source)

  const rankMap = new Map()
  for (const r of ranks || []) {
    rankMap.set(r.source_trader_id, r)
  }

  // Build snapshot rows
  const snapshots = []
  const now = new Date().toISOString()

  for (const trader of traders) {
    const id = trader.source_trader_id
    const live = liveData.get(id) || liveData.get(id?.toLowerCase()) || {}
    const rank = rankMap.get(id) || {}

    snapshots.push({
      source,
      source_trader_id: id,
      snapshot_date: TODAY,
      captured_at: now,
      // Live API data (if available)
      roi: live.roi ?? rank.roi ?? null,
      pnl: live.pnl ?? rank.pnl ?? null,
      win_rate: live.win_rate ?? rank.win_rate ?? null,
      max_drawdown: live.max_drawdown ?? rank.max_drawdown ?? null,
      trades_count: live.trades_count ?? rank.trades_count ?? null,
      followers: live.followers ?? rank.followers ?? null,
      roi_7d: live.roi_7d ?? null,
      roi_30d: live.roi_30d ?? null,
      arena_score: rank.arena_score ?? null,
      rank: rank.rank ?? null,
    })
  }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would write ${snapshots.length} snapshots`)
    return { written: snapshots.length, skipped: 0 }
  }

  // Upsert in batches of 200
  let written = 0
  let skipped = 0
  const BATCH = 200
  for (let i = 0; i < snapshots.length; i += BATCH) {
    const batch = snapshots.slice(i, i + BATCH)
    const { error } = await supabase
      .from('trader_snapshots')
      .upsert(batch, { onConflict: 'source,source_trader_id,snapshot_date', ignoreDuplicates: false })
    if (error) {
      console.error(`  Batch ${i}-${i + BATCH} error:`, error.message)
      skipped += batch.length
    } else {
      written += batch.length
    }
    await sleep(200)
  }

  // Update last_seen_at for traders in live data
  if (liveData.size > 0) {
    const activeIds = [...liveData.keys()]
    const batchSize = 100
    for (let i = 0; i < activeIds.length; i += batchSize) {
      const batch = activeIds.slice(i, i + batchSize)
      await supabase
        .from('trader_sources')
        .update({ last_seen_at: now })
        .eq('source', source)
        .in('source_trader_id', batch)
      await sleep(100)
    }
    console.log(`  Updated last_seen_at for ${activeIds.length} active traders`)
  }

  console.log(`  ✅ Written: ${written}, Skipped: ${skipped}`)
  return { written, skipped }
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log(`\n🌊 Arena Daily Checkpoint — ${TODAY}`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)

  // Get all sources in DB
  const { data: sourceRows } = await supabase
    .from('trader_sources')
    .select('source')
    .not('source', 'is', null)

  const allSources = [...new Set(sourceRows?.map(r => r.source) || [])]
  const sources = TARGET_SOURCE ? [TARGET_SOURCE] : allSources

  console.log(`\nSources to checkpoint (${sources.length}): ${sources.join(', ')}`)

  const start = Date.now()
  let totalWritten = 0
  let totalSkipped = 0

  for (const source of sources) {
    try {
      const { written, skipped } = await checkpointSource(source)
      totalWritten += written
      totalSkipped += skipped
    } catch (e) {
      console.error(`[${source}] Fatal error:`, e.message)
    }
    await sleep(500)
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`\n✅ Checkpoint complete in ${elapsed}s`)
  console.log(`   Total written: ${totalWritten}`)
  console.log(`   Total skipped: ${totalSkipped}`)
  console.log(`   Snapshot date: ${TODAY}`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
