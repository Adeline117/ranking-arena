import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  // Get traders missing max_drawdown
  const seasons = ['7D', '30D', '90D']
  
  for (const season of seasons) {
    console.log(`\n=== ${season} ===`)
    
    // Get traders with NULL max_drawdown
    const { data: missing, error: e1 } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id')
      .eq('season_id', season)
      .is('max_drawdown', null)
      .limit(10000)
    
    if (e1) { console.error(e1); continue }
    console.log(`Missing MDD: ${missing.length}`)
    if (!missing.length) continue

    // Get equity curves for these traders
    let updated = 0
    const batchSize = 100
    
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize)
      const pairs = [...new Set(batch.map(b => `${b.source}|${b.source_trader_id}`))]
      
      for (const pair of pairs) {
        const [source, tid] = pair.split('|')
        const { data: curve } = await supabase
          .from('trader_equity_curve')
          .select('roi_pct')
          .eq('source', source)
          .eq('source_trader_id', tid)
          .eq('period', season)
          .order('data_date', { ascending: true })
        
        if (!curve || curve.length < 2) continue
        
        // Calculate MDD from roi_pct series
        let peak = -Infinity
        let maxDD = 0
        for (const pt of curve) {
          const roi = pt.roi_pct
          if (roi > peak) peak = roi
          const dd = peak - roi
          if (dd > maxDD) maxDD = dd
        }
        
        if (maxDD > 0) {
          const { error } = await supabase
            .from('trader_snapshots')
            .update({ max_drawdown: Math.round(maxDD * 100) / 100 })
            .eq('source', source)
            .eq('source_trader_id', tid)
            .eq('season_id', season)
          
          if (!error) updated++
        }
      }
      
      if ((i + batchSize) % 500 === 0 || i + batchSize >= missing.length) {
        console.log(`  Progress: ${Math.min(i + batchSize, missing.length)}/${missing.length} | updated: ${updated}`)
      }
    }
    console.log(`✅ Updated ${updated}/${missing.length} MDD for ${season}`)
  }

  // Also check period column values
  const { data: periods } = await supabase
    .from('trader_equity_curve')
    .select('period')
    .limit(1000)
  
  const uniquePeriods = [...new Set(periods?.map(p => p.period) || [])]
  console.log(`\nEquity curve period values: ${uniquePeriods.join(', ')}`)
}

main().catch(console.error)
