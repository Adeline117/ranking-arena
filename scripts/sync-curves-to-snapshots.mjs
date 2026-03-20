#!/usr/bin/env node
/**
 * Phase 2: Compute ROI/WR/MDD/Sharpe from trader_equity_curve → trader_snapshots_v2
 * equity_curve has one row per date: (source, source_trader_id, period, data_date, roi_pct, pnl_usd)
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

async function main() {
  console.log('🔄 Phase 2: equity_curve → snapshots_v2\n')
  let totalUpdated = 0

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

      // Get all equity curve rows for this platform + period
      const traderIds = needsUpdate.map(s => s.trader_key)

      let updated = 0

      // Process in batches of 10 traders
      for (let i = 0; i < traderIds.length; i += 10) {
        const batchIds = traderIds.slice(i, i + 10)

        const { data: curveRows } = await supabase
          .from('trader_equity_curve')
          .select('source_trader_id, data_date, roi_pct, pnl_usd')
          .eq('source', platform)
          .eq('period', window)
          .in('source_trader_id', batchIds)
          .order('data_date', { ascending: true })
          .limit(5000)

        if (!curveRows?.length) continue

        // Group by trader
        const byTrader = new Map()
        for (const row of curveRows) {
          if (!byTrader.has(row.source_trader_id)) byTrader.set(row.source_trader_id, [])
          byTrader.get(row.source_trader_id).push(row)
        }

        for (const [traderId, pts] of byTrader) {
          if (pts.length < 2) continue

          const snap = needsUpdate.find(s => s.trader_key === traderId)
          if (!snap) continue

          const upd = {}

          // ROI from curve
          if (snap.roi_pct === null) {
            const first = pts[0], last = pts[pts.length - 1]
            if (last.roi_pct != null) {
              const v = first.roi_pct != null && first.roi_pct !== 0
                ? last.roi_pct - first.roi_pct : last.roi_pct
              if (v !== 0) upd.roi_pct = v
            }
          }

          // PnL
          if (snap.pnl_usd === null && pts[pts.length - 1]?.pnl_usd != null) {
            upd.pnl_usd = pts[pts.length - 1].pnl_usd
          }

          // Sharpe from daily ROI returns
          if (snap.sharpe_ratio === null && pts.length >= 7) {
            const ret = []
            for (let j = 1; j < pts.length; j++) {
              if (pts[j].roi_pct != null && pts[j - 1].roi_pct != null) {
                ret.push(pts[j].roi_pct - pts[j - 1].roi_pct)
              }
            }
            if (ret.length >= 5) {
              const mean = ret.reduce((a, b) => a + b, 0) / ret.length
              const std = Math.sqrt(ret.reduce((a, r) => a + (r - mean) ** 2, 0) / ret.length)
              if (std > 0) upd.sharpe_ratio = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
            }
          }

          // Win rate from daily PnL deltas
          if (snap.win_rate === null && pts.length >= 5) {
            const dr = []
            for (let j = 1; j < pts.length; j++) {
              if (pts[j].pnl_usd != null && pts[j - 1].pnl_usd != null) {
                dr.push(pts[j].pnl_usd - pts[j - 1].pnl_usd)
              }
            }
            if (dr.length >= 3) {
              const wins = dr.filter(r => r > 0).length
              upd.win_rate = Math.round((wins / dr.length) * 10000) / 100
            }
          }

          // MDD from ROI curve
          if (snap.max_drawdown === null && pts.length >= 3) {
            let peak = -Infinity, maxDD = 0
            for (const pt of pts) {
              const val = pt.roi_pct ?? pt.pnl_usd ?? 0
              if (val > peak) peak = val
              if (peak > 0) {
                const dd = ((peak - val) / peak) * 100
                if (dd > maxDD) maxDD = dd
              }
            }
            if (maxDD > 0 && maxDD <= 100) upd.max_drawdown = Math.round(maxDD * 100) / 100
          }

          if (Object.keys(upd).length > 0) {
            const { error } = await supabase
              .from('trader_snapshots_v2')
              .update(upd)
              .eq('platform', platform)
              .eq('trader_key', traderId)
              .eq('window', window)
            if (!error) updated++
          }
        }
      }

      if (updated > 0) {
        console.log(`  ${platform} (${window}): ${updated} computed from curves`)
        totalUpdated += updated
      }
    }
  }

  console.log(`\n✅ Total: ${totalUpdated} snapshots updated\n`)

  // Final fill rates
  console.log('=== Final fill rates (90D) ===')
  for (const platform of PLATFORMS) {
    const { data: rows } = await supabase
      .from('trader_snapshots_v2')
      .select('roi_pct, pnl_usd, win_rate, max_drawdown, sharpe_ratio')
      .eq('platform', platform)
      .eq('window', '90D')
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
}

main().catch(console.error)
