#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks sharpe_ratio/sortino_ratio/profit_factor/calmar_ratio
 * by fetching directly from exchange detail APIs.
 * 
 * Only processes traders where sharpe_ratio IS NULL.
 * 
 * Usage:
 *   node scripts/enrich-lr-sharpe-direct.mjs [source] [--limit=500]
 *   node scripts/enrich-lr-sharpe-direct.mjs binance_futures --limit=1000
 *   node scripts/enrich-lr-sharpe-direct.mjs all --limit=2000
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('❌ Missing SUPABASE env vars'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const parseNum = v => { if (v == null || v === '') return null; const n = parseFloat(v); return isNaN(n) ? null : n }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ============================================
// Exchange API implementations
// ============================================

async function fetchBinanceFutures(traderId) {
  const url = `https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${traderId}&timeRange=90D`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Content-Type': 'application/json',
        'Origin': 'https://www.binance.com', 'Referer': 'https://www.binance.com/zh-CN/copy-trading' },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.code !== '000000' || !data.data) return null
    return {
      sharpe_ratio: parseNum(data.data.sharpRatio),
      sortino_ratio: null, // Binance doesn't provide
      profit_factor: null,
      calmar_ratio: null,
    }
  } catch { return null }
}

async function fetchBybit(traderId) {
  const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-detail?leaderMark=${traderId}&timeStamp=${Date.now()}`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://www.bybit.com/' },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.retCode !== 0 || !data.result) return null
    const r = data.result
    return {
      sharpe_ratio: parseNum(r.sharpeRatio),
      sortino_ratio: parseNum(r.sortinoRatio),
      profit_factor: parseNum(r.profitFactor),
      calmar_ratio: null,
    }
  } catch { return null }
}

async function fetchOkxFutures(traderId) {
  const url = `https://www.okx.com/api/v5/copytrading/public-lead-traders?uniqueName=${traderId}`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.code !== '0' || !data.data?.[0]) return null
    const d = data.data[0]
    return {
      sharpe_ratio: parseNum(d.sharpeRatio),
      sortino_ratio: parseNum(d.sortinoRatio),
      profit_factor: parseNum(d.profitFactor),
      calmar_ratio: null,
    }
  } catch { return null }
}

async function fetchHtxFutures(traderId) {
  const url = `https://www.htx.com/-/x/hbg/v1/social/follow/strategy/brief?strategyId=${traderId}`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data.data) return null
    return {
      sharpe_ratio: parseNum(data.data.sharpeRatio),
      sortino_ratio: parseNum(data.data.sortinoRatio),
      profit_factor: parseNum(data.data.profitFactor),
      calmar_ratio: parseNum(data.data.calmarRatio),
    }
  } catch { return null }
}

async function fetchBitgetFutures(traderId) {
  const url = `https://www.bitget.com/v1/trigger/trace/public/traderDetail?traderUid=${traderId}`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'locale': 'en-US' },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.code !== '00000' || !data.data) return null
    return {
      sharpe_ratio: parseNum(data.data.sharpeRatio),
      sortino_ratio: parseNum(data.data.sortinoRatio),
      profit_factor: parseNum(data.data.profitFactor),
      calmar_ratio: null,
    }
  } catch { return null }
}

// Map source → fetch function
const FETCHERS = {
  binance_futures: fetchBinanceFutures,
  bybit: fetchBybit,
  okx_futures: fetchOkxFutures,
  htx_futures: fetchHtxFutures,
  bitget_futures: fetchBitgetFutures,
}

const SUPPORTED_SOURCES = Object.keys(FETCHERS)
const DELAY_MS = { binance_futures: 300, bybit: 200, okx_futures: 200, htx_futures: 200, bitget_futures: 200 }

// ============================================
// Main
// ============================================

async function main() {
  const args = process.argv.slice(2)
  const sourceArg = args.find(a => !a.startsWith('--')) || 'all'
  const limitMatch = args.find(a => a.startsWith('--limit='))
  const limit = limitMatch ? parseInt(limitMatch.split('=')[1]) : 500

  const sources = sourceArg === 'all' ? SUPPORTED_SOURCES : [sourceArg]
  
  console.log(`\n🔧 Enriching sharpe/sortino/PF for: ${sources.join(', ')} (limit ${limit} per source)\n`)

  let totalUpdated = 0
  let totalFailed = 0
  let totalSkipped = 0

  for (const source of sources) {
    const fetcher = FETCHERS[source]
    if (!fetcher) { console.log(`⚠️ No fetcher for ${source}, skipping`); continue }

    // Get traders without sharpe
    const { data: traders, error } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id')
      .eq('source', source)
      .is('sharpe_ratio', null)
      .limit(limit)
    
    if (error || !traders?.length) {
      console.log(`${source}: ${error?.message || 'no traders need enrichment'}`)
      continue
    }

    console.log(`📊 ${source}: ${traders.length} traders to process`)
    let updated = 0, failed = 0, skipped = 0

    for (let i = 0; i < traders.length; i++) {
      const t = traders[i]
      const metrics = await fetcher(t.source_trader_id)
      
      if (!metrics || (metrics.sharpe_ratio === null && metrics.sortino_ratio === null && metrics.profit_factor === null)) {
        skipped++
      } else {
        // Only update non-null values
        const updates = {}
        if (metrics.sharpe_ratio !== null) updates.sharpe_ratio = Math.max(-50, Math.min(50, metrics.sharpe_ratio))
        if (metrics.sortino_ratio !== null) updates.sortino_ratio = Math.max(-50, Math.min(50, metrics.sortino_ratio))
        if (metrics.profit_factor !== null) updates.profit_factor = Math.max(0, Math.min(999.99, metrics.profit_factor))
        if (metrics.calmar_ratio !== null) updates.calmar_ratio = Math.max(-100, Math.min(100, metrics.calmar_ratio))

        if (Object.keys(updates).length > 0) {
          const { error: updateErr } = await supabase
            .from('leaderboard_ranks')
            .update(updates)
            .eq('id', t.id)
          
          if (updateErr) { failed++; } else { updated++ }
        } else {
          skipped++
        }
      }

      if ((i + 1) % 50 === 0 || i === traders.length - 1) {
        console.log(`  ${source}: ${i + 1}/${traders.length} | ✅ ${updated} | ⏭️ ${skipped} | ❌ ${failed}`)
      }

      await sleep(DELAY_MS[source] || 200)
    }

    console.log(`  ✅ ${source} done: ${updated} updated, ${skipped} skipped, ${failed} failed\n`)
    totalUpdated += updated
    totalFailed += failed
    totalSkipped += skipped
  }

  // Verify
  const { count } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).not('sharpe_ratio', 'is', null)
  console.log(`\n📊 Total: ${totalUpdated} updated, ${totalSkipped} skipped, ${totalFailed} failed`)
  console.log(`📊 leaderboard_ranks with sharpe: ${count}`)
}

main().catch(e => { console.error(e); process.exit(1) })
