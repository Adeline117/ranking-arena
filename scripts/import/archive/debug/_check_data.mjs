/**
 * Quick data check script
 */
import { getSupabaseClient } from '../lib/shared.mjs'
const supabase = getSupabaseClient()

// Check Bitget Futures
const { data: bf } = await supabase.from('trader_snapshots')
  .select('source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bitget_futures')
  .eq('season_id', '30D')
  .limit(5)
console.log('Bitget Futures samples:', bf)

// Check Aevo
const { data: aevo } = await supabase.from('trader_snapshots')
  .select('source_trader_id, win_rate, max_drawdown')
  .eq('source', 'aevo')
  .eq('season_id', '30D')
  .limit(5)
console.log('Aevo samples:', aevo)

// Count missing win_rate by source
const { data: missing } = await supabase.from('trader_snapshots')
  .select('source')
  .is('win_rate', null)
  .eq('season_id', '30D')

const counts = {}
for (const r of (missing || [])) {
  counts[r.source] = (counts[r.source] || 0) + 1
}
console.log('\nMissing win_rate by source (30D):', counts)
