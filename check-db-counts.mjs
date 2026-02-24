/**
 * Check current trader counts in database
 */
import { getSupabaseClient } from './scripts/lib/shared.mjs';

const supabase = getSupabaseClient();

async function checkCounts() {
  const platforms = ['bitmart', 'bingx_spot', 'blofin', 'lbank'];
  
  console.log('Current trader counts in database (30D):\n');
  console.log('Platform      | Count');
  console.log('-'.repeat(30));
  
  for (const platform of platforms) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id', { count: 'exact', head: false })
      .eq('source', platform)
      .eq('season_id', '30D');
    
    if (error) {
      console.log(`${platform.padEnd(13)} | Error: ${error.message}`);
    } else {
      console.log(`${platform.padEnd(13)} | ${data.length}`);
    }
  }
  
  console.log('\n' + '='.repeat(30));
  console.log('Target: Each platform should have < 200 traders');
  console.log('='.repeat(30));
}

checkCounts().catch(console.error);
