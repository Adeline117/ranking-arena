#!/usr/bin/env node
/**
 * Data Accuracy Verification Script
 *
 * Manually compares Arena DB data against live exchange APIs
 * for Binance Futures, Bybit, and Hyperliquid.
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ─── Helpers ───
function pct(a, b) {
  if (b == null || b === 0) return null
  return Math.abs((a - b) / b) * 100
}

function fmt(v) {
  if (v == null) return 'null'
  if (typeof v === 'number') return v.toFixed(2)
  return String(v)
}

async function fetchJson(url, opts = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status }
    return await res.json()
  } catch (e) {
    clearTimeout(timeout)
    return { error: e.message }
  }
}

// ─── 1. Query Arena DB ───
async function getArenaTopTraders(source, seasonId, limit = 5) {
  const { data, error } = await supabase
    .from('leaderboard_ranks')
    .select('source_trader_id, handle, roi, pnl, arena_score, rank, win_rate, max_drawdown, sharpe_ratio, trades_count, computed_at')
    .eq('season_id', seasonId)
    .eq('source', source)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .not('roi', 'is', null)
    .order('roi', { ascending: false, nullsFirst: false })
    .limit(limit)
  if (error) throw new Error(`DB query failed: ${error.message}`)
  return data
}

async function getArenaTopOverall() {
  const { data, error } = await supabase
    .from('leaderboard_ranks')
    .select('source_trader_id, handle, roi, pnl, arena_score, rank, source, season_id, win_rate, max_drawdown, sharpe_ratio, trades_count, computed_at')
    .eq('season_id', '90D')
    .gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .limit(5)
  if (error) throw new Error(`DB query failed: ${error.message}`)
  return data
}

async function getV2Snapshot(platform, traderKey, window) {
  const { data, error } = await supabase
    .from('trader_snapshots_v2')
    .select('roi_pct, pnl_usd, arena_score, win_rate, max_drawdown, metrics, as_of_ts, updated_at')
    .eq('platform', platform)
    .eq('trader_key', traderKey)
    .eq('window', window)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) return null
  return data?.[0] || null
}

// ─── 2. Fetch live exchange data ───

// Binance Futures: use new copy-trade API
async function fetchBinanceLive(encryptedUid) {
  // Get performance data
  const perf = await fetchJson('https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getOtherPerformance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryptedUid, tradeType: 'PERPETUAL' })
  })

  // Also try copy-trade detail for more metrics
  const detail = await fetchJson('https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade/lead-portfolio/detail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ portfolioId: encryptedUid })
  })

  let roi30d = null, pnl30d = null
  if (perf?.data && Array.isArray(perf.data)) {
    for (const entry of perf.data) {
      if ((entry.periodType === 'MONTHLY' || entry.periodType === '30D') && entry.statisticsType === 'ROI') {
        // Old format: decimal, New format: already percentage
        const val = Number(entry.value)
        roi30d = Math.abs(val) <= 10 ? val * 100 : val // Smart detect decimal vs pct
      }
      if ((entry.periodType === 'MONTHLY' || entry.periodType === '30D') && entry.statisticsType === 'PNL') {
        pnl30d = Number(entry.value)
      }
    }
  }

  return {
    roi30d,
    pnl30d,
    winRate: detail?.data?.winRate != null ? Number(detail.data.winRate) : null,
    maxDrawdown: detail?.data?.mdd != null ? Number(detail.data.mdd) : null,
    raw: { perf: perf?.error || 'ok', detail: detail?.error || 'ok' }
  }
}

// Bybit: use public API directly (may be geo-blocked)
async function fetchBybitLive(leaderMark) {
  // Try direct API first
  const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-details?leaderMark=${encodeURIComponent(leaderMark)}&timeRange=30D`
  const data = await fetchJson(url)

  if (data?.result) {
    const r = data.result
    return {
      roi30d: r.roi != null ? Number(r.roi) : null,
      pnl30d: r.pnl != null ? Number(r.pnl) : null,
      winRate: r.winRate != null ? Number(r.winRate) : null,
      maxDrawdown: r.maxDrawdown != null ? Number(r.maxDrawdown) : null,
      raw: 'direct-api'
    }
  }

  // Try VPS scraper if direct fails
  const vpsUrl = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3457'
  const vpsKey = process.env.VPS_PROXY_KEY || process.env.PROXY_KEY
  if (vpsKey) {
    const vpsData = await fetchJson(
      `${vpsUrl}/bybit/leaderboard?pageNo=1&pageSize=10&dataDuration=DATA_DURATION_THIRTY_DAY`,
      { headers: { 'X-Proxy-Key': vpsKey } }
    )
    if (vpsData?.result?.leaderDetails) {
      const match = vpsData.result.leaderDetails.find(t => t.leaderMark === leaderMark)
      if (match) {
        return {
          roi30d: match.roi != null ? Number(match.roi) : null,
          pnl30d: match.pnl != null ? Number(match.pnl) : null,
          winRate: match.winRate != null ? Number(match.winRate) : null,
          raw: 'vps-scraper-match'
        }
      }
      // Return first trader for comparison
      const first = vpsData.result.leaderDetails[0]
      return {
        roi30d: first.roi != null ? Number(first.roi) : null,
        pnl30d: first.pnl != null ? Number(first.pnl) : null,
        note: `Could not find ${leaderMark} in top 10; returning #1 for reference`,
        firstTrader: first.leaderMark || first.nickName,
        raw: 'vps-scraper-first'
      }
    }
  }

  return { error: 'Both direct API and VPS scraper failed', raw: data?.error || 'unknown' }
}

// Hyperliquid: leaderboard + clearinghouse (always accessible)
async function fetchHyperliquidLive(address) {
  // Clearinghouse state for PnL
  const state = await fetchJson('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address })
  })

  // Portfolio performance
  const perf = await fetchJson('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'portfolio', user: address })
  })

  // Also try leaderboard for cross-reference
  const lb = await fetchJson('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard')
  let lbMatch = null
  if (lb?.leaderboardRows) {
    lbMatch = lb.leaderboardRows.find(r => r.ethAddress?.toLowerCase() === address.toLowerCase())
  }

  const accountValue = state?.marginSummary?.accountValue != null ? Number(state.marginSummary.accountValue) : null
  const totalPnl = state?.marginSummary?.totalRawPnl != null ? Number(state.marginSummary.totalRawPnl) : null

  // Get performance windows
  let roi30d = null
  if (lbMatch?.windowPerformances) {
    for (const wp of lbMatch.windowPerformances) {
      if (wp.window === 'month' || wp.window === '30d') {
        roi30d = wp.roi != null ? Number(wp.roi) : null
        // Smart detect: decimal vs percentage
        if (roi30d != null && Math.abs(roi30d) <= 10) roi30d *= 100
      }
    }
  }

  return {
    roi30d,
    totalPnl,
    accountValue,
    leaderboardRank: lbMatch ? lb.leaderboardRows.indexOf(lbMatch) + 1 : null,
    raw: {
      state: state?.error || 'ok',
      lb: lb?.error || (lbMatch ? 'found' : 'not-in-top')
    }
  }
}

// ─── 3. Run comparisons ───
async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Arena Data Accuracy Verification')
  console.log('  ' + new Date().toISOString())
  console.log('═══════════════════════════════════════════════════════════\n')

  const issues = []

  // ── Binance Futures ──
  console.log('── 1. BINANCE FUTURES (30D) ──')
  const bnTraders = await getArenaTopTraders('binance_futures', '30D', 3)
  console.log(`Arena has ${bnTraders.length} top traders\n`)

  for (const t of bnTraders.slice(0, 2)) {
    console.log(`  Trader: ${t.handle || t.source_trader_id}`)
    console.log(`  Arena ROI: ${fmt(t.roi)}%  PnL: $${fmt(t.pnl)}  Score: ${fmt(t.arena_score)}`)

    const live = await fetchBinanceLive(t.source_trader_id)
    console.log(`  Live  ROI: ${fmt(live.roi30d)}%  PnL: $${fmt(live.pnl30d)}`)
    console.log(`  API status: perf=${live.raw?.perf || live.raw}, detail=${live.raw?.detail || 'n/a'}`)

    if (live.roi30d != null && t.roi != null) {
      const diff = pct(t.roi, live.roi30d)
      console.log(`  ROI diff: ${fmt(diff)}%`)
      if (diff > 5) {
        issues.push({ exchange: 'binance_futures', trader: t.handle, field: 'roi', arena: t.roi, live: live.roi30d, diff })
        console.log(`  ⚠️  EXCEEDS 5% THRESHOLD`)
      } else {
        console.log(`  ✓ Within tolerance`)
      }
    } else {
      console.log(`  ⚠️  Cannot compare (live API blocked or format changed)`)
    }

    // Check v2 snapshot consistency
    const v2 = await getV2Snapshot('binance_futures', t.source_trader_id, '30D')
    if (v2) {
      const lrVsV2 = pct(t.roi, v2.roi_pct)
      console.log(`  V2 snapshot ROI: ${fmt(v2.roi_pct)}% (diff from LR: ${fmt(lrVsV2)}%)`)
      console.log(`  V2 updated: ${v2.updated_at}`)
    }
    console.log()
  }

  // ── Bybit ──
  console.log('\n── 2. BYBIT (30D) ──')
  const byTraders = await getArenaTopTraders('bybit', '30D', 3)
  console.log(`Arena has ${byTraders.length} top traders\n`)

  for (const t of byTraders.slice(0, 2)) {
    console.log(`  Trader: ${t.handle || t.source_trader_id}`)
    console.log(`  Arena ROI: ${fmt(t.roi)}%  PnL: $${fmt(t.pnl)}  Score: ${fmt(t.arena_score)}`)

    const live = await fetchBybitLive(t.source_trader_id)
    if (live.error) {
      console.log(`  Live: ${live.error}`)
    } else {
      console.log(`  Live  ROI: ${fmt(live.roi30d)}%  PnL: $${fmt(live.pnl30d)}`)
      if (live.note) console.log(`  Note: ${live.note}`)

      if (live.roi30d != null && t.roi != null) {
        const diff = pct(t.roi, live.roi30d)
        console.log(`  ROI diff: ${fmt(diff)}%`)
        if (diff > 5) {
          issues.push({ exchange: 'bybit', trader: t.handle, field: 'roi', arena: t.roi, live: live.roi30d, diff })
          console.log(`  ⚠️  EXCEEDS 5% THRESHOLD`)
        } else {
          console.log(`  ✓ Within tolerance`)
        }
      }
    }

    const v2 = await getV2Snapshot('bybit', t.source_trader_id, '30D')
    if (v2) {
      console.log(`  V2 snapshot ROI: ${fmt(v2.roi_pct)}% (updated: ${v2.updated_at})`)
    }
    console.log()
  }

  // ── Hyperliquid ──
  console.log('\n── 3. HYPERLIQUID (30D) ──')
  const hlTraders = await getArenaTopTraders('hyperliquid', '30D', 3)
  console.log(`Arena has ${hlTraders.length} top traders\n`)

  for (const t of hlTraders.slice(0, 2)) {
    console.log(`  Trader: ${t.handle || t.source_trader_id}`)
    console.log(`  Arena ROI: ${fmt(t.roi)}%  PnL: $${fmt(t.pnl)}  Score: ${fmt(t.arena_score)}`)

    const live = await fetchHyperliquidLive(t.source_trader_id)
    console.log(`  Live  ROI: ${fmt(live.roi30d)}%  TotalPnL: $${fmt(live.totalPnl)}`)
    console.log(`  Live  AccountValue: $${fmt(live.accountValue)}  LB Rank: ${live.leaderboardRank || 'not in top'}`)

    if (live.roi30d != null && t.roi != null) {
      const diff = pct(t.roi, live.roi30d)
      console.log(`  ROI diff: ${fmt(diff)}%`)
      if (diff > 5) {
        issues.push({ exchange: 'hyperliquid', trader: t.handle, field: 'roi', arena: t.roi, live: live.roi30d, diff })
        console.log(`  ⚠️  EXCEEDS 5% THRESHOLD`)
      } else {
        console.log(`  ✓ Within tolerance`)
      }
    } else {
      console.log(`  ⚠️  Live ROI unavailable (not in leaderboard or API error)`)
    }

    const v2 = await getV2Snapshot('hyperliquid', t.source_trader_id, '30D')
    if (v2) {
      console.log(`  V2 snapshot ROI: ${fmt(v2.roi_pct)}% (updated: ${v2.updated_at})`)
    }
    console.log()
  }

  // ── Arena Score #1 ──
  console.log('\n── 4. ARENA SCORE TOP 5 (90D) ──')
  const top5 = await getArenaTopOverall()

  for (const t of top5) {
    console.log(`  #${t.rank || '?'} ${t.handle || t.source_trader_id} (${t.source})`)
    console.log(`     Score: ${fmt(t.arena_score)}  ROI: ${fmt(t.roi)}%  PnL: $${fmt(t.pnl)}`)
    console.log(`     WinRate: ${fmt(t.win_rate)}%  MDD: ${fmt(t.max_drawdown)}%  Sharpe: ${fmt(t.sharpe_ratio)}  Trades: ${t.trades_count}`)
    console.log(`     Computed: ${t.computed_at}`)

    // Sanity checks
    const flags = []
    if (t.roi > 10000) flags.push('ROI >10000% (should be capped)')
    if (t.roi < 0 && t.arena_score > 50) flags.push('Negative ROI but high score')
    if (t.pnl != null && t.pnl < 0 && t.arena_score > 60) flags.push('Negative PnL but score >60')
    if (t.win_rate != null && t.win_rate > 99 && t.trades_count > 50) flags.push('99%+ win rate with many trades (possible bot)')
    if (t.trades_count != null && t.trades_count < 3) flags.push('Very few trades — unreliable stats')
    if (t.arena_score > 95) flags.push('Score >95 — verify legitimacy')

    if (flags.length > 0) {
      console.log(`     ⚠️  FLAGS: ${flags.join('; ')}`)
      issues.push({ exchange: t.source, trader: t.handle, flags })
    } else {
      console.log(`     ✓ Passes sanity checks`)
    }
    console.log()
  }

  // ── Also check: leaderboard_ranks vs trader_snapshots_v2 consistency ──
  console.log('\n── 5. INTERNAL CONSISTENCY CHECK (LR vs V2) ──')
  // Sample 10 random traders and compare LR roi vs V2 roi_pct
  const { data: sampleLR } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, season_id, roi, pnl, arena_score')
    .eq('season_id', '30D')
    .not('roi', 'is', null)
    .gt('arena_score', 0)
    .order('computed_at', { ascending: false })
    .limit(20)

  let consistent = 0, inconsistent = 0, v2Missing = 0
  for (const lr of (sampleLR || []).slice(0, 10)) {
    const v2 = await getV2Snapshot(lr.source, lr.source_trader_id, lr.season_id)
    if (!v2) {
      v2Missing++
      continue
    }
    const roiDiff = pct(lr.roi, v2.roi_pct)
    if (roiDiff != null && roiDiff > 1) {
      inconsistent++
      console.log(`  ⚠️  ${lr.source}/${lr.source_trader_id}: LR roi=${fmt(lr.roi)} vs V2 roi_pct=${fmt(v2.roi_pct)} (diff: ${fmt(roiDiff)}%)`)
      if (roiDiff > 5) {
        issues.push({ exchange: lr.source, trader: lr.source_trader_id, field: 'internal-consistency', lrRoi: lr.roi, v2Roi: v2.roi_pct, diff: roiDiff })
      }
    } else {
      consistent++
    }
  }
  console.log(`  Results: ${consistent} consistent, ${inconsistent} inconsistent (>1%), ${v2Missing} V2 missing\n`)

  // ── Summary ──
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  TOTAL ISSUES: ${issues.length}`)
  if (issues.length === 0) {
    console.log('  ✓ All data within tolerance')
  } else {
    console.log('  Issues found:')
    for (const issue of issues) {
      if (issue.flags) {
        console.log(`    ${issue.exchange}/${issue.trader}: ${issue.flags.join('; ')}`)
      } else {
        console.log(`    ${issue.exchange}/${issue.trader}: ${issue.field} diff=${fmt(issue.diff)}% (arena=${fmt(issue.arena)}, live=${fmt(issue.live)})`)
      }
    }
  }
  console.log('═══════════════════════════════════════════════════════════')

  return issues
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
