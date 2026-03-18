import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  console.log('=== Computing win_rate + MDD from position history & equity curves ===')

  // Get traders with null win_rate
  const { data: nullWrTraders } = await supabase
    .from('trader_snapshots_v2')
    .select('platform, trader_key')
    .is('win_rate', null)
    .limit(5000)
  
  const wrTraders = [...new Map(nullWrTraders?.map(r => [`${r.platform}:${r.trader_key}`, r]) || []).values()]
  console.log(`${wrTraders.length} unique traders need win_rate`)

  // Compute win_rate from position_history (closed_pnl)
  let wrComputed = 0
  for (let i = 0; i < wrTraders.length; i += 20) {
    const batch = wrTraders.slice(i, i + 20)
    await Promise.all(batch.map(async (trader) => {
      // Get closed positions
      const { data: positions } = await supabase
        .from('trader_position_history')
        .select('closed_pnl, pnl')
        .eq('platform', trader.platform)
        .eq('trader_key', trader.trader_key)
        .limit(500)
      
      if (!positions || positions.length < 3) return

      const pnls = positions.map(p => parseFloat(String(p.closed_pnl ?? p.pnl ?? 0))).filter(n => !isNaN(n) && n !== 0)
      if (pnls.length < 3) return
      
      const wins = pnls.filter(p => p > 0).length
      const wr = Math.round((wins / pnls.length) * 1000) / 10

      const { error } = await supabase
        .from('trader_snapshots_v2')
        .update({ win_rate: wr })
        .eq('platform', trader.platform)
        .eq('trader_key', trader.trader_key)
        .is('win_rate', null)
      
      if (!error) wrComputed++
    }))
    if ((i + 20) % 100 === 0 || i + 20 >= wrTraders.length)
      console.log(`  win_rate: ${wrComputed} computed (${Math.min(i + 20, wrTraders.length)}/${wrTraders.length})`)
  }

  // Get traders with null max_drawdown
  const { data: nullMddTraders } = await supabase
    .from('trader_snapshots_v2')
    .select('platform, trader_key')
    .is('max_drawdown', null)
    .limit(5000)
  
  const mddTraders = [...new Map(nullMddTraders?.map(r => [`${r.platform}:${r.trader_key}`, r]) || []).values()]
  console.log(`\n${mddTraders.length} unique traders need max_drawdown`)

  // Compute MDD from equity curves
  let mddComputed = 0
  for (let i = 0; i < mddTraders.length; i += 20) {
    const batch = mddTraders.slice(i, i + 20)
    await Promise.all(batch.map(async (trader) => {
      // Try equity curve first
      const { data: ec } = await supabase
        .from('trader_equity_curve')
        .select('value')
        .eq('platform', trader.platform)
        .eq('trader_key', trader.trader_key)
        .order('ts', { ascending: true })
        .limit(500)
      
      let maxDD = 0
      if (ec && ec.length >= 3) {
        let peak = -Infinity
        for (const point of ec) {
          const v = parseFloat(String(point.value))
          if (isNaN(v) || v === 0) continue
          if (v > peak) peak = v
          if (peak > 0) {
            const dd = ((peak - v) / peak) * 100
            if (dd > maxDD) maxDD = dd
          }
        }
      }
      
      // Fallback: compute from position PnL cumulative curve
      if (maxDD === 0) {
        const { data: positions } = await supabase
          .from('trader_position_history')
          .select('closed_pnl, pnl')
          .eq('platform', trader.platform)
          .eq('trader_key', trader.trader_key)
          .order('closed_at', { ascending: true })
          .limit(500)
        
        if (positions && positions.length >= 3) {
          let cumPnl = 0, peakPnl = 0
          for (const p of positions) {
            const pnl = parseFloat(String(p.closed_pnl ?? p.pnl ?? 0))
            if (isNaN(pnl)) continue
            cumPnl += pnl
            if (cumPnl > peakPnl) peakPnl = cumPnl
            if (peakPnl > 0) {
              const dd = ((peakPnl - cumPnl) / peakPnl) * 100
              if (dd > maxDD) maxDD = dd
            }
          }
        }
      }

      if (maxDD > 0 && maxDD <= 100) {
        const mdd = Math.round(maxDD * 100) / 100
        const { error } = await supabase
          .from('trader_snapshots_v2')
          .update({ max_drawdown: mdd })
          .eq('platform', trader.platform)
          .eq('trader_key', trader.trader_key)
          .is('max_drawdown', null)
        if (!error) mddComputed++
      }
    }))
    if ((i + 20) % 100 === 0 || i + 20 >= mddTraders.length)
      console.log(`  max_drawdown: ${mddComputed} computed (${Math.min(i + 20, mddTraders.length)}/${mddTraders.length})`)
  }

  // Sync to v1
  console.log('\n--- Syncing computed values to v1 ---')
  let synced = 0
  for (const trader of [...wrTraders, ...mddTraders].slice(0, 2000)) {
    const { data } = await supabase
      .from('trader_snapshots_v2')
      .select('win_rate, max_drawdown')
      .eq('platform', trader.platform)
      .eq('trader_key', trader.trader_key)
      .limit(1)
      .maybeSingle()
    if (data && (data.win_rate != null || data.max_drawdown != null)) {
      const updates = {}
      if (data.win_rate != null) updates.win_rate = data.win_rate
      if (data.max_drawdown != null) updates.max_drawdown = data.max_drawdown
      await supabase.from('trader_snapshots').update(updates)
        .eq('source', trader.platform).eq('source_trader_id', trader.trader_key)
      synced++
    }
  }
  console.log(`Synced ${synced} to v1`)

  // Final
  console.log(`\n=== RESULT: win_rate=${wrComputed}, max_drawdown=${mddComputed} computed ===`)
  
  const { data: finalData } = await supabase.rpc('get_monitoring_freshness_summary')
  if (finalData) {
    const total = finalData.reduce((s, r) => s + (r.total || 0), 0)
    const wr = finalData.reduce((s, r) => s + (r.win_rate_count || 0), 0)
    const mdd = finalData.reduce((s, r) => s + (r.max_drawdown_count || 0), 0)
    console.log(`Coverage: win_rate ${wr}/${total} (${Math.round(wr*100/total)}%), max_drawdown ${mdd}/${total} (${Math.round(mdd*100/total)}%)`)
  }
}

main().catch(console.error)
