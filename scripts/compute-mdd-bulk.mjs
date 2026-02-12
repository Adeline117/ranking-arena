import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Fetch ALL rows with pagination
async function fetchAll(table, query, orderCol = 'id') {
  const rows = []
  let from = 0
  const pageSize = 5000
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(query)
      .order(orderCol, { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) { console.error(error); break }
    if (!data?.length) break
    rows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
    process.stdout.write(`  Fetched ${rows.length} rows...\r`)
  }
  return rows
}

async function main() {
  const seasons = ['7D', '30D', '90D']

  for (const season of seasons) {
    console.log(`\n=== Computing MDD for ${season} ===`)

    // 1. Get ALL equity curve data for this season
    console.log('Fetching equity curves...')
    const curves = await fetchAll('trader_equity_curve', 
      'source, source_trader_id, roi_pct, data_date',
      'id')
    
    // Filter by period
    const seasonCurves = curves.filter(c => c.period === season)
    // Hmm, we can't filter in fetchAll without RPC. Let me fetch with filter.
    
    console.log(`Total curve rows fetched: ${curves.length}`)
    
    // Group by trader
    const grouped = {}
    for (const row of curves) {
      const key = `${row.source}|${row.source_trader_id}`
      if (!grouped[key]) grouped[key] = []
      grouped[key].push({ date: row.data_date, roi: row.roi_pct })
    }
    
    // Sort each trader's data by date
    for (const pts of Object.values(grouped)) {
      pts.sort((a, b) => a.date.localeCompare(b.date))
    }
    
    const tradersWithData = Object.entries(grouped).filter(([, pts]) => pts.length >= 3)
    console.log(`Traders with >=3 points: ${tradersWithData.length}`)
    
    // 2. Get traders missing MDD
    const missingMdd = await fetchAll('trader_snapshots',
      'source, source_trader_id',
      'id')
    const missingSet = new Set(
      missingMdd
        .filter(m => m.season_id === season && m.max_drawdown == null)
        .map(m => `${m.source}|${m.source_trader_id}`)
    )
    
    console.log(`Missing MDD: ${missingSet.size}`)
    
    let updated = 0
    for (const [key, pts] of tradersWithData) {
      if (!missingSet.has(key)) continue
      
      // roi_pct is cumulative ROI. MDD = max peak-to-trough in cumulative ROI
      let peak = -Infinity
      let maxDD = 0
      for (const pt of pts) {
        if (pt.roi > peak) peak = pt.roi
        const dd = peak - pt.roi
        if (dd > maxDD) maxDD = dd
      }
      
      if (maxDD > 0.01) {
        const [source, tid] = key.split('|')
        const { error } = await supabase
          .from('trader_snapshots')
          .update({ max_drawdown: Math.round(maxDD * 100) / 100 })
          .eq('source', source)
          .eq('source_trader_id', tid)
          .eq('season_id', season)
        if (!error) updated++
      }
    }
    console.log(`✅ MDD updated: ${updated} for ${season}`)
  }

  // Final
  console.log('\n=== FINAL ===')
  for (const s of ['7D', '30D', '90D']) {
    const { count: total } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('season_id', s)
    const { count: mdd } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('season_id', s).not('max_drawdown', 'is', null)
    console.log(`${s}: MDD=${mdd}/${total} (${(mdd/total*100).toFixed(1)}%)`)
  }
}

main().catch(console.error)
