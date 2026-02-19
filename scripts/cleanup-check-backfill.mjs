import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const sources = ['gains','gateio','dydx','aevo','phemex','bitfinex','bitget_futures'];
  
  for (const src of sources) {
    // Get all null WR trader IDs from leaderboard_ranks
    let allRows = [];
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from('leaderboard_ranks')
        .select('id, source_trader_id, season_id')
        .eq('source', src).is('win_rate', null)
        .range(from, from + 999);
      if (!data?.length) break;
      allRows.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }
    
    const uniqueIds = [...new Set(allRows.map(r => r.source_trader_id))];
    
    // Check how many have WR in trader_snapshots
    let foundMap = new Map(); // source_trader_id -> { season_id -> { win_rate, trades_count } }
    for (let i = 0; i < uniqueIds.length; i += 50) {
      const batch = uniqueIds.slice(i, i + 50);
      const { data: snaps } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, season_id, win_rate, trades_count')
        .eq('source', src)
        .in('source_trader_id', batch)
        .not('win_rate', 'is', null);
      if (snaps) {
        for (const s of snaps) {
          if (!foundMap.has(s.source_trader_id)) foundMap.set(s.source_trader_id, new Map());
          foundMap.get(s.source_trader_id).set(s.season_id, { win_rate: s.win_rate, trades_count: s.trades_count });
        }
      }
    }
    
    // Count how many rows can be backfilled
    let canBackfill = 0;
    let canBackfillPartial = 0;
    for (const row of allRows) {
      const traderData = foundMap.get(row.source_trader_id);
      if (traderData) {
        if (traderData.has(row.season_id)) canBackfill++;
        else canBackfillPartial++; // Has data for different season
      }
    }
    
    console.log(`${src}: ${allRows.length} null rows, ${uniqueIds.length} unique traders`);
    console.log(`  Exact season match in snapshots: ${canBackfill}`);
    console.log(`  Partial (different season) in snapshots: ${canBackfillPartial}`);
    console.log(`  Traders with snapshot data: ${foundMap.size}`);
    console.log();
  }
}

main().catch(console.error);
