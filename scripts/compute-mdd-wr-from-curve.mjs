import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  const seasons = ['7D', '30D', '90D']
  
  for (const season of seasons) {
    console.log(`\n=== ${season} ===`)
    
    // Get traders missing MDD that DO have equity curve data (>=3 points)
    const { data: candidates, error } = await supabase.rpc('get_mdd_candidates', { p_season: season })
    
    if (error) {
      // Fallback: do it in app
      console.log('RPC not available, using direct query...')
      
      // Get all equity curves with enough data points, grouped by trader
      const { data: curves, error: ce } = await supabase
        .from('trader_equity_curve')
        .select('source, source_trader_id, roi_pct, data_date')
        .eq('period', season)
        .order('data_date', { ascending: true })
      
      if (ce || !curves) { console.error(ce); continue }
      console.log(`Total equity curve rows for ${season}: ${curves.length}`)
      
      // Group by trader
      const grouped = {}
      for (const row of curves) {
        const key = `${row.source}|${row.source_trader_id}`
        if (!grouped[key]) grouped[key] = []
        grouped[key].push(row.roi_pct)
      }
      
      // Filter to traders with >=3 data points
      const tradersWithData = Object.entries(grouped).filter(([, pts]) => pts.length >= 3)
      console.log(`Traders with >=3 curve points: ${tradersWithData.length}`)
      
      // Get traders missing MDD
      const { data: missingMdd } = await supabase
        .from('trader_snapshots')
        .select('source, source_trader_id')
        .eq('season_id', season)
        .is('max_drawdown', null)
        .limit(20000)
      
      const missingSet = new Set(missingMdd?.map(m => `${m.source}|${m.source_trader_id}`) || [])
      console.log(`Missing MDD in snapshots: ${missingSet.size}`)
      
      let mddUpdated = 0
      for (const [key, rois] of tradersWithData) {
        if (!missingSet.has(key)) continue
        const [source, tid] = key.split('|')
        
        // Calculate MDD
        let peak = -Infinity
        let maxDD = 0
        for (const roi of rois) {
          if (roi > peak) peak = roi
          const dd = peak - roi
          if (dd > maxDD) maxDD = dd
        }
        
        if (maxDD > 0.001) {
          const { error: ue } = await supabase
            .from('trader_snapshots')
            .update({ max_drawdown: Math.round(maxDD * 100) / 100 })
            .eq('source', source)
            .eq('source_trader_id', tid)
            .eq('season_id', season)
          if (!ue) mddUpdated++
        }
      }
      console.log(`✅ MDD updated: ${mddUpdated}`)
      
      // Now win_rate from position history for those missing it
      const { data: missingWr } = await supabase
        .from('trader_snapshots')
        .select('source, source_trader_id')
        .eq('season_id', season)
        .is('win_rate', null)
        .limit(20000)
      
      if (missingWr?.length) {
        console.log(`Missing WR in snapshots: ${missingWr.length}`)
        
        // Get position history grouped by trader
        const { data: positions } = await supabase
          .from('trader_position_history')
          .select('source, source_trader_id, pnl')
          .limit(200000)
        
        if (positions?.length) {
          const posGrouped = {}
          for (const p of positions) {
            const pk = `${p.source}|${p.source_trader_id}`
            if (!posGrouped[pk]) posGrouped[pk] = { wins: 0, total: 0 }
            posGrouped[pk].total++
            if (p.pnl > 0) posGrouped[pk].wins++
          }
          
          const wrMissingSet = new Set(missingWr.map(m => `${m.source}|${m.source_trader_id}`))
          let wrUpdated = 0
          
          for (const [key, stats] of Object.entries(posGrouped)) {
            if (!wrMissingSet.has(key) || stats.total < 3) continue
            const [source, tid] = key.split('|')
            const wr = Math.round((stats.wins / stats.total) * 10000) / 100
            
            const { error: ue } = await supabase
              .from('trader_snapshots')
              .update({ win_rate: wr })
              .eq('source', source)
              .eq('source_trader_id', tid)
              .eq('season_id', season)
            if (!ue) wrUpdated++
          }
          console.log(`✅ WR updated: ${wrUpdated}`)
        }
      }
    }
  }
  
  // Final stats
  console.log('\n=== FINAL COVERAGE ===')
  for (const season of seasons) {
    const { count: total } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('season_id', season)
    const { count: wr } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('season_id', season).not('win_rate', 'is', null)
    const { count: mdd } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('season_id', season).not('max_drawdown', 'is', null)
    console.log(`${season}: total=${total} | WR=${wr} (${(wr/total*100).toFixed(1)}%) | MDD=${mdd} (${(mdd/total*100).toFixed(1)}%)`)
  }
}

main().catch(console.error)
