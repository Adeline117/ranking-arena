import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  console.log('=== Backfill v2 snapshots from leaderboard_ranks ===')
  
  // leaderboard_ranks has computed win_rate and max_drawdown for more traders
  let offset = 0, filled = { wr: 0, mdd: 0, sharpe: 0 }
  
  while (true) {
    const { data: lbRows, error } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, win_rate, max_drawdown, sharpe_ratio')
      .order('arena_score', { ascending: false })
      .range(offset, offset + 999)
    if (error || !lbRows || lbRows.length === 0) break
    
    for (const row of lbRows) {
      if (row.win_rate != null) {
        const { count } = await supabase.from('trader_snapshots_v2')
          .update({ win_rate: row.win_rate })
          .eq('platform', row.source)
          .eq('trader_key', row.source_trader_id)
          .is('win_rate', null)
        if (count && count > 0) filled.wr += count
      }
      if (row.max_drawdown != null) {
        const { count } = await supabase.from('trader_snapshots_v2')
          .update({ max_drawdown: row.max_drawdown })
          .eq('platform', row.source)
          .eq('trader_key', row.source_trader_id)
          .is('max_drawdown', null)
        if (count && count > 0) filled.mdd += count
      }
      if (row.sharpe_ratio != null) {
        const { count } = await supabase.from('trader_snapshots_v2')
          .update({ sharpe_ratio: row.sharpe_ratio })
          .eq('platform', row.source)
          .eq('trader_key', row.source_trader_id)
          .is('sharpe_ratio', null)
        if (count && count > 0) filled.sharpe += count
      }
    }
    
    offset += 1000
    console.log(`  Processed ${offset} leaderboard rows... wr=${filled.wr} mdd=${filled.mdd} sharpe=${filled.sharpe}`)
    if (lbRows.length < 1000) break
  }
  
  console.log(`\nDONE: win_rate=${filled.wr} mdd=${filled.mdd} sharpe=${filled.sharpe} filled from leaderboard_ranks`)
  
  const { data: fd } = await supabase.rpc('get_monitoring_freshness_summary')
  if (fd) {
    const tot = fd.reduce((s, r) => s + (r.total || 0), 0)
    const wr = fd.reduce((s, r) => s + (r.win_rate_count || 0), 0)
    const mdd = fd.reduce((s, r) => s + (r.max_drawdown_count || 0), 0)
    console.log(`FINAL: win_rate ${wr}/${tot} (${Math.round(wr*100/tot)}%), max_drawdown ${mdd}/${tot} (${Math.round(mdd*100/tot)}%)`)
  }
}
main().catch(console.error)
