/**
 * Check trader counts for all periods
 */
import { getSupabaseClient } from './scripts/lib/shared.mjs';

const supabase = getSupabaseClient();

async function checkAllPeriods() {
  const platforms = ['bitmart', 'bingx_spot', 'blofin', 'lbank'];
  const periods = ['7D', '30D', '90D'];
  
  console.log('Trader counts by platform and period:\n');
  
  for (const platform of platforms) {
    console.log(`\n${platform.toUpperCase()}`);
    console.log('-'.repeat(40));
    
    for (const period of periods) {
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id', { count: 'exact', head: false })
        .eq('source', platform)
        .eq('season_id', period);
      
      if (error) {
        console.log(`  ${period}: Error - ${error.message}`);
      } else {
        console.log(`  ${period}: ${data.length} traders`);
      }
    }
  }
}

checkAllPeriods().catch(console.error);
