#!/usr/bin/env node
/**
 * Sync enrichment data back to trader_snapshots_v2
 * Reads from trader_stats_detail + trader_equity_curve and fills NULL fields.
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PLATFORMS = [
  'bitfinex', 'okx_web3', 'gains', 'bybit', 'bybit_spot',
  'kucoin', 'bingx_spot', 'okx_spot', 'bitget_futures'
]
const WINDOWS = ['90D', '30D', '7D']

// Map stats_detail.period → snapshots_v2.window
const periodToWindow = { '90D': '90D', '30D': '30D', '7D': '7D' }

async function syncStats() {
  console.log('=== Phase 1: stats_detail → snapshots_v2 ===\n')
  let total = 0

  for (const platform of PLATFORMS) {
    for (const window of WINDOWS) {
      // Get stats with real column names
      const { data: stats } = await supabase
        .from('trader_stats_detail')
        .select('source_trader_id, profitable_trades_pct, max_drawdown, sharpe_ratio, total_trades')
        .eq('source', platform)
        .eq('period', window)
        .limit(1000)

      if (!stats?.length) continue

      // Get snapshots with NULL fields
      const { data: snaps } = await supabase
        .from('trader_snapshots_v2')
        .select('trader_key, win_rate, max_drawdown, sharpe_ratio, trades_count')
        .eq('platform', platform)
        .eq('window', window)
        .limit(1000)

      if (!snaps?.length) continue

      const snapMap = new Map()
      for (const s of snaps) {
        if (s.win_rate === null || s.max_drawdown === null || s.sharpe_ratio === null) {
          snapMap.set(s.trader_key, s)
        }
      }

      let updated = 0
      for (const stat of stats) {
        const snap = snapMap.get(stat.source_trader_id)
        if (!snap) continue

        const upd = {}
        if (snap.win_rate === null && stat.profitable_trades_pct != null) upd.win_rate = stat.profitable_trades_pct
        if (snap.max_drawdown === null && stat.max_drawdown != null) upd.max_drawdown = stat.max_drawdown
        if (snap.sharpe_ratio === null && stat.sharpe_ratio != null) upd.sharpe_ratio = stat.sharpe_ratio
        if (snap.trades_count === null && stat.total_trades != null) upd.trades_count = stat.total_trades

        if (Object.keys(upd).length > 0) {
          const { error } = await supabase
            .from('trader_snapshots_v2')
            .update(upd)
            .eq('platform', platform)
            .eq('trader_key', stat.source_trader_id)
            .eq('window', window)
          if (!error) updated++
        }
      }

      if (updated > 0) {
        console.log(`  ${platform} (${window}): ${updated} synced from stats`)
        total += updated
      }
    }
  }
  console.log(`\nPhase 1: ${total} total\n`)
  return total
}

async function syncCurves() {
  console.log('=== Phase 2: equity_curve → snapshots_v2 ===\n')
  let total = 0

  for (const platform of PLATFORMS) {
    for (const window of WINDOWS) {
      // Get snapshots missing metrics
      const { data: snaps } = await supabase
        .from('trader_snapshots_v2')
        .select('trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, sharpe_ratio')
        .eq('platform', platform)
        .eq('window', window)
        .limit(1000)

      if (!snaps?.length) continue

      const needsUpdate = snaps.filter(s =>
        s.roi_pct === null || s.win_rate === null || s.max_drawdown === null || s.sharpe_ratio === null
      )
      if (!needsUpdate.length) continue

      // Process in batches
      let updated = 0
      for (let i = 0; i < needsUpdate.length; i += 20) {
        const batch = needsUpdate.slice(i, i + 20)
        const ids = batch.map(s => s.trader_key)

        const { data: curves } = await supabase
          .from('trader_equity_curve')
          .select('source_trader_id, data')
          .eq('source', platform)
          .eq('season_id', window)
          .in('source_trader_id', ids)

        if (!curves?.length) continue

        for (const curve of curves) {
          const snap = batch.find(s => s.trader_key === curve.source_trader_id)
          if (!snap || !Array.isArray(curve.data) || curve.data.length < 2) continue

          const pts = curve.data.sort((a, b) => (a.date || '').localeCompare(b.date || ''))
          const upd = {}

          // ROI
          if (snap.roi_pct === null) {
            const first = pts[0], last = pts[pts.length - 1]
            if (last.roi != null) {
              const v = first.roi && first.roi !== 0 ? last.roi - first.roi : last.roi
              if (v !== 0) upd.roi_pct = v
            }
          }

          // PnL
          if (snap.pnl_usd === null && pts[pts.length - 1]?.pnl != null) {
            upd.pnl_usd = pts[pts.length - 1].pnl
          }

          // Sharpe
          if (snap.sharpe_ratio === null && pts.length >= 7) {
            const ret = []
            for (let j = 1; j < pts.length; j++) {
              if (pts[j].roi != null && pts[j - 1].roi != null) ret.push(pts[j].roi - pts[j - 1].roi)
            }
            if (ret.length >= 5) {
              const mean = ret.reduce((a, b) => a + b, 0) / ret.length
              const std = Math.sqrt(ret.reduce((a, r) => a + (r - mean) ** 2, 0) / ret.length)
              if (std > 0) upd.sharpe_ratio = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
            }
          }

          // Win rate
          if (snap.win_rate === null && pts.length >= 5) {
            const dr = []
            for (let j = 1; j < pts.length; j++) {
              if (pts[j].pnl != null && pts[j - 1].pnl != null) dr.push(pts[j].pnl - pts[j - 1].pnl)
            }
            if (dr.length >= 3) {
              const wins = dr.filter(r => r > 0).length
              upd.win_rate = Math.round((wins / dr.length) * 10000) / 100
            }
          }

          // MDD
          if (snap.max_drawdown === null && pts.length >= 3) {
            let peak = -Infinity, maxDD = 0
            for (const pt of pts) {
              const val = pt.roi ?? pt.pnl ?? 0
              if (val > peak) peak = val
              if (peak > 0) { const dd = ((peak - val) / peak) * 100; if (dd > maxDD) maxDD = dd }
            }
            if (maxDD > 0) upd.max_drawdown = Math.round(maxDD * 100) / 100
          }

          if (Object.keys(upd).length > 0) {
            const { error } = await supabase
              .from('trader_snapshots_v2')
              .update(upd)
              .eq('platform', platform)
              .eq('trader_key', curve.source_trader_id)
              .eq('window', window)
            if (!error) updated++
          }
        }
      }

      if (updated > 0) {
        console.log(`  ${platform} (${window}): ${updated} computed from curves`)
        total += updated
      }
    }
  }
  console.log(`\nPhase 2: ${total} total\n`)
  return total
}

async function cloneMissingWindows() {
  console.log('=== Phase 3: Clone missing window snapshots ===\n')
  let total = 0

  for (const platform of ['kucoin', 'bingx_spot']) {
    const { data: src } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, trader_key, window, roi_pct, pnl_usd, win_rate, max_drawdown, sharpe_ratio, trades_count, copiers, followers, market_type, arena_score, return_score, drawdown_score, stability_score')
      .eq('platform', platform)
      .eq('window', '30D')
      .limit(500)

    if (!src?.length) { console.log(`  ${platform}: no 30D source`); continue }

    for (const window of ['90D', '7D']) {
      const { data: existing } = await supabase
        .from('trader_snapshots_v2')
        .select('trader_key')
        .eq('platform', platform)
        .eq('window', window)
        .limit(1000)

      const existKeys = new Set((existing || []).map(s => s.trader_key))
      const toCreate = src.filter(s => !existKeys.has(s.trader_key))

      if (!toCreate.length) continue

      const rows = toCreate.map(s => ({
        platform: s.platform,
        trader_key: s.trader_key,
        window: window,
        roi_pct: s.roi_pct,
        pnl_usd: s.pnl_usd,
        win_rate: s.win_rate,
        max_drawdown: s.max_drawdown,
        sharpe_ratio: s.sharpe_ratio,
        trades_count: s.trades_count,
        copiers: s.copiers,
        followers: s.followers,
        market_type: s.market_type,
        arena_score: s.arena_score,
        return_score: s.return_score,
        drawdown_score: s.drawdown_score,
        stability_score: s.stability_score,
        as_of_ts: new Date().toISOString(),
      }))

      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50)
        const { error } = await supabase
          .from('trader_snapshots_v2')
          .upsert(batch, { onConflict: 'platform,trader_key,window' })
        if (error) console.error(`  ${platform} (${window}): ${error.message}`)
      }

      console.log(`  ${platform} (${window}): created ${toCreate.length}`)
      total += toCreate.length
    }
  }
  console.log(`\nPhase 3: ${total} total\n`)
  return total
}

async function printFillRates() {
  console.log('=== Final fill rates ===\n')
  for (const window of WINDOWS) {
    console.log(`--- ${window} ---`)
    for (const platform of PLATFORMS) {
      const { data: rows } = await supabase
        .from('trader_snapshots_v2')
        .select('roi_pct, pnl_usd, win_rate, max_drawdown, sharpe_ratio')
        .eq('platform', platform)
        .eq('window', window)
        .limit(500)

      if (!rows?.length) { console.log(`  ${platform.padEnd(20)} rows=0`); continue }

      const t = rows.length
      const f = { roi: 0, pnl: 0, wr: 0, mdd: 0, sharpe: 0 }
      for (const r of rows) {
        if (r.roi_pct != null) f.roi++
        if (r.pnl_usd != null) f.pnl++
        if (r.win_rate != null) f.wr++
        if (r.max_drawdown != null) f.mdd++
        if (r.sharpe_ratio != null) f.sharpe++
      }
      console.log(`  ${platform.padEnd(20)} rows=${String(t).padStart(4)}  roi=${String(Math.round(f.roi*100/t)).padStart(3)}%  pnl=${String(Math.round(f.pnl*100/t)).padStart(3)}%  wr=${String(Math.round(f.wr*100/t)).padStart(3)}%  mdd=${String(Math.round(f.mdd*100/t)).padStart(3)}%  sharpe=${String(Math.round(f.sharpe*100/t)).padStart(3)}%`)
    }
    console.log('')
  }
}

async function main() {
  console.log('🔄 Syncing enrichment → snapshots_v2\n')
  await syncStats()
  await syncCurves()
  await cloneMissingWindows()
  await printFillRates()
}

main().catch(console.error)
