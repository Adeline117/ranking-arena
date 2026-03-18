import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  // 1. Get null win_rate traders from v2
  const { data: nullWr } = await supabase.from('trader_snapshots_v2').select('platform, trader_key').is('win_rate', null).limit(5000)
  const wrTraders = [...new Map(nullWr?.map(r => [`${r.platform}:${r.trader_key}`, r]) || []).values()]
  console.log(`${wrTraders.length} traders need win_rate`)

  // 2. Compute win_rate from position_history (uses source/source_trader_id/pnl_usd)
  let wrDone = 0
  for (let i = 0; i < wrTraders.length; i += 10) {
    const batch = wrTraders.slice(i, i + 10)
    await Promise.all(batch.map(async (t) => {
      const { data: pos } = await supabase.from('trader_position_history')
        .select('pnl_usd').eq('source', t.platform).eq('source_trader_id', t.trader_key).limit(500)
      if (!pos || pos.length < 3) return
      const pnls = pos.map(p => parseFloat(String(p.pnl_usd))).filter(n => !isNaN(n) && n !== 0)
      if (pnls.length < 3) return
      const wr = Math.round((pnls.filter(p => p > 0).length / pnls.length) * 1000) / 10
      await supabase.from('trader_snapshots_v2').update({ win_rate: wr }).eq('platform', t.platform).eq('trader_key', t.trader_key).is('win_rate', null)
      await supabase.from('trader_snapshots').update({ win_rate: wr }).eq('source', t.platform).eq('source_trader_id', t.trader_key).is('win_rate', null)
      wrDone++
    }))
    if ((i + 10) % 100 === 0) process.stdout.write(`\r  win_rate: ${wrDone} (${i+10}/${wrTraders.length})`)
  }
  console.log(`\n  win_rate computed: ${wrDone}`)

  // 3. Get null MDD traders
  const { data: nullMdd } = await supabase.from('trader_snapshots_v2').select('platform, trader_key').is('max_drawdown', null).limit(5000)
  const mddTraders = [...new Map(nullMdd?.map(r => [`${r.platform}:${r.trader_key}`, r]) || []).values()]
  console.log(`${mddTraders.length} traders need max_drawdown`)

  // 4. Compute MDD from equity_curve (roi_pct series) + position_history fallback
  let mddDone = 0
  for (let i = 0; i < mddTraders.length; i += 10) {
    const batch = mddTraders.slice(i, i + 10)
    await Promise.all(batch.map(async (t) => {
      // Try equity curve first
      const { data: ec } = await supabase.from('trader_equity_curve')
        .select('roi_pct').eq('source', t.platform).eq('source_trader_id', t.trader_key)
        .order('data_date', { ascending: true }).limit(500)
      
      let maxDD = 0
      if (ec && ec.length >= 3) {
        let peak = -Infinity
        for (const pt of ec) {
          const equity = 100 + parseFloat(String(pt.roi_pct || 0))
          if (equity > peak) peak = equity
          if (peak > 0) { const dd = ((peak - equity) / peak) * 100; if (dd > maxDD) maxDD = dd }
        }
      }
      
      // Fallback: cumulative PnL from positions
      if (maxDD === 0) {
        const { data: pos } = await supabase.from('trader_position_history')
          .select('pnl_usd').eq('source', t.platform).eq('source_trader_id', t.trader_key)
          .order('close_time', { ascending: true }).limit(500)
        if (pos && pos.length >= 3) {
          let cum = 0, peakCum = 0
          for (const p of pos) {
            cum += parseFloat(String(p.pnl_usd || 0))
            if (cum > peakCum) peakCum = cum
            if (peakCum > 0) { const dd = ((peakCum - cum) / peakCum) * 100; if (dd > maxDD) maxDD = dd }
          }
        }
      }

      if (maxDD > 0 && maxDD <= 100) {
        const mdd = Math.round(maxDD * 100) / 100
        await supabase.from('trader_snapshots_v2').update({ max_drawdown: mdd }).eq('platform', t.platform).eq('trader_key', t.trader_key).is('max_drawdown', null)
        await supabase.from('trader_snapshots').update({ max_drawdown: mdd }).eq('source', t.platform).eq('source_trader_id', t.trader_key).is('max_drawdown', null)
        mddDone++
      }
    }))
    if ((i + 10) % 100 === 0) process.stdout.write(`\r  max_drawdown: ${mddDone} (${i+10}/${mddTraders.length})`)
  }
  console.log(`\n  max_drawdown computed: ${mddDone}`)

  // 5. Sharpe from equity_curve roi_pct series
  const { data: nullSh } = await supabase.from('trader_snapshots_v2').select('platform, trader_key').is('sharpe_ratio', null).limit(5000)
  const shTraders = [...new Map(nullSh?.map(r => [`${r.platform}:${r.trader_key}`, r]) || []).values()]
  console.log(`${shTraders.length} traders need sharpe_ratio`)
  
  let shDone = 0
  for (let i = 0; i < shTraders.length; i += 10) {
    const batch = shTraders.slice(i, i + 10)
    await Promise.all(batch.map(async (t) => {
      const { data: ec } = await supabase.from('trader_equity_curve')
        .select('roi_pct').eq('source', t.platform).eq('source_trader_id', t.trader_key)
        .order('data_date', { ascending: true }).limit(500)
      if (!ec || ec.length < 7) return
      // Daily returns from consecutive ROI values
      const returns = []
      for (let j = 1; j < ec.length; j++) {
        const prev = parseFloat(String(ec[j-1].roi_pct || 0))
        const cur = parseFloat(String(ec[j].roi_pct || 0))
        returns.push(cur - prev)
      }
      if (returns.length < 7) return
      const mean = returns.reduce((s, r) => s + r, 0) / returns.length
      const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length)
      if (std === 0) return
      const sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
      if (sharpe < -10 || sharpe > 10) return
      await supabase.from('trader_snapshots_v2').update({ sharpe_ratio: sharpe }).eq('platform', t.platform).eq('trader_key', t.trader_key).is('sharpe_ratio', null)
      await supabase.from('trader_snapshots').update({ sharpe_ratio: sharpe }).eq('source', t.platform).eq('source_trader_id', t.trader_key).is('sharpe_ratio', null)
      shDone++
    }))
    if ((i + 10) % 100 === 0) process.stdout.write(`\r  sharpe: ${shDone} (${i+10}/${shTraders.length})`)
  }
  console.log(`\n  sharpe computed: ${shDone}`)

  // Final report
  const { data: fd } = await supabase.rpc('get_monitoring_freshness_summary')
  if (fd) {
    const tot = fd.reduce((s, r) => s + (r.total || 0), 0)
    const wr = fd.reduce((s, r) => s + (r.win_rate_count || 0), 0)
    const mdd = fd.reduce((s, r) => s + (r.max_drawdown_count || 0), 0)
    console.log(`\nFINAL: win_rate ${wr}/${tot} (${Math.round(wr*100/tot)}%), max_drawdown ${mdd}/${tot} (${Math.round(mdd*100/tot)}%)`)
  }
}
main().catch(console.error)
